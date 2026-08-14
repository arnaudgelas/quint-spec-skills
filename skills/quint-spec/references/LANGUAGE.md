# Quint Language Quick Reference

For syntax-validated runnable counterparts, use `EXECUTABLE-EXAMPLES.md`.

## Types

### Basic Types

```text
int           // Integer. Mathematically unbounded, BUT the default quint run/test
              // backend is Rust/i64: overflow past 2^63-1 raises QNT601, and a
              // literal outside i64 raises QNT600. Apalache is unbounded.
bool          // true, false
str           // String literal: "hello"
```

### Collection Types

```text
Set[T]        // Unordered, unique elements: Set(1, 2, 3)
List[T]       // Ordered sequence: [1, 2, 3]
K -> V        // Map TYPE, e.g. `str -> int`. Value literal: Map("a" -> 1, "b" -> 2)
(T1, T2)      // Tuple: (1, "hello")
```

> The map **type** is written `K -> V`, never `Map[K, V]`. Quint ships a dedicated
> diagnostic for this mistake: `var m: Map[str, int]` fails with
> `QNT015: Use 'str -> int' instead of 'Map[str, int]' for map types`.
> `Map(...)` is only the value constructor.

### Record Types

```quint illustrative
// Named fields
type Pool = { reserve0: int, reserve1: int, k: int }

// Construction
pure val p: Pool = { reserve0: 100, reserve1: 200, k: 20000 }

// Access
pure val r0 = p.reserve0                    // 100

// Spread update (creates a new record with the listed fields replaced)
pure val bigger = { ...p, reserve0: 150 }

// Single-field update (alternative to spread syntax)
pure val bigger2 = p.with("reserve0", 150)
```

> Every top-level item in a module must be a definition. A bare expression such as
> `p.reserve0` on its own line is a syntax error (QNT000) -- bind it with `val` /
> `pure val`, or evaluate it in the REPL.

### Sum Types (Variants)

```quint illustrative
type Option[a] = Some(a) | None
type Result[a, e] = Ok(a) | Err(e)

type Msg =
  | Deposit({ sender: str, amount: int })
  | Withdraw({ sender: str, shares: int })
  | Swap({ sender: str, tokenIn: str, amountIn: int })
```

### Type Aliases

```quint illustrative
type Address = str
type Denom = str
type Amount = int
type Balances = Address -> (Denom -> Amount)
```

## Qualifiers

### pure val / pure def

No state access. Compile-time constants and pure functions.

```quint illustrative
pure val MAX_SUPPLY = 1000000
pure def min(a: int, b: int): int = if (a < b) a else b
pure def abs(x: int): int = if (x >= 0) x else -x
```

### val / def

Can read state (no primes). Used for derived values and invariants.

```quint sketch
val totalBalance =
  ADDRESSES.fold(0, (sum, a) => sum + if (balances.keys().contains(a)) balances.get(a) else 0)
def balanceOf(addr: Address): int = if (balances.keys().contains(addr)) balances.get(addr) else 0
```

### action

Can read and write state (primes allowed). Represents state transitions.

```quint sketch
action deposit(sender: Address, amount: int): bool = all {
  amount > 0,
  balances' = balances.setBy(sender, b => b + amount),
  totalDeposits' = totalDeposits + amount,
}
```

### temporal

For temporal logic properties (liveness, fairness).

```quint sketch
temporal eventuallySettled = eventually(status == "settled")
temporal alwaysConserved = always(balancesConserved)
```

## State Updates

### Primed Variables

The `'` (prime) suffix denotes the next-state value of a variable.

```quint illustrative
var counter: int

action increment = all {
  counter' = counter + 1,
}
```

**Rule:** Every action must assign ALL `var` variables. If unchanged:

```quint sketch
action incrementOnlyCounter = all {
  counter' = counter + 1,
  otherVar' = otherVar,    // Frame condition: explicitly unchanged
}
```

## Action Composition

### all { ... } -- Conjunction

All conditions must hold and all updates apply atomically.

```quint sketch
action transfer(from: Address, receiver: Address, amount: int): bool = all {
  balances.keys().contains(from),           // guard: sender must exist
  balances.get(from) >= amount,             // guard: sufficient balance
  amount > 0,                               // guard
  // Use put, not setBy: setBy fails if the key is absent.
  // The receiver may have no prior entry in the map.
  //
  // CRITICAL: read the receiver's balance from the DEBITED map, not from the
  // original `balances`. Chaining two `.put`s that both read `balances` is an
  // aliasing bug: when `from == receiver` the second put overwrites the first
  // using the PRE-debit value, and the transfer mints `amount` out of nothing
  // (alice: 100 -> 200 on a self-transfer of 100). Either thread the
  // intermediate map as below, or guard `from != receiver` -- threading is
  // safer, because the guard is easy to forget when the code is copied.
  val debited = balances.put(from, balances.get(from) - amount)
  balances' = debited.put(receiver,
    (if (debited.keys().contains(receiver)) debited.get(receiver) else 0) + amount),
}
```

