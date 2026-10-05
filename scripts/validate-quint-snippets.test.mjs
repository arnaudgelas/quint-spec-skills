import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Exercise the real CLI boundary in a tiny isolated repository. No test fixture
// fences can alter the production scanner's coverage floor or run inventory.
async function validate(markdown, flags = ['--all', '--typecheck', '--strict-labels'], fakeCli) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quint-validator-test-'))
  try {
    await mkdir(path.join(root, 'scripts'))
    const script = path.join(root, 'scripts', 'validate-quint-snippets.mjs')
    await copyFile(path.join(repoRoot, 'scripts', 'validate-quint-snippets.mjs'), script)
    await writeFile(path.join(root, 'fixture.md'), markdown)
    if (fakeCli) {
      await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true })
      await writeFile(path.join(root, 'node_modules', '.bin', 'quint'), fakeCli, { mode: 0o755 })
    } else {
      await symlink(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir')
    }
    const result = spawnSync(process.execPath, [script, ...flags], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        QUINT_MIN_BLOCKS: '1',
        QUINT_TEST_LOG: path.join(root, 'calls.jsonl'),
      },
    })
    return {
      ...result,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      calls: fakeCli
        ? (await readFile(path.join(root, 'calls.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map(JSON.parse)
        : [],
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const fence = (code, label = 'illustrative') => `\`\`\`quint ${label}\n${code}\n\`\`\`\n`
const directive = (fields = '') => `<!-- quint-check
main: Counter
invariants: safe
witnesses: neverAdvanced
${fields}
-->\n`
const counter = (step = "x' = x + 1", witness = 'x < 1') => `module Counter {
  var x: int
  action init = x' = 0
  action step = ${step}
  val safe = x >= 0
  val neverAdvanced = ${witness}
}`
const runtimeFlags = ['--run', '--all', '--strict-labels']

for (const [name, markdown] of [
  ['unterminated', '```quint illustrative\nval x = 1\n'],
  ['malformed info', '```quint illustrative`\nval x = 1\n```\n'],
]) {
  test(`${name} Quint fence fails the anti-escape gate`, async () => {
    const result = await validate(markdown)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /Fence escape/)
  })
}

test('tilde, long, blockquote, and up-to-three-space fences are checked', async () => {
  const result = await validate(
    '~~~quint illustrative\nval a = 1\n~~~\n' +
      '````quint illustrative\nval b = 2\n`````\n' +
      '> ```quint illustrative\n> val c = 3\n> ```\n' +
      '   ```quint illustrative\nval d = 4\n   ```\n',
  )
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Checked blocks: 4/)
})

test('fragment declarations and whole module preambles compile with their fences', async () => {
  const result = await validate(
    '<!-- quint-preamble\ntype Address = str\n-->\n' +
      fence('pure def identity(a: Address): Address = a') +
      '<!-- quint-preamble\nmodule Dependency { pure val number = 4 }\n-->\n' +
      fence('import Dependency.*\npure val doubled = number * 2') +
      '<!-- quint-preamble\nmodule Other { pure val value = 7 }\n-->\n' +
      fence('module Consumer { import Other.*\npure val copied = value }'),
  )
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Checked blocks: 3/)
})

test('invalid preamble fails even on a sketch exempted from typechecking', async () => {
  const result = await validate(
    '<!-- quint-preamble\nval fail = 1\n-->\n' + fence('val y = 2', 'sketch'),
  )
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /Hard error.*QNT101/)
})

test('scope leak in a hidden preamble fails the all-fence lint', async () => {
  const result = await validate(
    '<!-- quint-preamble\nval guard = all { val local = 1; local > 0, local > 0 }\n-->\n' +
      fence('val y = 2', 'sketch'),
  )
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /val-scope leak/)
})

test('a state-zero deadlock fails the advance gate', async () => {
  const result = await validate(
    directive('maxSamples: 5') + fence(counter("all { x < 0, x' = x + 1 }")),
    runtimeFlags,
  )
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /no `step` transition is ever enabled/)
})

test('an advancing model with an unreachable witness fails the witness gate', async () => {
  const result = await validate(
    directive('maxSamples: 5') + fence(counter("x' = x + 1", 'x != -1')),
    runtimeFlags,
  )
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /witness `neverAdvanced` was NOT violated/)
  assert.match(result.output, /Stalled models \(max trace length 1\): 0/)
})

test('reachable witness succeeds with directives in either order', async () => {
  for (const comments of [
    '<!-- quint-preamble\nmodule Dependency { pure val limit = 1 }\n-->\n' +
      directive('maxSamples: 5'),
    directive('maxSamples: 5') +
      '<!-- quint-preamble\nmodule Dependency { pure val limit = 1 }\n-->\n',
  ]) {
    const result = await validate(comments + fence(counter()), runtimeFlags)
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /Vacuous witnesses: 0/)
  }
})

test('per-block budgets, including documented inline comments, reach invariants and witnesses', async () => {
  const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.QUINT_TEST_LOG, JSON.stringify(args) + '\\n')
if (args[0] !== 'run') process.exit(0)
if (args.includes('neverAdvanced')) {
  console.log('[violation] Invariant violated')
  process.exit(1)
}
console.log('[ok] No violation found. Trace length statistics: max=3')
`
  const result = await validate(
    directive('maxSteps: 17 # optional\nmaxSamples: 29 # optional') + fence(counter()),
    runtimeFlags,
    fakeCli,
  )
  assert.equal(result.status, 0, result.output)
  const runs = result.calls.filter((args) => args[0] === 'run')
  assert.equal(runs.length, 2)
  assert.ok(runs.some((args) => args.includes('safe')))
  assert.ok(runs.some((args) => args.includes('neverAdvanced')))
  for (const args of runs) {
    assert.equal(args[args.indexOf('--max-steps') + 1], '17')
    assert.equal(args[args.indexOf('--max-samples') + 1], '29')
  }
})

test('malformed search budgets fail instead of silently using defaults', async () => {
  for (const value of ['0', '-1', '1.5', 'Infinity', 'not-a-number']) {
    const result = await validate(directive(`maxSteps: ${value}`) + fence(counter()), runtimeFlags)
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /maxSteps must be a positive safe integer/)
  }
})

test('runnable models without explicit checks or witnesses fail strict runtime mode', async () => {
  const noCheck = await validate(fence(counter()), runtimeFlags)
  assert.equal(noCheck.status, 1, noCheck.output)
  assert.match(noCheck.output, /runnable block\(s\) assert nothing/)
  const noWitness = await validate(
    '<!-- quint-check\nmain: Counter\ninvariants: safe\nmaxSamples: 5\n-->\n' + fence(counter()),
    runtimeFlags,
  )
  assert.equal(noWitness.status, 1, noWitness.output)
  assert.match(noWitness.output, /no reachability witness/)
})

test('an empty invariants field cannot swallow the next directive or default to true', async () => {
  const result = await validate(
    '<!-- quint-check\nmain: Counter\ninvariants:\nwitnesses: neverAdvanced\nmaxSamples: 5\n-->\n' +
      fence(counter()),
    runtimeFlags,
  )
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /runnable block\(s\) name no safety invariant/)
})
