#!/usr/bin/env node

import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const tmpDirPrefix = path.join(os.tmpdir(), 'quint-validation-')
const quintBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'quint.cmd' : 'quint',
)

const args = new Set(process.argv.slice(2))
const KNOWN_FLAGS = new Set([
  '--include-illustrative',
  '--include-unlabeled',
  '--all',
  '--strict-labels',
  '--typecheck',
  '--run',
  '--no-hard-error-gate',
  '--help',
])
const unknownFlags = [...args].filter((flag) => !KNOWN_FLAGS.has(flag))
if (unknownFlags.length > 0) {
  console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`)
  console.error(`Known flags: ${[...KNOWN_FLAGS].join(', ')}`)
  process.exit(2)
}

const includeIllustrative = args.has('--include-illustrative')
const includeUnlabeled = args.has('--include-unlabeled')
const includeAll = args.has('--all')
const strictLabels = args.has('--strict-labels')
const typecheck = args.has('--typecheck')
const runExecutable = args.has('--run')
const hardErrorGate = !args.has('--no-hard-error-gate')
const allowedLabels = new Set(['executable', 'illustrative', 'sketch'])

// Subprocess wall-clock limit. A pathological snippet must not hang CI.
const QUINT_TIMEOUT_MS = 60_000

// Error classes that CANNOT be caused by a snippet being an out-of-context
// fragment. QNT404 (name not found) and QNT405 (module not found) are the
// legitimate fragment errors and are therefore excluded -- everything below is
// a genuine defect in the snippet itself, so it is gated on EVERY block,
// including `sketch`.
//
//   QNT000  syntax error / failed unification
//   QNT008  reserved keyword used as identifier
//   QNT015  Map[K,V] instead of K -> V
//   QNT101  built-in name redefined (e.g. `fail`, `to`, `head`)
//   QNT200  `pure def` reads a state variable
//   QNT201  effect/mode error
//   QNT202  multiple updates of the same variable
const HARD_ERROR_CODES = ['QNT000', 'QNT008', 'QNT015', 'QNT101', 'QNT200', 'QNT201', 'QNT202']
const HARD_ERROR_REGEX = new RegExp(`\\[(${HARD_ERROR_CODES.join('|')})\\]`, 'g')

if (args.has('--help')) {
  console.log(
    [
      'Usage:',
      '  node scripts/validate-quint-snippets.mjs',
      '  node scripts/validate-quint-snippets.mjs --all',
      '  node scripts/validate-quint-snippets.mjs --include-illustrative',
      '  node scripts/validate-quint-snippets.mjs --include-unlabeled',
      '  node scripts/validate-quint-snippets.mjs --strict-labels',
      '  node scripts/validate-quint-snippets.mjs --typecheck',
      '  node scripts/validate-quint-snippets.mjs --run',
      '  node scripts/validate-quint-snippets.mjs --no-hard-error-gate',
      '',
      'Fence labels:',
      '  ```quint executable    # validated in default mode',
      '  ```quint illustrative  # validated only with --include-illustrative or --all',
      '  ```quint sketch        # partial Quint, counted but not label-validated',
      '  ```quint               # treated as unlabeled',
      '',
      'Hard-error gate (on by default, disable with --no-hard-error-gate):',
      `  Every block -- including 'sketch' -- is parsed, and these error classes fail the`,
      `  build regardless of label: ${HARD_ERROR_CODES.join(', ')}.`,
      '  QNT404/QNT405 are tolerated because fragments legitimately reference outside names.',
      '',
      'Runtime mode (--run): a block with init+step is executed against the',
      'invariants named in its <!-- quint-check --> directive:',
      '',
      '  <!-- quint-check',
      '  main: BankTest',
      '  invariants: noNegativeSupply supplyMatchesBalances',
      '  witnesses: witnessNeverFilled witnessNeverSettled',
      '  maxSteps: 12          # optional, default 12',
      '  maxSamples: 2000      # optional, default 2000',
      '  -->',
      '',
      'Invariants must HOLD. Witnesses must be VIOLATED -- a witness that holds',
      "means its state is unreachable and the block's invariants are vacuous.",
      'With --strict-labels, a runnable block with no directive fails the build.',
    ].join('\n'),
  )
  process.exit(0)
}

async function getMarkdownFiles() {
  const files = []
  const ignoredDirs = new Set(['.git', 'node_modules'])

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) {
        continue
      }

      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }

      if (entry.name.endsWith('.md')) {
        files.push(fullPath)
      }
    }
  }

  await walk(repoRoot)
  return files
}

