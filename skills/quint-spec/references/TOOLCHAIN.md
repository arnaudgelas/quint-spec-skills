# Quint Toolchain Reference

## Canonical Sources

- Quint CLI manual: https://quint-lang.org/docs/quint
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

## Core Commands

### quint typecheck

Type-check a Quint spec without executing transitions.

```bash
quint typecheck spec.qnt
```

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

### quint verify

Bounded exhaustive verification via Apalache.

```bash
quint verify --invariant=balancesConserved spec.qnt
quint verify --invariant=balancesConserved --max-steps=10 spec.qnt
quint verify --main=BankTest --invariant=supplyConserved spec.qnt
```

Use `quint verify --help` for current defaults and backend-specific options.

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
quint run --invariant=witnessNoActivity spec.qnt
# Expected: violation found

# 5. Thorough simulation
quint run --invariant=myInvariant --max-samples=10000 --max-steps=50 spec.qnt

# 6. Formal verification (requires Apalache + JDK 17+)
quint verify --invariant=myInvariant --max-steps=10 spec.qnt
```
