# Quint Toolchain Reference

## Canonical Sources

- Quint CLI manual: https://quint.sh/docs/quint
- Quint npm package: https://registry.npmjs.org/@informalsystems/quint/latest
- Apalache JVM installation: https://apalache-mc.org/docs/apalache/installation/jvm.html

Use this file for high-signal examples. For changing defaults and new flags,
always verify with `quint <command> --help` and the official CLI manual.

## Installation

```bash
# Install latest Quint CLI
npm install -g @informalsystems/quint@latest

# Verify
quint --version
```

For formal verification (`quint verify`), Apalache is required:

- JDK 17+ is recommended in the Apalache JVM docs
- Apalache is automatically invoked by `quint verify`

## CLI Command Inventory (Synced)

<!-- BEGIN:CLI_COMMANDS -->

- `quint compile`
- `quint docs`
- `quint parse`
- `quint repl`
- `quint run`
- `quint test`
- `quint typecheck`
- `quint verify`
<!-- END:CLI_COMMANDS -->

The official CLI manual also documents `quint lint` and `quint indent` as future
commands. The current `0.32.0` CLI does not expose them in `quint --help`, so do
not recommend them as runnable commands until the local CLI confirms them.

## Core Commands

### quint typecheck

Type-check a Quint spec without executing transitions.

```bash
quint typecheck spec.qnt
```

### quint repl

Interactive Read-Evaluate-Print loop for exploring specs.

```bash
quint repl
quint repl --require spec.qnt          # Load spec on startup
quint repl --require spec.qnt --backend=rust
```

**Key flags:** `--seed`, `--backend` (`"typescript"` or `"rust"`), `--require`.  
Since v0.29.0, the REPL displays state diffs after each action.

### quint test

Run named `run` traces.

```bash
quint test spec.qnt
quint test --match=happyPathTest spec.qnt
```

### quint run

Random simulation over the `step` transition relation.

```bash
quint run --invariant=balancesConserved spec.qnt
quint run --invariant=balancesConserved --max-samples=10000 --max-steps=50 spec.qnt
quint run --init=myInit --step=myStep --invariant=myInvariant spec.qnt
```

Use `quint run --help` for current defaults and backend-specific options.
**Backend note:** The v0.31.0 release switched the default for `quint run` and `quint test`
to the Rust backend, but the official CLI docs page still lists `"typescript"` as the default.
The two sources are out of sync. Always specify `--backend=rust` or `--backend=typescript`
explicitly when reproducibility matters.

**Key flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--invariant=<name>` | `"true"` | Invariant expression or definition name to check |
| `--witnesses <n1> <n2>` | `[]` | Space-separated witness names; reports when a satisfying state is found |
| `--max-samples=N` | `10000` | Maximum simulation runs |
| `--max-steps=N` | `20` | Maximum steps per trace |
| `--n-traces=N` | `1` | Number of traces to generate |
| `--seed=<str>` | — | Random seed for reproducible runs |
| `--backend=<name>` | see note | `"rust"` or `"typescript"` |
| `--out-itf=<path>` | — | Write trace to file in Informal Trace Format |
| `--mbt` | `false` | Embed model-based testing metadata in the ITF trace |
| `--hide <v1> <v2>` | `[]` | Variables to hide from trace output |

> **`--witnesses` vs `--invariant` for reachability:**  
> `--witnesses w` reports when a state *satisfying* `w` is found (confirms reachability).  
> `--invariant=w` reports when `w` is *violated* (same result, opposite framing). Both approaches are valid; `--witnesses` is more idiomatic for positive reachability checks.

### quint verify

Bounded exhaustive verification via Apalache, with TLC available for finite-state
explicit-state checking.

```bash
quint verify --invariant=balancesConserved spec.qnt
quint verify --invariant=balancesConserved --max-steps=10 spec.qnt
quint verify --main=BankTest --invariant=supplyConserved spec.qnt
quint verify --backend=tlc --invariant=supplyConserved spec.qnt
```

Use `quint verify --help` for current defaults and backend-specific options. Prefer
Apalache for symbolic bounded checking; use TLC when the model is finite-state and
explicit state enumeration is useful.

**Key flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--invariant=<name>` | — | Invariant to check (comma-separated for multiple) |
| `--inductive-invariant=<name>` | — | **Apalache only.** Proves `I ∧ step ⇒ I'` (inductive invariant). Use when bounded checking is insufficient. |
| `--temporal=<name>` | — | Temporal property to check (comma-separated for multiple) |
| `--max-steps=N` | `10` | Bounded model checking depth (Apalache) |
| `--random-transitions` | `false` | **Apalache only.** Random symbolic simulation |
| `--backend=<name>` | `"apalache"` | `"apalache"` or `"tlc"` |
| `--out-itf=<path>` | — | Write counterexample trace to ITF file (Apalache only) |
| `--apalache-config=<path>` | — | Path to additional Apalache JSON config |
| `--tlc-config=<path>` | — | Path to TLC JSON config file |

**Inductive invariant example:**
```bash
# Prove that myInvariant is inductive (no bounded depth needed)
quint verify --inductive-invariant=myInvariant spec.qnt
```

**Temporal property example:**
```bash
quint verify --temporal=eventuallySettled --max-steps=20 spec.qnt
```

**When to use TLC vs Apalache:**
- **Apalache** (default): symbolic bounded checking; handles unbounded integers; preferred for most specs.
- **TLC**: explicit state enumeration; faster for small finite-state models; use when Apalache times out on tractable finite models.

## Other Useful Commands

```bash
quint parse spec.qnt
quint compile spec.qnt
quint docs spec.qnt
```

## Typical Workflow

```bash
# 1. Type-check
quint typecheck spec.qnt

# 2. Run tests
quint test spec.qnt

# 3. Quick simulation (find obvious bugs)
quint run --invariant=myInvariant --max-samples=1000 spec.qnt

# 4. Verify false-invariant witnesses (confirm model isn't vacuous)
quint run --witnesses=witnessActivity spec.qnt
quint run --invariant=witnessNoActivity spec.qnt
# For the false invariant, expected: violation found

# 5. Thorough simulation
quint run --invariant=myInvariant --max-samples=10000 --max-steps=50 spec.qnt

# 6. Formal verification (requires Apalache + JDK 17+)
quint verify --invariant=myInvariant --max-steps=10 spec.qnt
```
