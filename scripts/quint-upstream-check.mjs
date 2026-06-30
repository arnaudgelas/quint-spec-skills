#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const args = new Set(process.argv.slice(2))
const mode = args.has('--update') ? 'update' : 'check'
const offline = args.has('--offline')

if (args.has('--help')) {
  console.log(
    [
      'Usage:',
      '  node scripts/quint-upstream-check.mjs --check [--offline]',
      '  node scripts/quint-upstream-check.mjs --update',
      '',
      'Exit codes:',
      '  0: success',
      '  1: validation/network/script failure',
      '  2: upstream drift detected (check mode)',
    ].join('\n'),
  )
  process.exit(0)
}

if (mode === 'update' && offline) {
  console.error('--update cannot be combined with --offline')
  process.exit(1)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

const paths = {
  readme: path.join(repoRoot, 'README.md'),
  skill: path.join(repoRoot, 'skills/quint-spec/SKILL.md'),
  toolchain: path.join(repoRoot, 'skills/quint-spec/references/TOOLCHAIN.md'),
  metadata: path.join(repoRoot, 'skills/quint-spec/references/UPSTREAM.json'),
  packageJson: path.join(repoRoot, 'package.json'),
}

const urls = {
  quintCliDocs: 'https://quint.sh/docs/quint',
  quintNpmLatest: 'https://registry.npmjs.org/@informalsystems/quint/latest',
  apalacheJvmDocs: 'https://apalache-mc.org/docs/apalache/installation/jvm.html',
}

const CLI_BLOCK_START = '<!-- BEGIN:CLI_COMMANDS -->'
const CLI_BLOCK_END = '<!-- END:CLI_COMMANDS -->'
const ALLOWED_CLI_DISCREPANCIES = {
  onlyInDocs: new Set(['indent', 'lint']),
  onlyInLocalCli: new Set(['docs']),
}

import * as cheerio from 'cheerio'

function stableStringify(obj) {
  function sortObjectKeys(o) {
    if (typeof o !== 'object' || o === null) return o
    if (Array.isArray(o)) return o.map(sortObjectKeys)
    return Object.keys(o)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortObjectKeys(o[key])
        return acc
      }, {})
  }
  return `${JSON.stringify(sortObjectKeys(obj), null, 2)}\n`
}

function dedupeSort(values) {
  return [...new Set(values)].sort()
}

function parseLastUpdatedDate(html) {
  const $ = cheerio.load(html)
  const text = $('body').text()
  const match = text.match(/Last updated on\s*([A-Za-z]+ \d{1,2}, \d{4})/i)
  return match?.[1] ?? null
}

function parseJdkRecommendation(html) {
  const $ = cheerio.load(html)
  const text = $('body').text()
  const patterns = [
    /recommend(?:ed)?\s+version\s+(\d+)/i,
    /(?:OpenJDK|JDK|Java(?:\s+SE)?)\s+(\d+)\+/i,
    /(?:OpenJDK|JDK|Java(?:\s+SE)?)\s+(\d+)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

function parseCliCommands(html) {
  const $ = cheerio.load(html)
  const commands = new Set()

  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const text = $(el).text().trim()
    const match = text.match(/^Command\s+([a-z][a-z0-9-]*)$/i)
    if (match) {
      commands.add(match[1].toLowerCase())
    }
  })

  if (commands.size > 0) {
    return dedupeSort([...commands])
  }

  const knownCommands = [
    'compile',
    'docs',
    'indent',
    'lint',
    'parse',
    'repl',
    'run',
    'test',
    'typecheck',
    'verify',
  ]
  const fallback = []
  const bodyText = $('body').text()
  for (const command of knownCommands) {
    const re = new RegExp(`\\bquint\\s+${command}\\b`, 'i')
    if (re.test(bodyText)) {
      fallback.push(command)
    }
  }
  return dedupeSort(fallback)
}

function parseCliCommandsFromHelpText(helpText) {
  const lines = helpText.split(/\r?\n/)
  const commands = []
  let inCommandsSection = false

  for (const line of lines) {
    if (/^\s*Commands:\s*$/i.test(line)) {
      inCommandsSection = true
      continue
    }
    if (inCommandsSection && /^\s*Options:\s*$/i.test(line)) {
      break
    }
    if (!inCommandsSection) {
      continue
    }

    const match = line.match(/^\s*quint\s+([a-z][a-z0-9-]*)\b/i)
    if (match) {
      commands.push(match[1].toLowerCase())
    }
  }

  return dedupeSort(commands)
}

