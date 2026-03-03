# Quint Language Quick Reference

For syntax-validated runnable counterparts, use `EXECUTABLE-EXAMPLES.md`.

## Types

### Basic Types

```text
int           // Arbitrary precision integer
bool          // true, false
str           // String literal: "hello"
```

### Collection Types

```text
Set[T]        // Unordered, unique elements: Set(1, 2, 3)
List[T]       // Ordered sequence: [1, 2, 3]
Map[K, V]     // Key-value store: Map("a" -> 1, "b" -> 2)
(T1, T2)      // Tuple: (1, "hello")
```

### Record Types

```text
// Named fields
type Pool = { reserve0: int, reserve1: int, k: int }

// Construction
val p: Pool = { reserve0: 100, reserve1: 200, k: 20000 }

// Access
p.reserve0          // 100

// Spread update (creates new record with updated fields)
{ ...p, reserve0: 150 }
```

### Sum Types (Variants)

```text
type Option[T] = Some(T) | None
type Result[T, E] = Ok(T) | Err(E)

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

```text
val totalBalance =
  ADDRESSES.fold(0, (sum, a) => sum + if (balances.contains(a)) balances.get(a) else 0)
def balanceOf(addr: Address): int = if (balances.contains(addr)) balances.get(addr) else 0
```

### action

Can read and write state (primes allowed). Represents state transitions.

```text
action deposit(sender: Address, amount: int): bool = all {
  amount > 0,
  balances' = balances.setBy(sender, b => b + amount),
  totalDeposits' = totalDeposits + amount,
}
```

### temporal

For temporal logic properties (liveness, fairness).

```text
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

```text
action incrementOnlyCounter = all {
  counter' = counter + 1,
  otherVar' = otherVar,    // Frame condition: explicitly unchanged
}
```

## Action Composition

### all { ... } -- Conjunction

All conditions must hold and all updates apply atomically.

```text
action transfer(from: Address, receiver: Address, amount: int): bool = all {
  balances.contains(from),                  // guard
  balances.get(from) >= amount,             // guard
  amount > 0,                               // guard
  balances' = balances                      // update
    .setBy(from, b => b - amount)
    .setBy(receiver, b => b + amount),
}
```

### any { ... } -- Disjunction

Nondeterministic choice: exactly one branch is taken.

```text
action step = any {
  deposit(sender, amount),
  withdraw(sender, shares),
  swap(sender, tokenIn, amountIn),
}
```

### nondet -- Nondeterministic Value Selection

Selects a value nondeterministically from a set. Model checker explores all choices.

```text
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

```text
import BankTypes.*                    // Import all from module
import BankTypes.Address              // Import specific type
import BankTypes as BT                // Qualified import: BT.Address
```

### Export

```text
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
```

### Map

```text
Map("a" -> 1, "b" -> 2)              // Literal
m.get(key)                           // Get (fails if missing!)
m.contains(key)                      // Key exists
if (m.contains(key)) m.get(key) else default
m.set(key, value)                    // Update/insert (returns new map)
m.setBy(key, f)                      // Update by function: m.setBy(k, v => v + 1)
m.keys()                             // Set of keys
m.mapBy(keys, k => v)                // Build map from key set
m.put(key, value)                    // Same as set
```

### Temporal (for verification)

```text
always(p)                             // p holds in all states
eventually(p)                         // p holds in some future state
next(p)                               // p holds in the next state
enabled(action)                       // action's guards are satisfied
```

## Run Traces (Tests)

```text
run myTest =
  init
    .then(action1(arg1, arg2))
    .expect(property1)
    .then(action2(arg3))
    .expect(property2)
    .fail()                           // Expect the last action to fail
```

## Common Idioms

```text
// Safe balance lookup (nested map)
pure def getBalance(bals: Address -> (Denom -> int), addr: Address, denom: Denom): int =
  if (bals.contains(addr) and bals.get(addr).contains(denom))
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
