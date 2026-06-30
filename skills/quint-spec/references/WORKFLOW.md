# Quint Workflow — Detailed Phase Reference

Detailed guidelines and code examples for each phase of the Quint specification
workflow. The entry point `SKILL.md` routes to this file for depth; read the relevant
phase when you need implementation-level detail.

---

## Phase 1: System/Protocol Analysis

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

---

## Phase 2: Domain Modeling

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

---

## Phase 3: State Space

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

---

## Phase 4: Actions

Define state transitions using the guard-update pattern: check preconditions, then
update state atomically.

**Guidelines:**

- Every action follows: `action name = all { guard, ...updates }`
- Guards are boolean expressions (no primes): `balanceOf(balances, sender, denom) >= amount`
- Updates assign primed variables: `balances' = balances.put(sender, ...)`
- Use `all { ... }` for conjunctive (AND) composition -- all updates happen atomically
- Use `any { ... }` for disjunctive (OR) composition -- nondeterministic choice
- Use `nondet x = S.oneOf(); ...` for nondeterministic value selection from a set
- Define a `step` action that combines all possible actions with `any`
- **Map safety**: Use a safe `addBalance`-style helper for nested maps.
  Both `.get(key)` and `.setBy(key, f)` fail at runtime if the key is absent.

```quint sketch
// Safe helper: add delta to a nested balance map without key-existence failures
pure def addBalance(
  bals: Address -> (Denom -> Amount),
  addr: Address,
  denom: Denom,
  delta: Amount,
): Address -> (Denom -> Amount) = {
  val addrBals = if (bals.keys().contains(addr)) bals.get(addr) else Map()
  val current = if (addrBals.keys().contains(denom)) addrBals.get(denom) else 0
  bals.put(addr, addrBals.put(denom, current + delta))
}

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
  // Updates via safe addBalance -- no key-existence failures
  balances' = addBalance(addBalance(balances, sender, denom, -amount), receiver, denom, amount),
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

---

## Phase 5: Properties

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

---

## Phase 6: Testing

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
    .expect(balanceOf(balances, "alice", "uatom") == 700)
    .expect(balanceOf(balances, "bob", "uatom") == 300)
    .expect(balancesConserved)

run edgeCaseZeroTransfer =
  init
    .then(mint("alice", "uatom", 100))
    .then(transfer("alice", "bob", "uatom", 0))
    .fail()  // Should fail: amount must be > 0
```

---

## Phase 7: Verification

Run simulation first (fast, finds many bugs), then model checking. Treat Apalache
checks as **bounded evidence** unless you use an inductive invariant or a deliberately
finite state space/TLC backend.

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
# Bounded model checking via Apalache (explores up to default step limit)
quint verify --invariant=balancesConserved spec.qnt

