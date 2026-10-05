# Maintenance

## Quint freshness policy

- Keep local references aligned with the upstream Quint CLI manual and npm package metadata.
- Keep Apalache JVM requirements aligned with the bundled release: Quint 0.33.0 defaults to Apalache 0.62.1 and requires Java 21+.
- Avoid pinning static CLI defaults in markdown docs; prefer `quint <command> --help`.
- Keep executable snippets aligned with the pinned Quint tool version.

## Snippet policy

- `\`\`\`quint executable`: standalone snippets that must parse and typecheck in CI.
- `\`\`\`quint illustrative`: examples that must typecheck in CI, with hidden preambles where needed.
- `\`\`\`quint sketch`: partial fragments that reference names defined outside the
  block. Not deep-typechecked -- but still subject to the hard-error gate below.
- Unlabeled `\`\`\`quint` fences are not allowed in CI (`--strict-labels`).

**There are currently ZERO `sketch` fences: all 85 Quint blocks are deep-typechecked
in CI**, and the count is enforced by a floor in the validator (`QUINT_MIN_BLOCKS`)
so a doc edit cannot silently drop coverage. Keep it that way. `sketch` is an escape hatch for a block that genuinely
cannot be made to compile, not a way to skip validation. Check with:

```bash
npm run validate:quint:all:typecheck
```

### Hidden preambles

A snippet that reads well often omits declarations it depends on -- a type alias,
`balances`, `USERS`. Rather than bloat the page or give up on checking it, attach
the declarations in an HTML comment immediately before the fence. Markdown drops
it, the reader never sees it, and the validator compiles the block with it (the
same trick Rust doctests use with `#` lines):

