import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stableStringify,
  parseLastUpdatedDate,
  parseJdkRecommendation,
  parseCliCommands,
  parseCliCommandsFromHelpText,
  diffCommands,
  assertCommandDiscrepanciesAllowed,
  getSectionBetweenMarkers,
  replaceSectionBetweenMarkers,
} from './quint-upstream-check.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.join(__dirname, 'fixtures')

test('stableStringify sorts keys', () => {
  const obj = { b: 2, a: 1, c: { e: 5, d: 4 } }
  const json = stableStringify(obj)
  const expected = `{
  "a": 1,
  "b": 2,
  "c": {
    "d": 4,
    "e": 5
  }
}
`
  assert.strictEqual(json, expected)
})

test('parseLastUpdatedDate from fixture HTML', () => {
  const html = readFileSync(path.join(fixtureDir, 'quint-cli-page.fixture.html'), 'utf8')
  assert.strictEqual(parseLastUpdatedDate(html), 'October 17, 2025')
})

test('parseJdkRecommendation from fixture HTML', () => {
  const html = readFileSync(path.join(fixtureDir, 'apalache-jvm-page.fixture.html'), 'utf8')
  assert.strictEqual(parseJdkRecommendation(html), '17')
})

test('parseCliCommands from fixture HTML headings', () => {
  const html = readFileSync(path.join(fixtureDir, 'quint-cli-page.fixture.html'), 'utf8')
  assert.deepStrictEqual(parseCliCommands(html), [
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
  ])
})

test('parseCliCommands fallback', () => {
  const html = '<html><body><p>Use quint run and quint verify</p></body></html>'
  assert.deepStrictEqual(parseCliCommands(html), ['run', 'verify'])
})

test('getSectionBetweenMarkers', () => {
  const text = 'prefix <!-- START --> content <!-- END --> suffix'
  assert.strictEqual(getSectionBetweenMarkers(text, '<!-- START -->', '<!-- END -->'), 'content')
})

test('replaceSectionBetweenMarkers', () => {
  const text = 'prefix <!-- START --> old <!-- END --> suffix'
  const result = replaceSectionBetweenMarkers(text, '<!-- START -->', '<!-- END -->', 'new')
  assert.strictEqual(result, `prefix <!-- START -->\nnew\n<!-- END --> suffix`)
})

test('parseCliCommandsFromHelpText', () => {
  const help = `
  Commands:
  quint parse <input>
  quint run <input>
  quint verify <input>
  quint docs <input>
  Options:
  `
  assert.deepStrictEqual(parseCliCommandsFromHelpText(help), ['docs', 'parse', 'run', 'verify'])
})

test('parseCliCommandsFromHelpText ignores descriptive text', () => {
  const help = `
  quint [commands..]

  Commands:
    quint compile <input>    compile a Quint specification into the target
    quint docs <input>       produces documentation

  Options:
      --help       Show help
  `
  assert.deepStrictEqual(parseCliCommandsFromHelpText(help), ['compile', 'docs'])
})

test('diffCommands returns docs-only and cli-only sets', () => {
  const diff = diffCommands(['compile', 'run', 'verify'], ['compile', 'docs', 'run'])
  assert.deepStrictEqual(diff, {
    onlyInDocs: ['verify'],
    onlyInLocalCli: ['docs'],
  })
})

test('assertCommandDiscrepanciesAllowed accepts allowlisted differences', () => {
  assert.doesNotThrow(() =>
    assertCommandDiscrepanciesAllowed({
      onlyInDocs: ['indent', 'lint'],
      onlyInLocalCli: ['docs'],
    }),
  )
})

test('assertCommandDiscrepanciesAllowed rejects non-allowlisted differences', () => {
  assert.throws(
    () =>
      assertCommandDiscrepanciesAllowed({
        onlyInDocs: ['unknown'],
        onlyInLocalCli: [],
      }),
    /Unexpected Quint command discrepancies detected\./,
  )
})