function findLocalQuintBin() {
  const binName = process.platform === 'win32' ? 'quint.cmd' : 'quint'
  const localBin = path.join(repoRoot, 'node_modules', '.bin', binName)
  return existsSync(localBin) ? localBin : null
}

function runLocalQuintHelp() {
  const localBin = findLocalQuintBin()
  if (!localBin) {
    return { available: false, commands: [], source: 'unavailable' }
  }

  const result = spawnSync(localBin, ['--help'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    return { available: false, commands: [], source: path.relative(repoRoot, localBin) }
  }

  return {
    available: true,
    commands: parseCliCommandsFromHelpText(result.stdout),
    source: path.relative(repoRoot, localBin),
  }
}

function runLocalQuintVersion() {
  const localBin = findLocalQuintBin()
  if (!localBin) {
    return null
  }

  const result = spawnSync(localBin, ['--version'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    return null
  }

  return result.stdout.trim()
}

async function readPinnedQuintVersion() {
  const packageJson = JSON.parse(await readText(paths.packageJson))
  const version = packageJson?.devDependencies?.['@informalsystems/quint']
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(
      `${paths.packageJson} must pin @informalsystems/quint to an exact x.y.z version`,
    )
  }
  return version
}

function diffCommands(fromDocs, fromCli) {
  const docsSet = new Set(fromDocs)
  const cliSet = new Set(fromCli)

  const onlyInDocs = fromDocs.filter((cmd) => !cliSet.has(cmd))
  const onlyInLocalCli = fromCli.filter((cmd) => !docsSet.has(cmd))

  return {
    onlyInDocs,
    onlyInLocalCli,
  }
}

function assertCommandDiscrepanciesAllowed(discrepancies) {
  const onlyInDocs = discrepancies?.onlyInDocs ?? []
  const onlyInLocalCli = discrepancies?.onlyInLocalCli ?? []

  const unexpectedInDocs = onlyInDocs.filter(
    (cmd) => !ALLOWED_CLI_DISCREPANCIES.onlyInDocs.has(cmd),
  )
  const unexpectedInLocalCli = onlyInLocalCli.filter(
    (cmd) => !ALLOWED_CLI_DISCREPANCIES.onlyInLocalCli.has(cmd),
  )

  if (unexpectedInDocs.length === 0 && unexpectedInLocalCli.length === 0) {
    return
  }

  throw Object.assign(
    new Error(
      [
        'Unexpected Quint command discrepancies detected.',
        unexpectedInDocs.length > 0
          ? `Unexpected only-in-docs: ${unexpectedInDocs.join(', ')}`
          : null,
        unexpectedInLocalCli.length > 0
          ? `Unexpected only-in-local-cli: ${unexpectedInLocalCli.join(', ')}`
          : null,
        'Run: node scripts/quint-upstream-check.mjs --update and review parser assumptions.',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    { code: 2 },
  )
}

function renderCliCommandBlock(commands) {
  return commands.map((command) => `- \`quint ${command}\``).join('\n')
}

function getSectionBetweenMarkers(text, start, end) {
  const startIdx = text.indexOf(start)
  const endIdx = text.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(`Missing or invalid marker block: ${start} ... ${end}`)
  }
  const from = startIdx + start.length
  return text.slice(from, endIdx).trim()
}

function replaceSectionBetweenMarkers(text, start, end, replacement) {
  const startIdx = text.indexOf(start)
  const endIdx = text.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(`Missing or invalid marker block: ${start} ... ${end}`)
  }
  const before = text.slice(0, startIdx + start.length)
  const after = text.slice(endIdx)
  return `${before}\n${replacement}\n${after}`
}

async function fetchText(url) {
  let response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'quint-spec-skill-freshness-checker' },
    })
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`)
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`)
  }
  return response.text()
}

