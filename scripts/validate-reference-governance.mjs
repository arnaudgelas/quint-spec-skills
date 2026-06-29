#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const referencesDir = path.join(repoRoot, 'skills', 'quint-spec', 'references')
const governancePath = path.join(referencesDir, 'REFERENCE-GOVERNANCE.json')

const ALLOWED_FENCE_POLICIES = new Set(['none', 'illustrative', 'executable', 'mixed', 'sketch'])
const ALLOWED_VALIDATION_EXPECTATIONS = new Set(['ci-executable-only', 'manual-all-fences'])

function classifyFencePolicy(content) {
  const regex = /^[ \t]{0,3}```quint(?:\s+([^\n`]+))?\s*$/gm

  let total = 0
  let executable = 0
  let illustrative = 0
  let unlabeled = 0
  let sketch = 0

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
    if (labels.includes('sketch')) {
      sketch++
      continue
    }
    unlabeled++
  }

  if (total === 0) {
    return { policy: 'none', total, executable, illustrative, sketch, unlabeled }
  }
  if (unlabeled > 0) {
    return { policy: 'unlabeled', total, executable, illustrative, sketch, unlabeled }
  }
  if ([executable, illustrative, sketch].filter((count) => count > 0).length > 1) {
    return { policy: 'mixed', total, executable, illustrative, sketch, unlabeled }
  }
  if (executable > 0) {
    return { policy: 'executable', total, executable, illustrative, sketch, unlabeled }
  }
  if (sketch > 0) {
    return { policy: 'sketch', total, executable, illustrative, sketch, unlabeled }
  }
  return { policy: 'illustrative', total, executable, illustrative, sketch, unlabeled }
}

function countSuspiciousTextFences(content) {
  const regex = /^[ \t]{0,3}```text\s*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm
  let count = 0
  let match
  while ((match = regex.exec(content)) !== null) {
    if (/^\s*(module|import|export|action|run|temporal)\b/m.test(match[1])) {
      count++
    }
  }
  return count
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
    const suspiciousTextFences = countSuspiciousTextFences(content)

    if (suspiciousTextFences > 0) {
      issues.push(
        `${fileName}: contains ${suspiciousTextFences} text fence(s) that look like Quint`,
      )
    }

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
