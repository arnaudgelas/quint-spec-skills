#!/usr/bin/env node

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  extractQuintBlocks,
  materializeBlock,
  checkSpecFor,
  runtimeMainModuleName,
  canRunSnippet,
} from './validate-quint-snippets.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index < 0 ? fallback : args[index + 1]
}
const supported = new Set(['--output', '--max-steps'])
for (let index = 0; index < args.length; index += 2) {
  if (!supported.has(args[index]) || !args[index + 1]) {
    throw new Error('Usage: node scripts/verify-quint-snippets.mjs --output <dir> --max-steps <n>')
  }
}
const maxSteps = Number(value('--max-steps', '4'))
if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) throw new Error('Invalid --max-steps')
const output = path.resolve(value('--output', '.tmp-quint-validation/symbolic'))
await mkdir(output, { recursive: true })
const binary = path.join(root, 'node_modules/.bin/quint')
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' })
if (version.status !== 0) throw new Error(version.stderr || 'Quint unavailable')
const java = spawnSync('java', ['-version'], { encoding: 'utf8' })
if (java.status !== 0) throw new Error(java.stderr || 'Java unavailable')
const report = {
  startedAt: new Date().toISOString(),
  quintVersion: version.stdout.trim(),
  javaVersion: java.stderr.trim(),
  backend: 'apalache',
  apalacheVersion: '0.62.1',
  expectedRunnableBlocks: 23,
  maxSteps,
  results: [],
}
const directory = path.join(root, 'skills/quint-spec/references')
let ordinal = 0
for (const name of (await readdir(directory)).filter((name) => name.endsWith('.md')).sort()) {
  const blocks = extractQuintBlocks(await readFile(path.join(directory, name), 'utf8'))
  for (const [index, block] of blocks.entries()) {
    const code = materializeBlock(block, ++ordinal)
    if (!canRunSnippet(code)) continue
    const check = checkSpecFor(block)
    if (!check?.invariants.length)
      throw new Error(`${name}:${index + 1} has no invariant directive`)
    const stem = `${name.replace(/\.md$/, '')}-${index + 1}`
    const file = path.join(output, `${stem}.qnt`)
    await writeFile(file, code)
    const main = check.main ?? runtimeMainModuleName(code)
    if (!main) throw new Error(`${stem} has no main module`)
    const command = [
      'verify',
      file,
      '--backend=apalache',
      '--apalache-version=0.62.1',
      '--main',
      main,
      '--invariant',
      check.invariants.join(','),
      '--max-steps',
      String(maxSteps),
    ]
    console.log(`Checking ${stem} (${main}): ${check.invariants.join(', ')}`)
    const started = Date.now()
    const result = spawnSync(binary, command, { encoding: 'utf8', timeout: 180_000 })
    await writeFile(
      path.join(output, `${stem}.log`),
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
    const row = {
      source: `skills/quint-spec/references/${name}`,
      block: index + 1,
      main,
      invariants: check.invariants,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      passed: result.status === 0 && /\[ok\] No violation found/.test(result.stdout ?? ''),
      elapsedMs: Date.now() - started,
    }
    report.results.push(row)
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(`${row.passed ? 'PASS' : 'FAIL'} ${stem} (${row.elapsedMs}ms)`)
  }
}
report.finishedAt = new Date().toISOString()
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
if (
  report.results.length !== report.expectedRunnableBlocks ||
  report.results.some((result) => !result.passed)
)
  process.exitCode = 1
console.log(
  `${report.results.filter((result) => result.passed).length}/${report.results.length} passed`,
)