async function fetchSnapshot() {
  const pinnedQuintVersion = await readPinnedQuintVersion()
  const [npmText, cliDocsText, apalacheText] = await Promise.all([
    fetchText(urls.quintNpmLatest),
    fetchText(urls.quintCliDocs),
    fetchText(urls.apalacheJvmDocs),
  ])

  const npmData = JSON.parse(npmText)
  if (npmData.version !== pinnedQuintVersion) {
    throw Object.assign(
      new Error(
        [
          'Pinned Quint package is behind npm latest.',
          `Pinned version: ${pinnedQuintVersion}`,
          `Npm latest:     ${npmData.version}`,
          `Run: npm install --save-dev @informalsystems/quint@${npmData.version}`,
          'Then run: node scripts/quint-upstream-check.mjs --update',
        ].join('\n'),
      ),
      { code: 2 },
    )
  }

  const docsCommands = parseCliCommands(cliDocsText)
  if (docsCommands.length === 0) {
    throw new Error(`Could not parse CLI commands from ${urls.quintCliDocs}`)
  }

  const localCli = runLocalQuintHelp()
  if (!localCli.available || localCli.commands.length === 0) {
    throw new Error('Could not parse command inventory from local Quint CLI (--help output)')
  }
  const localCliCommands = localCli.commands
  const localCliVersion = runLocalQuintVersion()
  if (localCliVersion !== pinnedQuintVersion) {
    throw new Error(
      [
        'Local Quint CLI version does not match package.json.',
        `package.json: ${pinnedQuintVersion}`,
        `local CLI:    ${localCliVersion ?? '<unavailable>'}`,
        'Run: npm ci',
      ].join('\n'),
    )
  }
  const commandDiff = diffCommands(docsCommands, localCliCommands)

  const jdkRecommendation = parseJdkRecommendation(apalacheText)
  if (!jdkRecommendation) {
    throw new Error(`Could not parse JDK recommendation from ${urls.apalacheJvmDocs}`)
  }

  return {
    sources: urls,
    quint: {
      latestVersion: npmData.version,
      pinnedVersion: pinnedQuintVersion,
      localCliVersion,
      cliCommands: localCliCommands,
      cliCommandsImplemented: localCliCommands,
      cliCommandsDocumented: docsCommands,
      cliCommandsDocumentedFuture: commandDiff.onlyInDocs,
      cliCommandsFromDocs: docsCommands,
      cliCommandsFromLocalCli: localCliCommands,
      cliCommandDiscrepancies: commandDiff,
      cliCommandSource: 'local-cli',
      localCliSource: localCli.source,
      cliDocsLastUpdated: parseLastUpdatedDate(cliDocsText),
    },
    apalache: {
      recommendedJdk: jdkRecommendation,
      jvmDocsLastUpdated: parseLastUpdatedDate(apalacheText),
    },
  }
}

function maybeWarnCommandDrift(snapshot) {
  const diff = snapshot.quint.cliCommandDiscrepancies
  if (diff.onlyInDocs.length === 0 && diff.onlyInLocalCli.length === 0) {
    return
  }
  console.warn('Warning: Quint command inventory differs between docs and local CLI.')
  if (diff.onlyInDocs.length > 0) {
    console.warn(`Only in docs: ${diff.onlyInDocs.join(', ')}`)
  }
  if (diff.onlyInLocalCli.length > 0) {
    console.warn(`Only in local CLI: ${diff.onlyInLocalCli.join(', ')}`)
  }
}

async function readText(filePath) {
  return readFile(filePath, 'utf8')
}

async function readMetadata() {
  if (!existsSync(paths.metadata)) {
    throw new Error(`Missing metadata file: ${paths.metadata}`)
  }
  const text = await readText(paths.metadata)
  return JSON.parse(text)
}

async function validateStaticDocs() {
  const [readme, skill, toolchain] = await Promise.all([
    readText(paths.readme),
    readText(paths.skill),
    readText(paths.toolchain),
  ])

  const docsWithCliUrl = [
    [paths.readme, readme],
    [paths.skill, skill],
    [paths.toolchain, toolchain],
  ]

  for (const [filePath, content] of docsWithCliUrl) {
    if (!content.includes(urls.quintCliDocs)) {
      throw new Error(`${filePath} must reference ${urls.quintCliDocs}`)
    }
  }

  const docsWithApalacheUrl = [
    [paths.readme, readme],
    [paths.skill, skill],
    [paths.toolchain, toolchain],
  ]

  for (const [filePath, content] of docsWithApalacheUrl) {
    if (!content.includes(urls.apalacheJvmDocs)) {
      throw new Error(`${filePath} must reference ${urls.apalacheJvmDocs}`)
    }
  }

  // Docs may reference a pinned version or @latest.
  // Version currency is enforced by the upstream drift check (fetchSnapshot),
  // not by policing install-command syntax in prose.

  const commandBlock = getSectionBetweenMarkers(toolchain, CLI_BLOCK_START, CLI_BLOCK_END)
  if (commandBlock.length === 0) {
    throw new Error(`${paths.toolchain} CLI command inventory block is empty`)
  }
}

