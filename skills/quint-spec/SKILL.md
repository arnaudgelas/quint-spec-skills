---
name: quint-spec
description: >
  Build formal Quint specifications to model, test, simulate, and verify
  properties of software systems, distributed protocols, or complex logic. Use
  this skill when a user mentions "quint", "formal spec", "model check",
  "specify protocol", "invariant", "state machine", "safety property", or
  wants to verify system logic.
metadata:
  author: zmanian
  version: 0.2.0
---

# Quint Specification Skill

## Overview

This skill guides you through building formal specifications in **Quint** -- a modern
specification language, originally developed by Informal Systems, that can be
checked with Apalache and TLC. Use this skill to:

- Model system state machines and verify stated safety/liveness properties
- Expose bugs and invalid assumptions in distributed algorithms, business workflows, and protocols
- Find edge cases in message flows, resource allocation, and concurrent systems
- Generate executable test traces from formal models
- Catch bugs _before_ implementation by exploring the full state space

**When to activate:** User asks to specify, model, model-check, or verify properties
of system logic -- including distributed systems (consensus, messaging), business
processes (workflows, auctions), DeFi (AMMs, lending), or cross-chain interop
(IBC, bridges).

## Prerequisites

```bash
# Install Quint CLI
npm install -g @informalsystems/quint@latest

# Verify installation
quint --version

# For formal verification (quint verify), install Apalache:
# Requires JDK 17+
# See: https://apalache-mc.org/docs/apalache/installation/jvm.html
```

Use `references/TOOLCHAIN.md` for command examples, and prefer the canonical
CLI manual for changing flags/defaults: https://quint.sh/docs/quint

For syntax-validated template modules, see `references/EXECUTABLE-EXAMPLES.md`.

## Workflow

Use these phases as a risk-based workflow, not as ceremony. For small tasks, produce a
minimal executable model quickly, then iterate through testing, simulation, and
verification. For protocol reviews, audits, or implementation-linked work, carry the
model through mapping and model-based testing. Incomplete models can produce
misleading results, so state all assumptions and bounds explicitly.

### Phase 1: System/Protocol Analysis

Extract the system's essential elements from informal descriptions, requirements, or
source code. Produce a structured summary before writing any Quint.

**Extract:**

- **State**: What data does the system track? (balances, status, queues, configs)
- **Participants**: Who interacts? (users, services, nodes, administrators)
- **Messages/Actions**: What operations change state? (create, send, process, delete)
- **Transitions**: What are the valid state transitions? (pending -> approved -> active)
- **Properties**: What must always/eventually hold? (safety, liveness, conservation)
- **Boundaries**: What are the domain constraints? (non-negative values, max capacity)

**Output a table:**

```
| Element     | Details                                      |
|-------------|----------------------------------------------|
| State       | requests: Map[Id, Request], nextId: int       |
| Participants| users, approvers                             |
| Actions     | create, approve, reject, complete            |
| Properties  | id_uniqueness, eventually_terminal_state      |
```

Ask the user to confirm the analysis only when the requirements are ambiguous or the
modeling choice would materially change the result.

### Phase 2: Domain Modeling

Define types that precisely capture the protocol's domain. Use sum types for messages,
states, and errors. Use records for structured data.

**Guidelines:**

- Start with `module <ProtocolName>Types` for shared type definitions
- Use sum types (variant) for protocol messages: `type Msg = Deposit(DepositMsg) | Withdraw(WithdrawMsg)`
- Use sum types for protocol states: `type Status = Pending | Matched | Filled | Settled | Expired`
- Use sum types for errors: `type Error = InsufficientBalance | Unauthorized | Expired`
- Define `type Result = Ok(State) | Err(Error)` for action outcomes
- Use type aliases for readability: `type Address = str`, `type Amount = int`
- Use records for structured data: `type Pool = { reserve0: int, reserve1: int, totalShares: int }`
- Prefer `int` over bounded integers -- Quint's int is arbitrary precision, model checking explores bounds via constraints
- Use `Set[T]` for unordered collections, `List[T]` for ordered sequences, `Map[K, V]` for key-value stores

```quint illustrative
module MyProtocolTypes {
  type Address = str
  type Denom = str
  type Amount = int

  type DepositMsg = { sender: Address, amount: Amount, denom: Denom }
  type WithdrawMsg = { sender: Address, shares: Amount }
  type Msg = Deposit(DepositMsg) | Withdraw(WithdrawMsg)

  type Error = InsufficientBalance | Unauthorized | InvalidAmount
  type Result = Ok(bool) | Err(Error)
}
```