// Hidden preamble support.
//
// A `sketch` fence is usually only a fragment because it references names that
// live elsewhere in the document's narrative -- `balances`, `USERS`, a type
// alias. Those blocks are perfectly checkable if the missing declarations are
// supplied, but writing them into the fence would bloat the page an agent reads.
//
// So declarations can be attached in an HTML comment immediately before the
// fence. Markdown renderers drop it, the reader never sees it, and the validator
// compiles the block WITH it -- the same trick Rust doctests use with `#` lines.
//
//   <!-- quint-preamble
//   type Address = str
//   var balances: Address -> int
//   -->
//   ```quint sketch
//   action deposit(a: Address, n: int): bool = all { ... }
//   ```
//
// The preamble is placed inside the synthesized wrapper module for a fragment,
// or verbatim BEFORE the code for a block that declares its own module(s) --
// which is how a snippet that does `import BankModule.*` gets its dependency.
// Directives attach to a fence as HTML comments immediately preceding it. A
// fence may carry both, in either order:
//
//   <!-- quint-preamble ... -->        declarations compiled with the block
//   <!-- quint-check
//   main: BankTest
//   invariants: noNegativeSupply supplyMatchesBalances
//   witnesses: witnessNeverFilled witnessNeverSettled
//   -->
//
// `invariants` must HOLD. `witnesses` must be VIOLATED -- a witness that holds
// means the state it describes is unreachable, so every invariant on that block
// is passing vacuously. That is the failure mode this skill exists to warn
// about, so CI enforces it rather than trusting the author.
function directivesFor(content, fenceStartIndex) {
  const result = { preamble: '', check: null }
  let before = content.slice(0, fenceStartIndex)

  // Walk backwards over a run of comments separated only by whitespace.
  for (;;) {
    const trimmed = before.replace(/\s+$/, '')
    if (!trimmed.endsWith('-->')) break
    const open = trimmed.lastIndexOf('<!--')
    if (open < 0) break
    const body = trimmed.slice(open + 4, trimmed.length - 3)
    const marker = body.trimStart().split(/\s|\n/)[0]
    if (marker === 'quint-preamble') {
      result.preamble = body.replace(/^\s*quint-preamble[ \t]*\r?\n?/, '').trimEnd()
    } else if (marker === 'quint-check') {
      const spec = body.replace(/^\s*quint-check[ \t]*\r?\n?/, '')
      const field = (name) => {
        const m = spec.match(new RegExp(`^\\s*${name}:\\s*(.*)$`, 'm'))
        return m ? m[1].trim() : ''
      }
      result.check = {
        main: field('main') || null,
        invariants: field('invariants').split(/\s+/).filter(Boolean),
        witnesses: field('witnesses').split(/\s+/).filter(Boolean),
        maxSteps: Number(field('maxSteps')) || null,
        maxSamples: Number(field('maxSamples')) || null,
      }
    } else {
      break // an unrelated comment ends the run
    }
    before = trimmed.slice(0, open)
  }
  return result
}

function extractQuintBlocks(content) {
  const blocks = []
  const regex = /^[ \t]{0,3}```quint(?:\s+([^\n`]+))?\s*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm
  let match
  while ((match = regex.exec(content)) !== null) {
    const labelRaw = match[1] ?? ''
    const labels = labelRaw
      .split(/\s+/)
      .map((label) => label.trim().toLowerCase())
      .filter(Boolean)

    const unknownLabels = labels.filter((label) => !allowedLabels.has(label))
    if (unknownLabels.length > 0) {
      throw new Error(`Unknown Quint fence label(s): ${unknownLabels.join(', ')}`)
    }
    if (labels.includes('executable') && labels.includes('illustrative')) {
      throw new Error('Quint fence cannot combine executable and illustrative labels')
    }
    if (
      labels.includes('sketch') &&
      (labels.includes('executable') || labels.includes('illustrative'))
    ) {
      throw new Error('Quint fence with sketch label cannot also be executable or illustrative')
    }

    let kind = 'unlabeled'
    if (labels.includes('executable')) kind = 'executable'
    if (labels.includes('illustrative')) kind = 'illustrative'
    if (labels.includes('sketch')) kind = 'sketch'

    blocks.push({
      kind,
      labels,
      code: match[2],
      ...directivesFor(content, match.index),
    })
  }
  return blocks
}

