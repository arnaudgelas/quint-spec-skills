# Model-Based Testing (MBT) and Differential Fuzzing

Once a Quint specification is verified, the next critical step is ensuring the actual implementation conforms to it. This is achieved by exporting executable traces from Quint and generating a test runner (harness) in the target implementation language to replay those traces.

---

## 0. The Three Testing Commands

Quint provides three complementary commands for testing and verification, each serving a distinct purpose:

| Command        | Mode        | Best For                                                                             |
| -------------- | ----------- | ------------------------------------------------------------------------------------ |
| `quint test`   | Named tests | `run` blocks — fast unit tests, regression suites, reachability witnesses            |
| `quint run`    | Randomized  | Nondeterministic exploration — finding unexpected states via simulation              |
| `quint verify` | Model check | Bounded checking via Apalache, or explicit-state checking with TLC for finite models |

### `quint test` — Deterministic Named Tests

`quint test` runs named `run` blocks defined with the `run` keyword. Unlike `quint run`, each `run` block specifies its own expected sequence with `.then()` / `.expect()`. Tests are deterministic when the run is deterministic or seeded; randomized tests can use `--max-samples` and `--seed`.

```bash
# Run all named `run` blocks in the spec
quint test spec.qnt

# Run only blocks matching a pattern
quint test spec.qnt --match deposit
```

**When to use `quint test`:**

- Regression tests for specific protocol behaviors (happy paths, known edge cases)
- Proving specific states are reachable (false-invariant witnesses: if the test violates an invariant, the state is reachable)
- Quick iteration during spec development — deterministic, no randomness

**Example `run` block:**

```quint sketch
run depositWithdrawRoundTrip =
  init
    .then(deposit("alice", 100))
    .expect(totalAssets == 100 and amountOf(userShares, "alice") > 0)
    .then(withdraw("alice", amountOf(userShares, "alice")))
    .expect(totalAssets == 0)
```

**Workflow order:** Use `quint test` first for fast feedback, then `quint run` to explore, then `quint verify` for bounded checks, inductive-invariant checks, or finite-state TLC runs.

---

## 1. Exporting Traces (ITF Format)

Quint exports traces using the **Informal Trace Format (ITF)**, a standard JSON format for state machine executions.

### Exporting a Simulation Trace (Happy Path)

Run a randomized simulation that satisfies a property and export the trace:

```bash
# Export traces with model-based testing metadata
quint run --mbt --out-itf=trace_{seq}.itf.json spec.qnt
```

### Exporting a Counterexample (Bug Path)

If verification finds a violation, you can export the exact sequence of steps that triggered the bug to prove it exists in the implementation:

```bash
quint verify --out-itf=bug.itf.json spec.qnt
```

---

## 2. Generating a Test Runner from Scratch

When requested, generate a custom test runner in the user's specific stack (e.g., Solidity/Foundry, Go/Cosmos-SDK, Rust, TypeScript). The runner must bridge the **Abstraction Gap** between the spec and the code.

> **Safety notice:** Generated test runners are **not verified implementations**.
> Before using any generated runner in a production pipeline:
>
> - Document every abstraction mapping (integer overflow: `int` → `uint256`, missing-key
>   defaults, type coercions).
> - Keep generated code in a clearly labeled directory (e.g., `test/generated/`) and
>   never merge it into production paths without independent review.
> - Treat ITF traces as coming from trusted sources only (your own verified specs, not
>   user-supplied files).