### any { ... } -- Disjunction

Nondeterministic choice: exactly one branch is taken.

```quint sketch
action step = any {
  deposit(sender, amount),
  withdraw(sender, shares),
  swap(sender, tokenIn, amountIn),
}
```

### nondet -- Nondeterministic Value Selection

Selects a value nondeterministically from a set. Model checker explores all choices.

```quint sketch
action step = {
  nondet sender = ADDRESSES.oneOf()
  nondet amount = 1.to(100).oneOf()
  any {
    deposit(sender, amount),
    withdraw(sender, amount),
  }
}
```

## Pattern Matching

### match Expression

```text
match msg {
  | Deposit(d) => handleDeposit(d.sender, d.amount)
  | Withdraw(w) => handleWithdraw(w.sender, w.shares)
  | Swap(s) => handleSwap(s.sender, s.tokenIn, s.amountIn)
}
```

### if-then-else

```text
if (balance >= amount) Ok(balance - amount) else Err(InsufficientBalance)
```

## Module System

### Module Definition

```quint illustrative
module BankTypes {
  type Address = str
  type Amount = int
}
```

### Import

```quint sketch
import BankTypes.*                    // Import all from module
import BankTypes.Address              // Import specific type
import BankTypes as BT                // Qualified import: BT.Address
```

### Export

```quint sketch
module Facade {
  import BankModule.*
  export BankModule.*                 // Re-export for downstream consumers
}
```

### Instance with Constants

Parameterized modules are instantiated with concrete constants.

```quint illustrative
module BankModule {
  const ADDRESSES: Set[str]
  const DENOMS: Set[str]
  // ... state and actions using constants
}

module BankTest {
  import BankModule(
    ADDRESSES = Set("alice", "bob", "carol"),
    DENOMS = Set("uatom", "uosmo"),
  ).*
}
```

## Built-in Operators

### Integer

```text
a + b, a - b, a * b, a / b, a % b   // Arithmetic
a == b, a != b                        // Equality
a < b, a <= b, a > b, a >= b         // Comparison
a ^ b                                // Exponentiation (right-associative)
// Non-infix aliases (useful as higher-order function arguments):
// iadd, isub, imul, idiv, imod, ipow, ilt, igt, ilte, igte
i.to(j)                              // Range set: {i, i+1, ..., j}
```

### Boolean

```text
a and b, a or b, not(a)              // Logical
a implies b                           // Implication
a iff b                               // Biconditional
```

### Set

```text
Set(1, 2, 3)                         // Literal
s.contains(x)                        // Membership
s.union(t), s.intersect(t)           // Set operations
s.exclude(t)                         // Difference: s \ t
s.filter(x => predicate)             // Filter
s.map(x => f(x))                     // Map
s.fold(init, (acc, x) => ...)        // Fold/reduce
s.forall(x => predicate)             // Universal quantifier
s.exists(x => predicate)             // Existential quantifier
s.size()                             // Cardinality
s.oneOf()                            // Nondeterministic choice (in nondet)
s.powerset()                         // Power set
s.flatten()                          // Flatten Set[Set[T]] -> Set[T]
s.subseteq(t)                        // Subset test: s ⊆ t
e.in(S)                              // Membership check (same as S.contains(e))
s.chooseSome()                       // Deterministic choice of some element
s.getOnlyElement()                   // Extract element from a singleton set
s.isFinite()                         // Test whether s is finite
s.allLists()                         // All finite lists with elements from s
s.allListsUpTo(n)                    // All lists with elements from s, up to length n
```

### List

```text
[1, 2, 3]                            // Literal
l.length()                           // Length
l.nth(i)                             // Element at index (0-based)
l.head()                             // First element
l.tail()                             // All except first
l.append(x)                          // Append to end
l.concat(m)                          // Concatenate lists
l.indices()                          // Set of valid indices
l.foldl(init, (acc, x) => ...)       // Left fold
l.select(x => predicate)             // Filter
l.slice(from, to)                    // Sublist [from, to)
l[i]                                 // Element at index i (same as l.nth(i))
l.replaceAt(i, e)                    // New list with element at index i replaced by e
range(start, end)                    // List [start, start+1, ..., end-1]
```

### Map

```text
Map("a" -> 1, "b" -> 2)              // Literal
m.get(key)                           // Get (fails if missing!)
m.keys().contains(key)               // Key exists
if (m.keys().contains(key)) m.get(key) else default
m.put(key, value)                    // Insert or replace (returns new map)
m.set(key, value)                    // Replace existing key; fails if key is missing
m.setBy(key, f)                      // Update existing key by function; fails if key is missing
m.keys()                             // Set of keys
keys.mapBy(k => v)                   // Build map from key set (keys is Set[K]; this is a Set method)
f[e]                                 // Lookup by bracket syntax (same as f.get(e))
```