Written as an indented example (the fence line is the usual ` ```quint ` one):

    <!-- quint-preamble
    type Address = str
    var balances: Address -> int
    -->

    ```quint illustrative
    action deposit(a: Address, n: int): bool = all {
      balances' = balances.put(a, n),
    }
    ```

Rules:

- The preamble and check comments must immediately precede the fence, in either order (only whitespace between).
- For a fragment, the preamble is placed **inside** the synthesized wrapper module.
- If the preamble itself declares `module`s, they are emitted **beside** the
  wrapper -- that is how a bare `import Foo.*` snippet gets its dependency.
- Preamble code is real Quint and is compiled. Keep it minimal and correct: a
  sloppy preamble (wrong arity, a parameter named `to`) fails the build, which is
  the point.

## Validation floors (these apply to EVERY block, regardless of label)

- **Hard-error gate**: every fence is parsed and fails the build on `QNT000`,
  `QNT008`, `QNT015`, `QNT101`, `QNT200`, `QNT201`, `QNT202`. `QNT404`/`QNT405`
  are tolerated, because a fragment legitimately references outside names. This
  is what stops syntax errors and builtin-name collisions shipping inside
  `sketch` blocks.
- **val-scope lint**: a `val` bound inside `all {}`/`any {}` scopes over only the
  single comma-separated element it appears in. Referencing it from a later
  element is `QNT404`, or silently resolves to an outer definition. Hoist the
  binding above the `all {`.

### Runtime checks and the vacuity gate

All 23 blocks currently defining `init` and `step` pass the Quint 0.33.0 runtime
gates. A block defining `init` and `step` is executed in `--run` mode. What it asserts
comes from a `quint-check` directive, never from guesswork:

    <!-- quint-check
    main: BankTest
    invariants: noNegativeSupply supplyMatchesBalances
    witnesses: witnessNeverFilled witnessNeverSettled
    maxSteps: 12
    maxSamples: 2000
    -->

- `invariants` must name at least one safety property that **holds**; strict runtime checks reject an empty list instead of accepting the CLI default `true`.
- `witnesses` must be **violated**. A witness names a state the model is supposed
  to be able to reach (`witnessNeverFilled = orders.forall(o => o != Filled)`).
  If it holds, that state is unreachable, the lifecycle is stalled, and every
  invariant on the block is passing **vacuously**. This is not hypothetical: the
  escrow template shipped with `Filled` and `Settled` unreachable because
  `init` seeded balances for `USERS` but not `FILLERS`, and both of its safety
  invariants reported `[ok]` on a protocol that could not execute.
- `maxSteps`/`maxSamples` must be positive safe integers and default to 12/2000. Optional inline `#` comments are allowed. They must be wide enough to
  actually reach the witness state -- too small a budget reports "not violated"
  for a reachable state and turns the gate into the false confidence it exists
  to prevent.
- Under `--strict-labels`, a runnable block with no directive fails the build, so
  new templates cannot silently assert nothing.
- **Advance gate.** Independently of witnesses, every runnable block must actually
  take a step: `quint run` reports `Trace length statistics: max=N`, and `N == 1`
  means only the initial state was reached, so every invariant is vacuously true.
  This is witness-free, so it protects blocks whose author wrote no witnesses --
  which is how the Workflow template deadlocked in state 0 while reporting `[ok]`.
  The usual cause is a `nondet x = S.oneOf()` over a set that is empty at `init`,
  hoisted above an `any {}`: a disabled `nondet` disables every branch beneath it,
  including branches that never use `x`.

## Symbolic verification (Apalache)

The gates above use bounded random simulation. For symbolic bounded checking run
Apalache, which explores all paths to a given depth rather than sampling:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21   # see TOOLCHAIN.md on keg-only JDKs
export PATH="$JAVA_HOME/bin:$PATH"
quint verify <spec>.qnt --main=<Instance> --invariant="a,b" --max-steps=4
```

All 23 runnable blocks passed bounded symbolic checks on Quint 0.33.0 with
Apalache 0.62.1 and Java 21 at `--max-steps=4` on 2026-10-05. The finite temporal
counter also passed all four properties with TLC (four distinct states). See
[the verification record](reports/quint-033-verification.json) and its archived
source/log artifacts. Reproduce the bounded checks with `npm run validate:quint:symbolic`. Apalache is what found the Workflow deadlock -- `quint run` reported `[ok]`
on it because random simulation cannot distinguish "no violation" from "no
transitions". This is NOT wired into CI: it needs a JVM, and the runtime is
sensitive to constant sizes. Run it manually before a release, or after changing
any template's actions or constants.

Verify the gate still bites after changing it: break a model so a witness state
becomes unreachable and confirm the run exits non-zero.

## Governance expectations

- `ci-executable-only`: only `executable` fences run in CI.
- `ci-all-fences`: every quint fence in the file is deep-typechecked in CI.
  A file declaring this must contain **no** `sketch` fences.
- `manual-all-fences`: a human reviewed the non-CI fences. Weakest; prefer the
  two above.

## Dependency policy

- Repository tooling pins `@informalsystems/quint` to an exact version in `package.json`.
- If npm latest moves, bump the pinned package and lockfile before running `upstream:update`.
- User-facing installs pin the tested version exactly, currently `@informalsystems/quint@0.33.0`. Use `--save-exact` when upgrading the repository dependency, then update docs and metadata together after checks pass.
- Weekly drift workflow runs upstream freshness and reference-governance checks, then opens/updates an actionable issue on failures.
- `scripts/quint-upstream-check.mjs` treats command inventory discrepancies as drift unless explicitly allowlisted.

## Commands

```bash
# Validate local invariants only (no network)
node scripts/quint-upstream-check.mjs --offline

# Fetch upstream data and sync generated files
node scripts/quint-upstream-check.mjs --update

# Compare local generated files against upstream (network required)
node scripts/quint-upstream-check.mjs --check

# Validate executable snippets
node scripts/validate-quint-snippets.mjs --strict-labels

# CI type/effect checks across all fences
npm run validate:quint:all:typecheck

# CI invariants, reachability witnesses, and progress across all runnable blocks
npm run validate:quint:runtime

# Validate reference governance declarations
node scripts/validate-reference-governance.mjs
```

## Files maintained by the updater

- `skills/quint-spec/references/UPSTREAM.json`
- `skills/quint-spec/references/TOOLCHAIN.md` (`CLI Command Inventory` block)
- `skills/quint-spec/references/REFERENCE-GOVERNANCE.json`
