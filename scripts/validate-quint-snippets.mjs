#!/usr/bin/env node

import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
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
const isDirectEntry = process.argv[1] && realpathSync(process.argv[1]) === __filename
if (isDirectEntry && unknownFlags.length > 0) {
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

if (isDirectEntry && args.has('--help')) {
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
        const m = spec.match(new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, 'm'))
        return m ? m[1].trim() : ''
      }
      const budget = (name) => {
        const raw = field(name).split('#')[0].trim()
        if (!raw) return null
        const value = Number(raw)
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error(`quint-check ${name} must be a positive safe integer, received '${raw}'`)
        }
        return value
      }
      result.check = {
        main: field('main') || null,
        invariants: field('invariants').split(/\s+/).filter(Boolean),
        witnesses: field('witnesses').split(/\s+/).filter(Boolean),
        maxSteps: budget('maxSteps'),
        maxSamples: budget('maxSamples'),
      }
    } else {
      break // an unrelated comment ends the run
    }
    before = trimmed.slice(0, open)
  }
  return result
}

// Every line that OPENS a Quint fence in any CommonMark-legal form. Used as an
// anti-escape audit: if the scanner below extracts fewer blocks than this finds,
// something is escaping every gate, so the build fails rather than quietly
// reporting a smaller "N/N scanned".
// A fence indented 4+ spaces is NOT a fence in CommonMark -- it is literal text
// inside an indented code block (that is how MAINTENANCE.md shows an example of
// the directive syntax). So the extractor keeps CommonMark's 0-3 space rule; the
// audit below counts the same way and reports deeper-indented ones separately as
// informational, never as an escape.
const ANY_QUINT_FENCE = /^[ \t]{0,3}(?:>[ \t]?)*(?:`{3,}|~{3,})[ \t]*quint\b/gim
const DEEP_QUINT_FENCE = /^[ ]{4,}(?:`{3,}|~{3,})[ \t]*quint\b/gim

function countQuintFenceOpeners(content) {
  // Openers only: a closer carries no info string, so requiring `quint` after
  // the ticks already excludes closers.
  return (content.match(ANY_QUINT_FENCE) ?? []).length
}

function countIndentedQuintFences(content) {
  return (content.match(DEEP_QUINT_FENCE) ?? []).length
}

// Hand-rolled scanner rather than one regex. The previous single regex required
// EXACTLY three backticks at indent 0-3 with no blockquote marker, so ~~~quint,
// ````quint, blockquoted and list-indented (4+ space) fences were invisible --
// rendered as Quint to every reader, never seen by any gate. A closer with more
// backticks than the opener also failed to terminate, silently merging two blocks
// into one under the first block's label.
function extractQuintBlocks(content) {
  const blocks = []
  const lines = content.split('\n')
  const OPEN = /^([ \t]{0,3})((?:>[ \t]?)*)(`{3,}|~{3,})[ \t]*quint\b([^\n`]*)$/i

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPEN)
    if (!open) continue
    const [, , quote, fence, info] = open
    const fenceChar = fence[0]
    const fenceLen = fence.length
    const stripQuote = (line) => (quote ? line.replace(/^[ \t]*(?:>[ \t]?)*/, '') : line)
    // Closer: same character, at least as long, nothing after it but whitespace.
    const closer = new RegExp(`^[ \\t]*(?:>[ \\t]?)*\\${fenceChar}{${fenceLen},}[ \\t]*$`)
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (closer.test(lines[j])) {
        end = j
        break
      }
    }
    if (end < 0) continue
    // Trailing newline is load-bearing: quint fails a final-line `//` comment
    // with QNT000 when the file does not end in a newline.
    const code =
      lines
        .slice(i + 1, end)
        .map(stripQuote)
        .join('\n') + '\n'
    const startIndex = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0)
    blocks.push({ raw: { info, code, startIndex } })
    i = end
  }

  return blocks.map(({ raw }) => {
    const match = [null, raw.info.trim() || undefined, raw.code, raw.startIndex]
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

    return {
      kind,
      labels,
      code: match[2],
      ...directivesFor(content, match[3]),
    }
  })
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
    // These were parsed but not forwarded, so the documented per-block budget
    // override silently did nothing and every block ran at the default.
    maxSteps: block.check.maxSteps,
    maxSamples: block.check.maxSamples,
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

