import { test } from 'node:test'
import assert from 'node:assert'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

function runNodeScript(args) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

test('offline freshness check CLI passes end-to-end', () => {
  const result = runNodeScript(['scripts/quint-upstream-check.mjs', '--check', '--offline'])
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Offline freshness checks passed\./)
})

test('strict executable snippet parse validation passes end-to-end', () => {
  const result = runNodeScript(['scripts/validate-quint-snippets.mjs', '--strict-labels'])
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Validation successful:/)
})

test('strict executable snippet typecheck validation passes end-to-end', () => {
  const result = runNodeScript([
    'scripts/validate-quint-snippets.mjs',
    '--strict-labels',
    '--typecheck',
  ])
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Validation successful:/)
})

test('reference governance validation passes end-to-end', () => {
  const result = runNodeScript(['scripts/validate-reference-governance.mjs'])
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /Reference governance validation passed/)
})