> **State synchronization drift:** Step-by-step trace replay accumulates divergence.
> Each step applies an implementation action and then asserts the implementation state
> matches the Quint state. If the mapping is off by even 1 unit at step N (e.g., from
> integer division rounding or a uint256 overflow that Quint's `int` does not model),
> the assertion at step N+1 compares against the _wrong expected state_, and every
> subsequent assertion may pass for the wrong reason. Mitigations:
>
> - Assert strict equality on _all_ mapped state variables at every step, not just the
>   variables the current action touches.
> - Run the runner on known-bad traces (where the spec and implementation deliberately
>   diverge) to verify the harness actually catches divergence.
> - Prefer short traces (≤20 steps) for initial validation; extend only after the
>   per-step assertions are confirmed tight.

### The Runner Architecture

Every test runner needs four components:

1. **Parser**: Read the `trace.itf.json` file. An ITF file contains an array of states, where each state includes the values of all variables.
2. **State Mapper**: Translate Quint types (e.g., arbitrarily large integers, Maps, Sets) into language-specific types (e.g., `uint256`, HashMaps, Structs).
3. **Action Mapper (The Harness)**: Infer which action occurred between `state[i]` and `state[i+1]` and call the corresponding implementation function.
4. **Assertion Engine**: After applying the action, verify that the implementation's state matches the expected `state[i+1]` from the Quint trace.

### Pseudo-Code Runner Template

```javascript
// Generic Pseudo-Code for Trace Runner

function runTrace(traceFile, implementation) {
  const trace = parseITF(traceFile)

  // 1. Initialization
  const initialState = trace.states[0]
  implementation.setup(mapState(initialState))

  // 2. Execution Loop
  for (let i = 0; i < trace.states.length - 1; i++) {
    const currentState = trace.states[i]
    const nextState = trace.states[i + 1]

    // Determine which action caused the transition from mbt::actionTaken
    const action = inferAction(currentState, nextState)

    // 3. Execution
    executeMappedAction(implementation, action)

    // 4. Assertion
    const actualImplState = implementation.getState()
    const expectedMappedState = mapState(nextState)

    assert(actualImplState == expectedMappedState, `Divergence at step ${i}`)
  }
}
```

---

## 3. Implementation Specifics (Stack Agnostic)

When building a runner for a specific stack, follow these guidelines:

- **Rust (CosmWasm, Cosmos-SDK)**: [**Quint Connect**](https://github.com/informalsystems/quint-connect) is Informal Systems' Rust MBT library for ITF parsing, state mapping, and test harness generation for Rust/CosmWasm stacks. Check the repository for its current release status before depending on it; availability and API stability may have changed since this reference was written.
- **Smart Contracts (Solidity/Foundry)**: Use `ffi` (Foreign Function Interface) or file-read utilities to load the JSON. Map Quint's `Address` strings to actual hex addresses. Ensure precision issues (like Quint's infinite ints vs `uint256`) are mapped correctly.
- **Go (Cosmos-SDK, Backend)**: Use `encoding/json` to unmarshal the ITF file. The runner acts as a standard Go test suite, initializing the keeper/module with the genesis state derived from the first ITF state.
- **TypeScript (Node.js/Frontend)**: The easiest environment, as JSON parsing is native. Map Quint Maps to JS `Map` or objects.

---

## 4. Differential Fuzzing (Spec as Oracle)

Instead of pre-generating traces, the Quint spec can serve as a live **Oracle** during property-based testing (fuzzing).

### Architecture

1. The **Fuzzer** (e.g., Foundry, Echidna, RapidCheck) generates a random sequence of valid inputs/actions.
2. The inputs are applied to the **Implementation**.
3. The identical inputs are applied to the **Quint Spec** (often by executing a generated `run` command or via a wrapper script calling the Quint CLI).
4. **Comparison**: Assert that `Implementation_Output == Spec_Output`.

### Fuzzing Setup Guidelines

- Build a lightweight CLI wrapper around the Quint model that accepts an action and
  parameters via arguments or stdin, and outputs the resulting state.
- Have the native fuzzer invoke this wrapper to compute the expected state.
- **Note**: This approach is computationally heavier but provides only sampled exploration
  under fuzzer budget, seed, and corpus constraints -- not unbounded or exhaustive coverage.

> **Security note for the CLI wrapper:** Trace field values must **never** be interpolated
> into shell command strings -- this is a command-injection risk. Use exec-without-shell
> APIs (e.g., `execFile` in Node.js, `Command::new` in Rust, `subprocess` with a list
> in Python -- never `shell=True`). Validate all incoming ITF fields against a strict
> schema (type, range, allowed values) before passing them as arguments. Apply a timeout
> and memory cap to each wrapper invocation to prevent resource exhaustion from a
> malformed or adversarial trace.
