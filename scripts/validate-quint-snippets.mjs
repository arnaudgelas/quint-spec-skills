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
const includeIllustrative = args.has('--include-illustrative')
const includeUnlabeled = args.has('--include-unlabeled')
const includeAll = args.has('--all')
const strictLabels = args.has('--strict-labels')
const typecheck = args.has('--typecheck')
const runExecutable = args.has('--run')
const allowedLabels = new Set(['executable', 'illustrative', 'sketch'])

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
      '',
      'Fence labels:',
      '  ```quint executable    # validated in default mode',
      '  ```quint illustrative  # validated only with --include-illustrative or --all',
      '  ```quint sketch        # partial Quint, counted but not validated',
      '  ```quint               # treated as unlabeled',
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
    if (/^\s*(module|import|export|action|run|temporal)\b/m.test(code)) {
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
  })
}

function runQuintRuntime(filePath, mainModule) {
  return spawnSync(
    quintBin,
    ['run', filePath, '--main', mainModule, '--max-samples', '1', '--max-steps', '3'],
    {
      encoding: 'utf8',
    },
  )
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

        // Wrap in a dummy module if it doesn't look like one
        let quintCode = block.code
        if (!block.code.trim().startsWith('module ')) {
          quintCode = `module ValidationBlock${checkedBlocks + 1} {\n${block.code}\n}`
        }

        if (!shouldValidate(block.kind) || (runExecutable && !canRunSnippet(quintCode))) {
          continue
        }

        checkedBlocks++
        const fileName = `block_${checkedBlocks}.qnt`
        const filePath = path.join(tmpDir, fileName)
        await writeFile(filePath, quintCode)

        const result = runExecutable
          ? runQuintRuntime(filePath, runtimeMainModuleName(quintCode))
          : runQuintValidation(filePath)
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