function materializeBlock(block, index = 1) {
  let quintCode
  if (declaresModule(block.code)) {
    quintCode = block.preamble ? `${block.preamble}\n\n${block.code}` : block.code
  } else if (declaresModule(block.preamble)) {
    // The preamble supplies whole modules (e.g. the module a bare
    // `import Foo.*` fragment depends on). Those must sit BESIDE the
    // wrapper, not inside it -- Quint has no nested modules.
    quintCode = `${block.preamble}\n\nmodule ValidationBlock${index} {\n${block.code}\n}`
  } else {
    const body = block.preamble ? `${block.preamble}\n${block.code}` : block.code
    quintCode = `module ValidationBlock${index} {\n${body}\n}`
  }
  return quintCode
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
  let blocksWithoutInvariant = 0
  let stalledBlocks = 0
  let blocksWithoutWitness = 0
  let escapedFences = 0
  let indentedFenceNotes = 0
  let suspiciousTextBlocks = 0

  try {
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      const blocks = extractQuintBlocks(content)
      // Anti-escape audit: every Quint fence opener in the file must have been
      // extracted. A fence form the scanner misses is rendered as authoritative
      // Quint to the reader while bypassing every gate, and the summary would
      // still say "N/N scanned" -- a gate satisfied by absence.
      const openers = countQuintFenceOpeners(content)
      if (openers !== blocks.length) {
        escapedFences += Math.abs(openers - blocks.length)
        console.error(
          `\n❌ Fence escape in ${path.relative(repoRoot, file)}: ${openers} quint fence opener(s) present but ${blocks.length} extracted.`,
        )
      }
      indentedFenceNotes += countIndentedQuintFences(content)
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
        const quintCode = materializeBlock(block, totalQuintBlocks)

        // ---- val-scope leak lint: runs on EVERY block, including `sketch` ----
        if (hardErrorGate) {
          const leaks = findValScopeLeaks(quintCode)
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
        // This also checks any sketch fences exempted by the label policy,
        // so syntax errors and builtin-name collisions cannot bypass CI.
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
          block.check &&
          block.check.invariants.length === 0
        ) {
          blocksWithoutInvariant++
          console.error(
            `\n⚠️  ${path.relative(repoRoot, file)} (block ${i + 1}) has a quint-check directive but no invariant, so runtime defaults to true.`,
          )
        }

        if (
          runExecutable &&
          canRunSnippet(quintCode) &&
          shouldValidate(block.kind) &&
          block.check &&
          block.check.witnesses.length === 0
        ) {
          blocksWithoutWitness++
          console.error(
            `\n⚠️  ${path.relative(repoRoot, file)} (block ${i + 1}) declares invariants but no witness, so nothing proves its guarded actions can fire.`,
          )
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

        // Advance gate: the model must actually take a step. `quint run` reports
        // "Trace length statistics: max=N"; N == 1 means only the initial state
        // was ever reached, so every invariant is vacuously true. This catches a
        // stalled model WITHOUT relying on the author having written a witness --
        // the Workflow template deadlocked in state 0 for exactly this reason and
        // still reported [ok], because its witness list was empty.
        if (runExecutable && spec && result.status === 0) {
          const traceMax = `${result.stdout ?? ''}${result.stderr ?? ''}`.match(
            /Trace length statistics: max=(\d+)/,
          )
          if (traceMax && Number(traceMax[1]) <= 1) {
            stalledBlocks++
            console.error(
              `\n❌ Stalled model in ${path.relative(repoRoot, file)} (block ${i + 1}): no \`step\` transition is ever enabled (max trace length 1).\n` +
                `   Every invariant on this block is vacuously true. A common cause is a \`nondet ... .oneOf()\` over a set that is empty at init, hoisted above \`any {}\`, which disables every branch.`,
            )
          }
        }

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
    console.log(`Runnable blocks without an invariant: ${blocksWithoutInvariant}`)
    console.log(`Vacuous witnesses: ${vacuousWitnesses}`)
  }

  if (runExecutable) {
    console.log(`Stalled models (max trace length 1): ${stalledBlocks}`)
  }

  if (runExecutable) {
    console.log(`Runnable blocks without a witness: ${blocksWithoutWitness}`)
  }
  console.log(`Fence escapes: ${escapedFences}`)
  if (indentedFenceNotes > 0) {
    console.log(
      `Indented (4+ space) quint fences, treated as literal text by CommonMark and skipped: ${indentedFenceNotes}`,
    )
  }

  if (escapedFences > 0) {
    console.error(
      `\nValidation failed: ${escapedFences} quint fence(s) were not extracted and therefore bypassed every gate.`,
    )
    process.exit(1)
  }

  // Coverage floor. Without it, a doc edit that drops most blocks still prints
  // "Validation successful" -- the summary counts whatever extraction happened to
  // return and never compares it to what the repo is known to contain.
  const MIN_TOTAL_BLOCKS = Number(process.env.QUINT_MIN_BLOCKS ?? 85)
  if (totalQuintBlocks < MIN_TOTAL_BLOCKS) {
    console.error(
      `\nValidation failed: found ${totalQuintBlocks} quint blocks but expected at least ${MIN_TOTAL_BLOCKS}.\nIf blocks were removed deliberately, lower the floor (QUINT_MIN_BLOCKS or the constant) in the same commit.`,
    )
    process.exit(1)
  }

  if (runExecutable && strictLabels && blocksWithoutInvariant > 0) {
    console.error(
      `\nValidation failed: ${blocksWithoutInvariant} runnable block(s) name no safety invariant. Add an explicit invariants: entry to quint-check.`,
    )
    process.exit(1)
  }

  if (runExecutable && strictLabels && blocksWithoutWitness > 0) {
    console.error(
      `\nValidation failed: ${blocksWithoutWitness} runnable block(s) declare invariants with no reachability witness.\nThe advance gate only proves SOME transition fires; it cannot prove the guarded actions the invariants are about are reachable. Add a \`witnesses:\` entry naming a state that must be reachable.`,
    )
    process.exit(1)
  }

  if (stalledBlocks > 0) {
    console.error(
      `\nValidation failed: ${stalledBlocks} model(s) never leave the initial state, so their invariants are vacuous.`,
    )
    process.exit(1)
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

export { extractQuintBlocks, materializeBlock, checkSpecFor, runtimeMainModuleName, canRunSnippet }

if (isDirectEntry) {
  validate().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