# Bounded model checking (explore up to N steps)
quint verify --invariant=balancesConserved --max-steps=10 spec.qnt
```

**Communicating results:** Write "no violation found up to N steps" rather than
"property is proven", unless you have established an inductive invariant or the model
is provably finite-state.

**Counterexample analysis:** When verification finds a violation:

1. Read the counterexample trace (printed to stdout)
2. Identify which step violated the invariant
3. Determine if it's a real bug or a modeling error
4. If modeling error: fix the spec (missing guard, wrong frame condition)
5. If real bug: report to the user with the minimal trace

**Coverage witnesses:** Use `quint run spec.qnt --witnesses noTransfersEverHappen` to
measure whether expected states are reached. For a hard reachability check, run
`quint run --invariant=noTransfersEverHappen` and confirm it finds a violation. If it
doesn't, the model's `step` action may be too constrained.

---

## Phase 8: Implementation Mapping

Once the model is verified, bridge the abstraction gap between the Quint spec and the
actual implementation (e.g., Solidity, Go, Rust, TypeScript). Generate an
Implementation Mapping.

**Extract & Map:**

- **State Mapper**: Map Quint types (Maps, Sets, arbitrarily large integers) to
  implementation types (`uint256`, arrays, mappings, structs). Document every
  truncation or coercion (e.g., `int` → `uint256` overflow behavior).
- **Action Mapper**: Map Quint actions to implementation function calls, resolving
  differences in arguments.
- **Gap document**: List what the Quint model abstracts away (gas, timing, reentrancy,
  access control) and note that those behaviors are not covered by the spec.

---

## Domain-Specific Guidance

### General Systems (Workflows, Resources, Architecture)

**Key concerns:** State transitions, resource constraints, liveness, concurrency.

- **Workflows:** Model states explicitly using sum types. Ensure that every state has
  valid transitions and that terminal states are reachable.
- **Resource Allocation:** Track total capacity and current allocations. Invariant:
  `sum(allocations) <= total_capacity`.
- **System Architecture:** Model components as services that exchange messages. Use
  sets or lists for message queues. Invariant: `waiting_service implies pending_message`.
- **Concurrency:** Model shared resources with locks or semaphores. Invariant:
  `holding_lock(p1) and holding_lock(p2) implies p1 == p2`.

See `references/GENERIC-TEMPLATE.md` and `references/SYSTEM-ARCH-TEMPLATE.md` for
starter templates.

### DeFi Protocols

**Key concerns:** Balance conservation, rounding/precision, solvency, share accounting.

- **Balance conservation:** For every token, `sum(all_balances) + protocol_reserves == total_supply`.
  This must hold across deposits, withdrawals, swaps, and fee collection.
- **Rounding tolerance:** Integer division loses precision. Use tolerance-based
  invariants: `abs(shares * totalAssets / totalShares - expectedAssets) <= 1`.
  Reference the Timewave Vault pattern in PATTERNS.md.
- **Solvency:** `protocol_assets >= protocol_liabilities` at all times.
- **Share accounting (ERC-4626):** `shares_to_assets(assets_to_shares(x)) <= x`.
  Model the inflation attack: first depositor gets 0 shares if attacker front-runs.
- **AMM invariants:** `reserve0 * reserve1 >= k` after every swap (inequality due to
  fees).

See `references/DEFI-TEMPLATE.md` for starter templates.

### Cross-Chain Interoperability

**Key concerns:** Packet lifecycle, exactly-once delivery, timeout handling, escrow
correctness.

- **Packet lifecycle:** Model the full ICS-04 flow: `send -> receive -> ack` and
  `send -> timeout`. Every sent packet must eventually be acknowledged OR timed out
  (liveness).
- **Exactly-once delivery:** No packet is processed twice. Use
  `processedPackets: Set[PacketId]` to track.
- **Escrow correctness:** Tokens escrowed on source chain == tokens minted on
  destination chain. On ack failure or timeout, escrowed tokens are returned.
- **Channel ordering:** For ordered channels, packets must be processed in sequence
  number order.
- **Timeout modeling:** Use logical time (block height) rather than wall-clock time.

See `references/INTEROP-TEMPLATE.md` for starter templates.

### Intent-Based Systems

**Key concerns:** Intent lifecycle, constraint satisfaction, solver distribution,
settlement correctness.

- **Intent lifecycle (ERC-7683):** Model states:
  `Pending -> Matched -> Filled -> Settled` with `Expired` as terminal from `Pending`
  or `Matched`. Each transition has preconditions.
- **Constraint satisfaction:** A fill is valid iff
  `fillAmount >= intent.minOutputAmount`.
- **Solver distribution:** Model multiple solvers with nondeterministic selection.
  This is **bounded distribution testing under free choice**, not an economic fairness
  proof or scheduler guarantee. It checks whether a single solver can dominate in
  traces where solvers act freely; it does not model incentive structures. For stronger
  fairness claims, add explicit fairness assumptions.
- **Batch auctions:** All orders in a batch clear at the same price. Invariant:
  `clearingPrice * totalInput >= totalOutput`.
- **Optimistic verification:** Model the challenge window:
  `if currentHeight - fillHeight > challengePeriod then settled else challengeable`.

See `references/INTENT-TEMPLATE.md` for starter templates.