### Temporal (for verification)

```text
always(p)                             // p holds in all states
eventually(p)                         // p holds in some future state
next(p)                               // p holds in the next state
p.leadsTo(q)                          // Whenever p holds, q eventually holds (v0.32.0)
enabled(action)                       // action's guards are satisfied in current state
weakFair(A, Set(x, y))                // Weak fairness WF_vars(A) -- SET of variables
strongFair(A, Set(x, y))              // Strong fairness SF_vars(A) -- SET of variables
orKeep(A, Set(x))                     // [A]_vars: A takes a step, or vars unchanged
mustChange(A, Set(x))                 // <A>_vars: A takes a step AND vars change
```

> The last four take a **set of state variables**, not a bare variable. Their type
> variable is unconstrained, so `weakFair(step, x)` typechecks silently and means
> nothing. Always write `Set(...)`.
>
> There is **no** `guarantees`, `existsConst`, or `forallConst` in Quint — all three
> are `QNT404: Name not found`. For quantification, use bounded `S.forall(x => p)`
> and `S.exists(x => p)` over an explicit set.

## Run Traces (Tests)

```quint sketch
run myTest =
  init
    .then(action1(arg1, arg2))
    .expect(property1)
    .then(action2(arg3))
    .expect(property2)
```

> **`.fail()` does not mean "the last step should fail".** `a.fail()` is `true`
> exactly when `a` evaluates to `false`, and in a chain it applies to the WHOLE
> action to its left -- so appending `.fail()` to the run above asserts that the
> entire trace fails, which also passes if `init` or `action1` failed for an
> unrelated reason. To assert that one specific action is rejected, isolate it:
>
> ```quint sketch
> run rejectsOverdraftTest =
>   init
>     .then(deposit("alice", 10))
>     .then(withdraw("alice", 999).fail())   // only this action must fail
> ```

## Common Idioms

```quint sketch
// Safe balance lookup (nested map)
pure def getBalance(bals: Address -> (Denom -> int), addr: Address, denom: Denom): int =
  if (bals.keys().contains(addr) and bals.get(addr).keys().contains(denom))
    bals.get(addr).get(denom)
  else
    0

// Require pattern (guard helper)
pure def require(cond: bool): bool = cond

// Integer set range for nondeterminism
nondet amount = 1.to(MAX_AMOUNT).oneOf()

// Tuple destructuring
val (x, y) = myTuple
```

## Tuples and Cartesian Products

```text
tuples(S1, S2, S3)                   // Cartesian product S1 × S2 × S3 → Set[(T1,T2,T3)]
t._1, t._2, ..., t._50              // Tuple component access (1-indexed)
// NOTE: `f[e]` bracket syntax is LIST indexing only (it desugars to `nth`).
// On a map it fails with "Couldn't unify list and fun" -- use `m.get(k)`.
```

## Multi-Way Conditionals

Quint has **no `case` expression**. `case (...)` is not in the grammar — it fails with
`QNT000: extraneous input '('` followed by `QNT404: Name 'case' not found`. There are
exactly two constructs:

```quint illustrative
// 1. Chained if/else for boolean conditions -- the `else` is mandatory
pure def classify(n: int): str =
  if (n > 100) "large"
  else if (n > 10) "medium"
  else "small"

// 2. `match` for sum types -- one level only
type Msg = Deposit(int) | Withdraw(int)

pure def amountOf(m: Msg): int =
  match m {
    | Deposit(a) => a
    | Withdraw(a) => a
  }
```

> **`match` does not nest.** A pattern like `Request(Prepare(n))` fails with
> `QNT008: Reserved keyword 'match' cannot be used as an identifier`. Destructure one
> level at a time, delegating the inner type to a helper:
>
> ```quint sketch
> pure def inner(i: Inner): int = match i { | Prepare(n) => n | Commit(n) => n }
> pure def outer(m: Msg): int = match m { | Request(x) => inner(x) | Reply(n) => n }
> ```

## Assert (Action Mode)

```text
assert(condition)                    // Evaluates condition; reports error if false
```

## Run Trace Repetition

```text
n.reps(i => A(i))                    // Repeat action A n times (i = step index 0..n-1)
n.reps(_ => A)                       // Repeat action A n times (ignoring index)
```

## Module Instance Qualified Names

When importing with `as Name`, access definitions via the `::` separator:

```quint sketch
module BankTest {
  import BankModule(
    ADDRESSES = Set("alice", "bob"),
    DENOMS = Set("uatom"),
  ) as Bank

  // Access via qualified name
  val aliceBalance = Bank::balances
}
```