### Phase 3: State Space

Define the module's state variables and initialization. Every variable that can change
must be declared with `var`. Immutable protocol parameters use `const` or `pure val`.

**Guidelines:**

- One module per logical component (e.g., `BankModule`, `PoolModule`, `IntentModule`)
- Declare all state variables with `var`
- Define `action init` that sets ALL variables to valid starting values
- Use `const` for protocol parameters that vary between instances
- Consider ghost variables for verification (variables that track properties but don't affect protocol logic)

```quint sketch
module MyProtocol {
  import MyProtocolTypes.*

  const INITIAL_SUPPLY: Amount
  const ADMIN: Address

  var balances: Address -> (Denom -> Amount)
  var totalSupply: Denom -> Amount

  // Ghost variable: tracks total ever minted for verification
  var ghostTotalMinted: Denom -> Amount

  action init = all {
    balances' = Map(),
    totalSupply' = Map(),
    ghostTotalMinted' = Map(),
  }
}
```

**Frame condition rule:** Every action must assign ALL `var` variables. If an action
does not change a variable, explicitly write `variable' = variable`. Missing frame
conditions are the #1 source of spurious verification results.

### Phase 4: Actions

Define state transitions using the guard-update pattern: check preconditions, then
update state atomically.

**Guidelines:**

- Every action follows: `action name = all { guard, ...updates }`
- Guards are boolean expressions (no primes): `balances.get(sender).get(denom) >= amount`
- Updates assign primed variables: `balances' = balances.put(sender, ...)`
- Use `all { ... }` for conjunctive (AND) composition -- all updates happen atomically
- Use `any { ... }` for disjunctive (OR) composition -- nondeterministic choice
- Use `nondet x = S.oneOf(); ...` for nondeterministic value selection from a set
- Define a `step` action that combines all possible actions with `any`

```quint sketch
pure def balanceOf(
  bals: Address -> (Denom -> Amount),
  addr: Address,
  denom: Denom,
): Amount =
  if (bals.keys().contains(addr) and bals.get(addr).keys().contains(denom))
    bals.get(addr).get(denom)
  else
    0

action transfer(sender: Address, receiver: Address, denom: Denom, amount: Amount): bool = all {
  // Guards
  balanceOf(balances, sender, denom) >= amount,
  amount > 0,
  sender != receiver,
  // Updates
  balances' = balances
    .setBy(sender, senderBals => senderBals.setBy(denom, b => b - amount))
    .setBy(receiver, recvBals => recvBals.setBy(denom, b => b + amount)),
  totalSupply' = totalSupply,
  ghostTotalMinted' = ghostTotalMinted,
}

// Nondeterministic step: model checker explores all choices
action step = {
  nondet sender = ADDRESSES.oneOf()
  nondet receiver = ADDRESSES.oneOf()
  nondet denom = DENOMS.oneOf()
  nondet amount = 1.to(MAX_AMOUNT).oneOf()
  any {
    transfer(sender, receiver, denom, amount),
    mint(sender, denom, amount),
    burn(sender, denom, amount),
  }
}
```

### Phase 5: Properties

Define invariants (always true) and temporal properties (eventually true). These are
what verification actually checks.

**Types of properties:**

- **State invariants** (`val`): Must hold in every reachable state
- **Action invariants**: Must hold after every step
- **Temporal properties** (`temporal`): Express liveness (something eventually happens)

**Guidelines:**

- Start with conservation invariants (totals are preserved)
- Add safety invariants (bad states are unreachable)
- Use false-invariant witnesses to verify the model is not vacuously trivial
- Express tolerance for integer rounding: `abs(computed - expected) <= EPSILON`

```text
pure def balanceOf(
  bals: Address -> (Denom -> Amount),
  addr: Address,
  denom: Denom,
): Amount =
  if (bals.keys().contains(addr) and bals.get(addr).keys().contains(denom))
    bals.get(addr).get(denom)
  else
    0

pure def supplyOf(supply: Denom -> Amount, denom: Denom): Amount =
  if (supply.keys().contains(denom)) supply.get(denom) else 0

// Conservation: total supply matches sum of all balances
val balancesConserved = DENOMS.forall(d =>
  supplyOf(totalSupply, d) ==
    ADDRESSES.fold(0, (sum, addr) =>
      sum + balanceOf(balances, addr, d)
    )
)

// Safety: no negative balances
val noNegativeBalances = ADDRESSES.forall(addr =>
  DENOMS.forall(d =>
    balanceOf(balances, addr, d) >= 0
  )
)

// False-invariant witness: verify transfers actually happen
// This SHOULD be violated -- if it passes, the model is too constrained
val noTransfersEverHappen = ADDRESSES.forall(addr =>
  DENOMS.forall(d =>
    balanceOf(balances, addr, d) == 0
  )
)
```

### Phase 6: Testing

Write run-traces that exercise specific scenarios. Tests serve as executable
documentation and sanity checks before full verification.

**Guidelines:**

- Use `.then()` chains for sequential actions
- Use `.expect()` to assert properties after each step
- Cover happy paths, edge cases, and error paths
- Name tests descriptively: `run transferThenBurnTest = ...`

```quint sketch
run happyPathTest =
  init
    .then(mint("alice", "uatom", 1000))
    .expect(totalSupply.get("uatom") == 1000)
    .then(transfer("alice", "bob", "uatom", 300))
    .expect(balances.get("alice").get("uatom") == 700)
    .expect(balances.get("bob").get("uatom") == 300)
    .expect(balancesConserved)

run edgeCaseZeroTransfer =
  init
    .then(mint("alice", "uatom", 100))
    .then(transfer("alice", "bob", "uatom", 0))
    .fail()  // Should fail: amount must be > 0
```

### Phase 7: Verification

Run simulation first (fast, finds many bugs), then model checking. Treat Apalache
checks as bounded unless you use an inductive invariant or a deliberately finite
state space/backend configuration.

**Simulation:**

```bash
# Quick smoke test
quint run --invariant=balancesConserved spec.qnt

# Thorough simulation
quint run --invariant=balancesConserved --max-samples=10000 --max-steps=50 spec.qnt

# With specific random seed for reproducibility
quint run --invariant=balancesConserved --seed=42 spec.qnt
```

**Formal verification:**

```bash
# Bounded model checking via Apalache
quint verify --invariant=balancesConserved spec.qnt

# Bounded model checking (explore up to N steps)
quint verify --invariant=balancesConserved --max-steps=10 spec.qnt
```

**Counterexample analysis:** When verification finds a violation:

1. Read the counterexample trace (printed to stdout)
2. Identify which step violated the invariant
3. Determine if it's a real bug or a modeling error
4. If modeling error: fix the spec (missing guard, wrong frame condition)
5. If real bug: report to the user with the minimal trace

**Coverage witnesses:** Prefer `quint run spec.qnt --witnesses noTransfersEverHappen` to measure
whether expected states are reached. For a hard reachability check, run
`quint run --invariant=noTransfersEverHappen` and confirm it finds a violation. If it
doesn't, the model's `step` action may be too constrained.

### Phase 8: Implementation Mapping

Once the model is verified, bridge the abstraction gap between the Quint spec and the actual implementation (e.g., Solidity, Go, Rust, TypeScript).
Generate an Implementation Mapping.

**Extract & Map:**

- **State Mapper**: Map Quint types (Maps, Sets, arbitrarily large integers) to implementation types (`uint256`, arrays, mappings, structs).
- **Action Mapper**: Map Quint actions to implementation function calls, resolving differences in arguments.

### Phase 9: Model-Based Testing & Differential Fuzzing

Use the verified model as the source of truth for testing the actual implementation.

**1. Trace Validation (Test Runner Generation):**
When requested, generate a custom test harness/runner for the user's stack (Foundry, Go, Rust, etc.) from scratch.

- Export traces in ITF format with MBT metadata: `quint run --mbt --out-itf=trace_{seq}.itf.json spec.qnt` or counterexamples with `quint verify --out-itf=bug.itf.json spec.qnt`.
- The runner must parse the JSON trace, initialize the implementation state, execute the actions step-by-step, and assert the implementation state matches the Quint state at each step.

**2. Differential Fuzzing (Oracle):**
Instead of pre-generated traces, set up a fuzzing loop where a native fuzzer generates random actions. Apply those same actions to both the implementation and the Quint spec (using a CLI wrapper) and assert their outputs match.

### Phase 10: Refinement Modeling (Optional - Advanced)

Prove that a low-level **Concrete Model** correctly implements a high-level **Abstract Model**.

- Define an Abstract Model for core business logic.
- Define a Concrete Model with implementation details (e.g., relayers, pending states).
- Create a **Refinement Mapping** from concrete to abstract state and verify refinement properties.

### Phase 11: Liveness & Fairness (Optional - Advanced)

Prove that "something good _eventually_ happens" using temporal logic.

- Add **Fairness Constraints** to actions using `weakFair(A, e)` (action continuously enabled → eventually taken) and `strongFair(A, e)` (action infinitely often enabled → eventually taken).
- Define `temporal` properties using `eventually`, `always`, `leadsTo` (v0.32.0), and `until`.
- Verify with `quint verify --backend=tlc --temporal=myLivenessProp --max-steps=20 spec.qnt`.
- Verify properties like **Deadlock-freedom** and **Message-delivery-guarantees**.

### Phase 12: Spec-Driven Boilerplate Generation

Generate the **Interface** or **Skeleton** for the actual implementation directly from verified Quint specs.

- Convert Quint `type` definitions to Solidity/Rust/Go structs and enums.
- Generate function signatures for each `action`, including `require` statements derived from Quint guards.

### Phase 13: Specification Visualization

Automatically generate **Mermaid.js** diagrams to turn formal specs into live documentation.

- Use state diagrams to visualize state machines (`Status` sum types).
- Use sequence diagrams to visualize multi-component message passing.

See `references/PATTERNS.md` for design patterns and `references/ADVANCED-TOPICS.md` for refinement modeling, liveness, and code generation guidance.

## Domain-Specific Guidance

### General Systems (Workflows, Resources, Architecture)

**Key concerns:** State transitions, resource constraints, liveness, concurrency.

- **Workflows:** Model states explicitly using sum types. Ensure that every state has valid transitions and that terminal states are reachable.
- **Resource Allocation:** Track total capacity and current allocations. Invariant: `sum(allocations) <= total_capacity`.
- **System Architecture:** Model components as services that exchange messages. Use sets or lists for message queues. Invariant: `waiting_service implies pending_message`.
- **Concurrency:** Model shared resources with locks or semaphores. Invariant: `holding_lock(p1) and holding_lock(p2) implies p1 == p2`.

See `references/GENERIC-TEMPLATE.md` and `references/SYSTEM-ARCH-TEMPLATE.md` for starter templates.

### DeFi Protocols

**Key concerns:** Balance conservation, rounding/precision, solvency, share accounting.

- **Balance conservation:** For every token, `sum(all_balances) + protocol_reserves == total_supply`. This must hold across deposits, withdrawals, swaps, and fee collection.
- **Rounding tolerance:** Integer division loses precision. Use tolerance-based invariants: `abs(shares * totalAssets / totalShares - expectedAssets) <= 1`. Reference the Timewave Vault pattern in PATTERNS.md.
- **Solvency:** `protocol_assets >= protocol_liabilities` at all times. For lending: `sum(collateral * price / ratio) >= sum(borrows)`.
- **Share accounting (ERC-4626):** `shares_to_assets(assets_to_shares(x)) <= x` (no free tokens from rounding). Model the inflation attack: first depositor gets 0 shares if attacker front-runs.
- **AMM invariants:** `reserve0 * reserve1 >= k` after every swap (inequality due to fees). Price impact bounds: `abs(effective_price - spot_price) / spot_price <= slippage_tolerance`.

See `references/DEFI-TEMPLATE.md` for starter templates.

### Cross-Chain Interoperability

**Key concerns:** Packet lifecycle, exactly-once delivery, timeout handling, escrow correctness.

- **Packet lifecycle:** Model the full ICS-04 flow: `send -> receive -> ack` and `send -> timeout`. Every sent packet must eventually be acknowledged OR timed out (liveness).
- **Exactly-once delivery:** No packet is processed twice. Use a `processedPackets: Set[PacketId]` to track.
- **Escrow correctness:** Tokens escrowed on source chain == tokens minted on destination chain. On ack failure or timeout, escrowed tokens are returned.
- **Channel ordering:** For ordered channels, packets must be processed in sequence number order. Model with `nextSequenceRecv: ChannelId -> int`.
- **Multi-chain state:** Use per-chain maps: `var chainStates: ChainId -> ChainState`. Model relayers as nondeterministic actors that can deliver any pending packet.
- **Timeout modeling:** Use logical time (block height) rather than wall-clock time. `timeoutHeight > currentHeight` for validity.

See `references/INTEROP-TEMPLATE.md` for starter templates.

### Intent-Based Systems

**Key concerns:** Intent lifecycle, constraint satisfaction, solver fairness, settlement correctness.

- **Intent lifecycle (ERC-7683):** Model states: `Pending -> Matched -> Filled -> Settled` with `Expired` as terminal from `Pending` or `Matched`. Each transition has preconditions.
- **Constraint satisfaction:** An intent specifies `{ inputToken, inputAmount, outputToken, minOutputAmount }`. A fill is valid iff `fillAmount >= intent.minOutputAmount`.
- **Solver fairness:** No single solver should be able to monopolize fills. Model multiple solvers with nondeterministic selection. Check that in sufficiently long traces, multiple solvers participate.
- **Batch auctions:** All orders in a batch clear at the same price. Invariant: `clearingPrice * totalInput >= totalOutput` and no individual order gets a worse price than their limit.
- **Optimistic verification:** Fills are assumed valid for a challenge period. Model the challenge window: `if currentHeight - fillHeight > challengePeriod then settled else challengeable`.
- **Cross-chain intents:** Combine intent lifecycle with packet lifecycle. The fill happens on the destination chain; settlement on the source chain. Model the two-chain state explicitly.

See `references/INTENT-TEMPLATE.md` for starter templates.

## Key Patterns

See `references/PATTERNS.md` for 18+ proven patterns extracted from production Quint
specifications, including:

- Parameterized module + concrete instance
- Message-passing via set accumulation
- Guard + update (precondition pattern)
- Nondeterministic step with process selection
- Sum types for protocol messages and states
- Result/Option types for error handling
- Ghost variables for verification
- Bookkeeping/tracking pattern (Neutron DEX)
- Tolerance-based invariants (Timewave Vault)
- EVM/smart contract environment modeling (ZKSync Governance)
- Multi-chain state with per-chain maps (ICS-20, CCV)
- Packet queue pattern for async cross-chain communication

## Common Pitfalls

### 1. Missing Frame Conditions

**Symptom:** Invariant passes but shouldn't, or fails with bizarre counterexamples.
**Cause:** An action doesn't assign all `var` variables, so the model checker assigns them arbitrary values.
**Fix:** Every action must assign `variable' = ...` for ALL state variables. If unchanged: `variable' = variable`.

### 2. Vacuously True Invariants

**Symptom:** Invariant passes immediately on all runs.
**Cause:** The `step` action guards are too restrictive -- no transitions are actually possible.
**Fix:** Write a false-invariant witness (an invariant you expect to be violated) and verify it actually gets violated. If it doesn't, relax your guards or check your `init`.

### 3. Overly Constrained Nondeterminism

**Symptom:** Simulation runs very few steps or always stalls.
**Cause:** The nondeterministic choices in `step` almost never satisfy the guards.
**Fix:** Reduce the range of `nondet` choices. Instead of `1.to(MAX_INT).oneOf()`, use `1.to(100).oneOf()` for simulation. Use constants that can be tuned for verification.

### 4. Integer Overflow Modeling

**Symptom:** Unrealistic counterexamples with astronomically large numbers.
**Cause:** Quint's `int` is unbounded. Real protocols have `uint256` or `uint128` limits.
**Fix:** Add explicit bounds in guards: `amount > 0 and amount <= MAX_UINT256`. Or use a `validAmount(x)` helper.

### 5. Confusing `all` vs `any`

**Symptom:** Actions behave unexpectedly -- either nothing happens or too much happens.
**Cause:** `all` means conjunction (all must succeed), `any` means disjunction (one is chosen nondeterministically).
**Fix:** Use `all { guard, update1, update2 }` within a single action. Use `any { action1, action2 }` in the `step` to choose between actions.

### 6. Forgetting `nondet` in Step

**Symptom:** Model only explores one specific parameter value.
**Cause:** Action parameters are fixed instead of nondeterministic.
**Fix:** Use `nondet x = S.oneOf()` in the `step` action before calling parameterized actions.

### 7. Map/Set Default Values

**Symptom:** Runtime error or unexpected behavior when accessing missing keys.
**Cause:** `Map.get(key)` fails if key doesn't exist.
**Fix:** Check `map.keys().contains(key)` before `.get(key)` and create helper functions for defaults. For nested maps, prefer a helper like `balanceOf(bals, addr, denom)`.

## Modeling Limits

Quint checks the model you write, not the implementation or the real world directly.
Keep these limits explicit in every nontrivial spec:

- Bounds: finite sets, ranges, trace depth, and any constants chosen for tractability.
- Abstractions: behavior intentionally omitted from the model, such as gas, timing, I/O, failures, or cryptography.
- Fairness: assumptions needed for liveness, such as messages eventually being delivered or enabled actions eventually being scheduled.
- Refinement gap: how Quint state/actions map to implementation state/functions, and what is not covered by that mapping.
