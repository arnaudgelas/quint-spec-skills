#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const referencesDir = path.join(repoRoot, 'skills', 'quint-spec', 'references')
const governancePath = path.join(referencesDir, 'REFERENCE-GOVERNANCE.json')

const ALLOWED_FENCE_POLICIES = new Set(['none', 'illustrative', 'executable', 'mixed'])
const ALLOWED_VALIDATION_EXPECTATIONS = new Set(['ci-executable-only', 'manual-all-fences'])

function classifyFencePolicy(content) {
  const regex = /^```quint(?:\s+([^\n`]+))?\s*$/gm

  let total = 0
  let executable = 0
  let illustrative = 0
  let unlabeled = 0

  let match
  while ((match = regex.exec(content)) !== null) {
    total++
    const labels = (match[1] ?? '')
      .split(/\s+/)
      .map((label) => label.trim().toLowerCase())
      .filter(Boolean)

    if (labels.includes('executable')) {
      executable++
      continue
    }
    if (labels.includes('illustrative')) {
      illustrative++
      continue
    }
    unlabeled++
  }

  if (total === 0) {
    return { policy: 'none', total, executable, illustrative, unlabeled }
  }
  if (unlabeled > 0) {
    return { policy: 'unlabeled', total, executable, illustrative, unlabeled }
  }
  if (executable > 0 && illustrative > 0) {
    return { policy: 'mixed', total, executable, illustrative, unlabeled }
  }
  if (executable > 0) {
    return { policy: 'executable', total, executable, illustrative, unlabeled }
  }
  return { policy: 'illustrative', total, executable, illustrative, unlabeled }
}

async function main() {
  const issues = []

  const [governanceRaw, entries] = await Promise.all([
    readFile(governancePath, 'utf8'),
    readdir(referencesDir, { withFileTypes: true }),
  ])

  const governance = JSON.parse(governanceRaw)
  const declaredFiles = governance?.files ?? {}

  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()

  const declaredFileNames = Object.keys(declaredFiles).sort()

  for (const fileName of markdownFiles) {
    if (!declaredFiles[fileName]) {
      issues.push(`Missing governance entry for ${fileName}`)
      continue
    }

    const declaration = declaredFiles[fileName]
    const fencePolicy = declaration.quintFencePolicy
    const validationExpectation = declaration.validationExpectation

    if (!ALLOWED_FENCE_POLICIES.has(fencePolicy)) {
      issues.push(`${fileName}: invalid quintFencePolicy '${fencePolicy}'`)
      continue
    }

    if (!ALLOWED_VALIDATION_EXPECTATIONS.has(validationExpectation)) {
      issues.push(`${fileName}: invalid validationExpectation '${validationExpectation}'`)
    }

    const content = await readFile(path.join(referencesDir, fileName), 'utf8')
    const observed = classifyFencePolicy(content)

    if (observed.policy === 'unlabeled') {
      issues.push(`${fileName}: contains unlabeled quint fences`)
      continue
    }

    if (observed.policy !== fencePolicy) {
      issues.push(
        `${fileName}: declared quintFencePolicy='${fencePolicy}' but observed '${observed.policy}'`,
      )
    }

    if (fencePolicy === 'executable' && validationExpectation !== 'ci-executable-only') {
      issues.push(
        `${fileName}: executable policy should use validationExpectation='ci-executable-only'`,
      )
    }
  }

  for (const fileName of declaredFileNames) {
    if (!markdownFiles.includes(fileName)) {
      issues.push(`Governance entry exists for missing file ${fileName}`)
    }
  }

  if (issues.length > 0) {
    console.error('Reference governance validation failed:')
    for (const issue of issues) {
      console.error(`- ${issue}`)
    }
    process.exit(1)
  }

  console.log(`Reference governance validation passed for ${markdownFiles.length} files.`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