function extractSuspiciousTextBlocks(content) {
  const blocks = []
  const regex = /^[ \t]{0,3}```text\s*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm
  let match
  while ((match = regex.exec(content)) !== null) {
    const code = match[1]
    // Broadened: the original six keywords missed real Quint that starts with a
    // type alias, a pure def/val, a plain val/def, or a nondet binding -- which
    // is how most operator tables and idiom lists begin.
    if (
      /^\s*(module|import|export|action|run|temporal|type|pure\s+def|pure\s+val|val|def|nondet|const|var|assume)\b/m.test(
        code,
      )
    ) {
      blocks.push({ code })
    }
  }
  return blocks
}

function shouldValidate(kind) {
  if (includeAll) return kind !== 'sketch'
  if (kind === 'executable') return true
  if (kind === 'illustrative' && includeIllustrative) return true
  if (kind === 'unlabeled' && includeUnlabeled) return true
  return false
}

function ensureQuintBinary() {
  if (!existsSync(quintBin)) {
    throw new Error(`Missing Quint CLI binary at ${quintBin}. Run 'npm ci' before validate:quint.`)
  }
}

function runQuintValidation(filePath) {
  const subcommand = typecheck ? 'typecheck' : 'parse'
  return spawnSync(quintBin, [subcommand, filePath], {
    encoding: 'utf8',
    timeout: QUINT_TIMEOUT_MS,
  })
}

// Parse-only pass used by the hard-error gate. Deliberately `parse` rather than
// `typecheck`: parsing surfaces every gated code without demanding that an
// out-of-context fragment resolve its external names.
function runQuintParse(filePath) {
  return spawnSync(quintBin, ['parse', filePath], {
    encoding: 'utf8',
    timeout: QUINT_TIMEOUT_MS,
  })
}

// Parameterless top-level `val`s are this repo's invariant convention. Passing
// them to --invariants is what makes runtime mode a real check: without an
// explicit invariant, quint defaults to the literal `true`, so the run can only
// ever catch a crash and never a violated property.
// Which invariants a runnable block asserts, and which witnesses must fail.
// Taken from the block's `quint-check` directive -- never guessed. Deriving the
// list by regex over `val` also picked up let-bindings nested inside actions,
// which are not invariants and made `quint run` fail with QNT404.
function checkSpecFor(block) {
  if (!block.check) return null
  return {
    main: block.check.main,
    invariants: block.check.invariants,
    witnesses: block.check.witnesses,
  }
}

// Search budget. A witness must actually FIND its state, so the default has to
// be wide enough to reach it -- 20 samples x 5 steps silently reports "not
// violated" for anything a few actions deep, which would turn the vacuity gate
// into the very false-confidence it exists to prevent. Blocks needing a deeper
// search set maxSteps/maxSamples in their quint-check directive.
const DEFAULT_MAX_STEPS = 12
const DEFAULT_MAX_SAMPLES = 2000

function runQuintRuntime(filePath, mainModule, invariants, budget = {}) {
  // `--main null` was previously possible: runtimeMainModuleName can return
  // null and Node coerces it to the string "null". Omit the flag instead and
  // let quint infer the module.
  const argv = ['run', filePath]
  if (mainModule) {
    argv.push('--main', mainModule)
  }
  if (invariants.length > 0) {
    argv.push('--invariants', ...invariants)
  }
  argv.push(
    '--max-samples',
    String(budget.maxSamples ?? DEFAULT_MAX_SAMPLES),
    '--max-steps',
    String(budget.maxSteps ?? DEFAULT_MAX_STEPS),
  )
  return spawnSync(quintBin, argv, {
    encoding: 'utf8',
    timeout: QUINT_TIMEOUT_MS,
  })
}

function canRunSnippet(code) {
  return /^\s*action\s+init\b/m.test(code) && /^\s*action\s+step\b/m.test(code)
}

function runtimeMainModuleName(code) {
  const moduleNames = [...code.matchAll(/^\s*module\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)].map(
    (match) => match[1],
  )
  return moduleNames.find((name) => /(?:Test|Tests|Instance)$/.test(name)) ?? moduleNames[0] ?? null
}

// A block "looks like a module" even when it opens with line comments or a
// docstring. The previous `.trim().startsWith('module ')` check missed those and
// wrapped a full module inside `module ValidationBlockN { ... }`, producing a
// bogus syntax error.
function declaresModule(code) {
  const withoutLeadingComments = code
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed !== '' && !trimmed.startsWith('//')
    })
    .join('\n')
  return withoutLeadingComments.trimStart().startsWith('module ')
}

function hardErrorCodesIn(output) {
  if (!output) return []
  return [...new Set((output.match(HARD_ERROR_REGEX) ?? []).map((m) => m.slice(1, -1)))]
}

// --- val-scope leak lint -------------------------------------------------
// `val x = e` inside `all { ... }` / `any { ... }` is a let-expression whose
// body is the remainder of the SINGLE comma-separated element it appears in.
// Referencing the binding from a later element is QNT404 at parse time -- and
// worse, it silently resolves to an outer definition when one shares the name.
// This manifests as QNT404, which the hard-error gate must tolerate for genuine
// fragments, so it needs its own structural check.

// Split a brace-block body into top-level comma-separated elements, ignoring
// commas nested inside (), [], {} or string literals.
function splitTopLevelElements(body) {
  const elements = []
  let current = ''
  let depth = 0
  let inString = false
  for (const ch of body) {
    if (inString) {
      current += ch
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      current += ch
      continue
    }
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      elements.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) elements.push(current)
  return elements
}

// Line comments must be removed before any brace/comma analysis: prose such as
// `// returns { a, b }` or `// don't` otherwise unbalances the scanner and makes
// it swallow the rest of the block. Newlines are preserved so reported line
// numbers stay accurate.
function stripLineComments(code) {
  return code
    .split('\n')
    .map((line) => {
      let inString = false
      for (let i = 0; i < line.length - 1; i++) {
        const ch = line[i]
        if (ch === '"') inString = !inString
        else if (!inString && ch === '/' && line[i + 1] === '/') return line.slice(0, i)
      }
      return line
    })
    .join('\n')
}

function findValScopeLeaks(rawCode) {
  const code = stripLineComments(rawCode)
  const leaks = []
  const regex = /\b(all|any)\s*\{/g
  let match
  while ((match = regex.exec(code)) !== null) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let end = -1
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) continue
    const elements = splitTopLevelElements(code.slice(open + 1, end))
    for (let k = 0; k < elements.length; k++) {
      const bindings = [...elements[k].matchAll(/\bval\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/g)].map(
        (b) => b[1],
      )
      for (const name of bindings) {
        for (let j = k + 1; j < elements.length; j++) {
          if (new RegExp(`\\b${name}\\b`).test(elements[j])) {
            leaks.push({
              name,
              line: code.slice(0, open).split('\n').length,
              usedIn: elements[j].trim().split('\n')[0].slice(0, 70),
            })
            break
          }
        }
      }
    }
  }
  return leaks
}

