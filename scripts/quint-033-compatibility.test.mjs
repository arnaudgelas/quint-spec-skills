import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binary = path.join(root, 'node_modules/.bin/quint')

async function fixture(code, check) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'quint-033-compat-'))
  const file = path.join(directory, 'compat.qnt')
  await writeFile(file, code + '\n')
  try {
    await check(file, directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
function quint(args) {
  return spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000 })
}
function passes(result) {
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
}

test('qualified imports preserve names starting with the alias', async () => {
  await fixture(
    `module Accounts { pure val Credits = 7 }
module compat {
  import Accounts as C
  var balance: int
  action init = balance' = C::Credits
  action step = balance' = balance
  val correct = balance == 7
}`,
    async (file) => {
      passes(quint(['compile', file, '--main=compat', '--target=json']))
      for (const backend of ['rust', 'typescript']) {
        passes(
          quint([
            'run',
            file,
            '--main=compat',
            `--backend=${backend}`,
            '--invariant=correct',
            '--max-steps=2',
            '--max-samples=2',
          ]),
        )
      }
    },
  )
})

test('assignment to instance state evaluates its RHS in the caller on both backends', async () => {
  await fixture(
    `module instanceState { const n: int
  var x: int }
module compat {
  import instanceState(n = 1) as I
  var y: int
  action init = all { I::x' = 0, y' = 7 }
  action step = all { I::x' = y, y' = y }
  val correct = I::x == 0 or I::x == 7
  run copyFromCallerTest = init.then(step).expect(I::x == y and y == 7)
}`,
    async (file) => {
      for (const backend of ['rust', 'typescript']) {
        passes(quint(['test', file, '--main=compat', `--backend=${backend}`]))
      }
    },
  )
})

test('JSON compilation accepts a module with no init or step', async () => {
  await fixture('module compat { pure val answer = 42 }', async (file) => {
    passes(quint(['compile', file, '--main=compat', '--target=json', '--flatten=false']))
  })
})

test('Boolean conjunction cannot combine assignments in an action', async () => {
  await fixture(
    `module compat { var x: int
  action init = x' = 0
  action step = x >= 0 and x' = 1
}`,
    async (file) => {
      const result = quint(['typecheck', file])
      assert.notEqual(result.status, 0, result.stdout)
      assert.match(`${result.stdout}${result.stderr}`, /QNT200/)
      assert.match(`${result.stdout}${result.stderr}`, /only allowed in temporal definitions/)
    },
  )
})

test('MBT traces reset initial metadata and associate picks with destination states', async () => {
  await fixture(
    `module compat {
  var n: int
  action init = n' = 0
  action incBy(z: int): bool = all { n + z <= 2, n' = n + z }
  action step = { nondet z = 1.to(2).oneOf() any { incBy(z) } }
  val nonnegative = n >= 0
}`,
    async (file, directory) => {
      passes(
        quint([
          'run',
          file,
          '--main=compat',
          '--backend=rust',
          '--mbt',
          '--seed=0x42',
          '--max-steps=5',
          '--max-samples=20',
          '--n-traces=20',
          '--invariant=nonnegative',
          '--out-itf',
          path.join(directory, 'trace_{seq}.itf.json'),
        ]),
      )
      const traces = (await readdir(directory)).filter((name) => name.endsWith('.itf.json'))
      assert.equal(traces.length, 20)
      for (const name of traces) {
        const trace = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
        assert.ok(trace.states.length > 1, 'Each trace must exercise incBy')
        const initial = trace.states[0]
        assert.equal(initial['mbt::actionTaken'], 'init')
        assert.equal(initial['mbt::nondetPicks'].z.tag, 'None')
        for (const pick of Object.values(initial['mbt::nondetPicks'])) {
          assert.equal(pick.tag, 'None')
        }
        for (let index = 1; index < trace.states.length; index++) {
          const state = trace.states[index]
          assert.equal(state['mbt::actionTaken'], 'incBy')
          const picked = state['mbt::nondetPicks'].z
          assert.equal(picked.tag, 'Some')
          assert.equal(
            Number(state.n['#bigint']) - Number(trace.states[index - 1].n['#bigint']),
            Number(picked.value['#bigint']),
          )
        }
      }
    },
  )
})