async function syncFromSnapshot(snapshot) {
  const metadataText = stableStringify(snapshot)
  await writeFile(paths.metadata, metadataText)

  const toolchain = await readText(paths.toolchain)
  const updatedToolchain = replaceSectionBetweenMarkers(
    toolchain,
    CLI_BLOCK_START,
    CLI_BLOCK_END,
    renderCliCommandBlock(snapshot.quint.cliCommands),
  )
  await writeFile(paths.toolchain, updatedToolchain)
}

function assertMetadataMatchesSnapshot(localMetadata, remoteSnapshot) {
  const localJson = stableStringify(localMetadata)
  const remoteJson = stableStringify(remoteSnapshot)
  if (localJson !== remoteJson) {
    const localVersion = localMetadata?.quint?.latestVersion ?? '<missing>'
    const remoteVersion = remoteSnapshot?.quint?.latestVersion ?? '<missing>'
    const changedFields = []
    for (const key of [
      'quint.latestVersion',
      'quint.pinnedVersion',
      'quint.localCliVersion',
      'quint.cliDocsLastUpdated',
      'apalache.recommendedJdk',
      'apalache.jvmDocsLastUpdated',
    ]) {
      const localValue = key.split('.').reduce((acc, part) => acc?.[part], localMetadata)
      const remoteValue = key.split('.').reduce((acc, part) => acc?.[part], remoteSnapshot)
      if (JSON.stringify(localValue) !== JSON.stringify(remoteValue)) {
        changedFields.push(
          `- ${key}: ${JSON.stringify(localValue)} -> ${JSON.stringify(remoteValue)}`,
        )
      }
    }
    throw Object.assign(
      new Error(
        [
          'Upstream drift detected.',
          `Local version:  ${localVersion}`,
          `Remote version: ${remoteVersion}`,
          changedFields.length > 0 ? ['Changed fields:', ...changedFields].join('\n') : null,
          'Run: node scripts/quint-upstream-check.mjs --update',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      { code: 2 },
    )
  }
}

function assertCommandBlockMatchesMetadata(toolchainText, metadata) {
  const expected = renderCliCommandBlock(metadata.quint.cliCommands)
  const actual = getSectionBetweenMarkers(toolchainText, CLI_BLOCK_START, CLI_BLOCK_END)
  if (expected.trim() !== actual.trim()) {
    throw Object.assign(
      new Error(
        [
          `${paths.toolchain} command inventory block is out of sync with ${paths.metadata}.`,
          'Run: node scripts/quint-upstream-check.mjs --update',
        ].join('\n'),
      ),
      { code: 2 },
    )
  }
}

async function main() {
  await validateStaticDocs()

  if (offline) {
    const [metadata, toolchainText] = await Promise.all([readMetadata(), readText(paths.toolchain)])
    assertCommandDiscrepanciesAllowed(metadata?.quint?.cliCommandDiscrepancies)
    assertCommandBlockMatchesMetadata(toolchainText, metadata)
    console.log('Offline freshness checks passed.')
    return
  }

  const snapshot = await fetchSnapshot()
  maybeWarnCommandDrift(snapshot)
  assertCommandDiscrepanciesAllowed(snapshot.quint.cliCommandDiscrepancies)

  if (mode === 'update') {
    await syncFromSnapshot(snapshot)
    console.log(`Updated ${paths.metadata} and synced ${paths.toolchain}.`)
    return
  }

  const [metadata, toolchainText] = await Promise.all([readMetadata(), readText(paths.toolchain)])
  assertMetadataMatchesSnapshot(metadata, snapshot)
  assertCommandBlockMatchesMetadata(toolchainText, metadata)
  console.log('Upstream freshness checks passed.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const exitCode = Number.isInteger(error.code) ? error.code : 1
    console.error(error.message)
    process.exit(exitCode)
  })
}

export {
  stableStringify,
  parseLastUpdatedDate,
  parseJdkRecommendation,
  parseCliCommands,
  parseCliCommandsFromHelpText,
  diffCommands,
  assertCommandDiscrepanciesAllowed,
  getSectionBetweenMarkers,
  replaceSectionBetweenMarkers,
}