async function validate() {
  console.log('Validating Quint snippets in markdown files...')
  console.log(`Mode: ${runExecutable ? 'runtime' : typecheck ? 'typecheck' : 'parse'}`)
  ensureQuintBinary()

  const tmpDir = await mkdtemp(tmpDirPrefix)

  const files = await getMarkdownFiles()
  let totalQuintBlocks = 0
  let executableBlocks = 0
  let illustrativeBlocks = 0
  let unlabeledBlocks = 0
  let sketchBlocks = 0
  let checkedBlocks = 0
  let failedBlocks = 0
  let hardErrorBlocks = 0
  let valScopeLeaks = 0
  let vacuousWitnesses = 0
  let runnableWithoutSpec = 0
  let suspiciousTextBlocks = 0

  try {
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      const blocks = extractQuintBlocks(content)
      const textBlocks = extractSuspiciousTextBlocks(content)
      suspiciousTextBlocks += textBlocks.length

      if (blocks.length === 0 && textBlocks.length === 0) {
        continue
      }

      console.log(`Checking ${path.relative(repoRoot, file)} (${blocks.length} blocks)...`)

      for (let i = 0; i < blocks.length; i++) {
        totalQuintBlocks++
        const block = blocks[i]

        if (block.kind === 'executable') executableBlocks++
        if (block.kind === 'illustrative') illustrativeBlocks++
        if (block.kind === 'unlabeled') unlabeledBlocks++
        if (block.kind === 'sketch') sketchBlocks++

        // Wrap in a dummy module if it doesn't look like one, folding in any
        // hidden preamble: inside the wrapper for a fragment, before the code
        // for a block that declares its own modules.
        let quintCode
        if (declaresModule(block.code)) {
          quintCode = block.preamble ? `${block.preamble}\n\n${block.code}` : block.code
        } else if (declaresModule(block.preamble)) {
          // The preamble supplies whole modules (e.g. the module a bare
          // `import Foo.*` fragment depends on). Those must sit BESIDE the
          // wrapper, not inside it -- Quint has no nested modules.
          quintCode = `${block.preamble}\n\nmodule ValidationBlock${totalQuintBlocks} {\n${block.code}\n}`
        } else {
          const body = block.preamble ? `${block.preamble}\n${block.code}` : block.code
          quintCode = `module ValidationBlock${totalQuintBlocks} {\n${body}\n}`
        }

        // ---- val-scope leak lint: runs on EVERY block, including `sketch` ----
        if (hardErrorGate) {
          const leaks = findValScopeLeaks(block.code)
          if (leaks.length > 0) {
            valScopeLeaks += leaks.length
            for (const leak of leaks) {
              console.error(
                `\n❌ val-scope leak in ${path.relative(repoRoot, file)} (block ${i + 1}, label '${block.kind}'): ` +
                  `\`val ${leak.name}\` is bound inside all{}/any{} but referenced in a later element ` +
                  `(\`${leak.usedIn}\`). Hoist the binding above the \`all {\`.`,
              )
            }
          }
        }

        // ---- Hard-error gate: runs on EVERY block, including `sketch` ----
        // This is the only check that sees the ~56% of snippets the label
        // policy exempts, which is where syntax errors and builtin-name
        // collisions were previously shipping undetected.
        // Blocks that shouldValidate() will check are parsed again below, so the
        // gate only needs its own subprocess for blocks nothing else looks at
        // (in practice: `sketch`). Without this the gate doubles the number of
        // quint invocations and roughly doubles wall-clock.
        const willBeValidatedAnyway = shouldValidate(block.kind) && !runExecutable
        if (hardErrorGate && !willBeValidatedAnyway) {
          const gateFile = path.join(tmpDir, `gate_${totalQuintBlocks}.qnt`)
          await writeFile(gateFile, quintCode)
          const gateResult = runQuintParse(gateFile)
          const codes = hardErrorCodesIn(`${gateResult.stderr ?? ''}\n${gateResult.stdout ?? ''}`)
          if (codes.length > 0) {
            hardErrorBlocks++
            console.error(
              `\n❌ Hard error in ${path.relative(repoRoot, file)} (block ${i + 1}, label '${block.kind}'): ${codes.join(', ')}`,
            )
            console.error(gateResult.stderr || gateResult.stdout || '')
          }
        }

        if (
          runExecutable &&
          canRunSnippet(quintCode) &&
          shouldValidate(block.kind) &&
          !block.check
        ) {
          runnableWithoutSpec++
          console.error(
            `\n⚠️  ${path.relative(repoRoot, file)} (block ${i + 1}) defines init+step but has no <!-- quint-check --> directive, so nothing is asserted about it.`,
          )
        }

        if (!shouldValidate(block.kind) || (runExecutable && !canRunSnippet(quintCode))) {
          continue
        }

        checkedBlocks++
        const fileName = `block_${checkedBlocks}.qnt`
        const filePath = path.join(tmpDir, fileName)
        await writeFile(filePath, quintCode)

        const spec = runExecutable ? checkSpecFor(block) : null
        const result = runExecutable
          ? runQuintRuntime(
              filePath,
              spec?.main ?? runtimeMainModuleName(quintCode),
              spec?.invariants ?? [],
              { maxSteps: spec?.maxSteps, maxSamples: spec?.maxSamples },
            )
          : runQuintValidation(filePath)

        // Witness gate: each named witness MUST be violated. A witness that
        // holds means its state is unreachable, so the block's real invariants
        // are passing vacuously -- exactly the failure this skill warns about.
        if (runExecutable && spec) {
          for (const witness of spec.witnesses) {
            const wResult = runQuintRuntime(
              filePath,
              spec.main ?? runtimeMainModuleName(quintCode),
              [witness],
              { maxSteps: spec.maxSteps, maxSamples: spec.maxSamples },
            )
            const out = `${wResult.stdout ?? ''}${wResult.stderr ?? ''}`
            // NOT a substring test for "violation": the success message is
            // "[ok] No violation found", which contains it. Require the
            // bracketed marker AND a non-zero exit.
            const violated = wResult.status !== 0 && /\[violation\]|Invariant violated/.test(out)
            if (wResult.status !== 0 && !violated) {
              // Non-zero for some other reason (compile/runtime error) -- that is
              // a failure of the block, not evidence about the witness.
              failedBlocks++
              console.error(
                `\n❌ Error in ${path.relative(repoRoot, file)} (block ${i + 1}) while checking witness \`${witness}\`:`,
              )
              console.error(wResult.stderr || wResult.stdout || '')
            } else if (!violated) {
              vacuousWitnesses++
              console.error(
                `\n❌ Vacuity in ${path.relative(repoRoot, file)} (block ${i + 1}): witness \`${witness}\` was NOT violated.\n` +
                  `   The state it describes is unreachable, so this block's invariants hold vacuously.`,
              )
            }
          }
        }
        // Blocks validated above skipped the standalone gate parse; apply the
        // gate to the result we already have so coverage stays 100%.
        if (hardErrorGate && willBeValidatedAnyway) {
          const codes = hardErrorCodesIn(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)
          if (codes.length > 0) {
            hardErrorBlocks++
            console.error(
              `\n❌ Hard error in ${path.relative(repoRoot, file)} (block ${i + 1}, label '${block.kind}'): ${codes.join(', ')}`,
            )
          }
        }

        if (result.status !== 0) {
          failedBlocks++
          console.error(`
❌ Error in ${path.relative(repoRoot, file)} (block ${i + 1}):`)
          console.error(result.stderr || result.stdout || 'quint validation failed')
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }

  console.log('')
  console.log(`Total quint blocks: ${totalQuintBlocks}`)
  console.log(`Executable blocks: ${executableBlocks}`)
  console.log(`Illustrative blocks: ${illustrativeBlocks}`)
  console.log(`Sketch blocks: ${sketchBlocks}`)
  console.log(`Unlabeled blocks: ${unlabeledBlocks}`)
  console.log(`Suspicious text blocks: ${suspiciousTextBlocks}`)
  console.log(`Checked blocks: ${checkedBlocks}`)
  if (hardErrorGate) {
    console.log(`Hard-error gate: ${totalQuintBlocks} blocks scanned, ${hardErrorBlocks} failed`)
    console.log(`val-scope leaks: ${valScopeLeaks}`)
  }

  if (runExecutable) {
    console.log(`Runnable blocks without a quint-check directive: ${runnableWithoutSpec}`)
    console.log(`Vacuous witnesses: ${vacuousWitnesses}`)
  }

  if (vacuousWitnesses > 0) {
    console.error(
      `\nValidation failed: ${vacuousWitnesses} witness(es) were not violated. Those states are unreachable and the surrounding invariants are vacuous.`,
    )
    process.exit(1)
  }

  if (runExecutable && strictLabels && runnableWithoutSpec > 0) {
    console.error(
      `\nValidation failed: ${runnableWithoutSpec} runnable block(s) assert nothing. Add a <!-- quint-check --> directive naming the invariants (and witnesses) to check.`,
    )
    process.exit(1)
  }

  if (hardErrorGate && valScopeLeaks > 0) {
    console.error(
      `\nValidation failed: ${valScopeLeaks} val-scope leak(s). A \`val\` inside all{}/any{} scopes over only the single comma-separated element it appears in.`,
    )
    process.exit(1)
  }

  if (hardErrorGate && hardErrorBlocks > 0) {
    console.error(
      `\nValidation failed: ${hardErrorBlocks}/${totalQuintBlocks} blocks contain hard errors (${HARD_ERROR_CODES.join(', ')}).\nThese are defects in the snippet itself, not missing context, and are gated regardless of fence label.`,
    )
    process.exit(1)
  }

  if (strictLabels && suspiciousTextBlocks > 0) {
    console.error(`
Validation failed: found ${suspiciousTextBlocks} text fences that look like Quint. Use 'quint illustrative' or 'quint executable'.`)
    process.exit(1)
  }

  if (strictLabels && unlabeledBlocks > 0) {
    console.error(`
Validation failed: found ${unlabeledBlocks} unlabeled quint fences. Use 'executable' or 'illustrative'.`)
    process.exit(1)
  }

  if (!includeAll && !includeIllustrative && !includeUnlabeled && executableBlocks === 0) {
    console.error(`
Validation failed: no executable quint fences found.`)
    process.exit(1)
  }

  if (failedBlocks > 0) {
    console.error(`
Validation failed: ${failedBlocks}/${checkedBlocks} checked blocks had errors.`)
    process.exit(1)
  } else {
    console.log(`
Validation successful: ${checkedBlocks} checked blocks passed.`)
  }
}

validate().catch((err) => {
  console.error(err)
  process.exit(1)
})
