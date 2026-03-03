# Executable Quint Examples

This file contains **standalone executable** snippets that are validated by CI.
Use these as syntax-accurate references for current Quint releases.

## Counter State Machine

```quint executable
module Counter {
  const MAX: int
  var value: int

  action init = all {
    value' = 0,
  }

  action inc = all {
    value < MAX,
    value' = value + 1,
  }

  action step = any {
    inc,
  }

  val bounded = value >= 0 and value <= MAX
}

module CounterTest {
  import Counter(MAX = 10).*
}
```

## Safe Map Access Helper

```quint executable
module SafeMaps {
  type Key = str
  type Value = int

  pure def getOrDefault(m: Key -> Value, key: Key, default: Value): Value =
    if (m.keys().contains(key)) m.get(key) else default
}
```

## Token Bank with Tuple Keys

```quint executable
module TokenBank {
  type Address = str
  type Denom = str
  type Balances = (Address, Denom) -> int

  pure def balanceOf(bals: Balances, addr: Address, denom: Denom): int =
    if (bals.keys().contains((addr, denom))) bals.get((addr, denom)) else 0

  var balances: Balances

  action init = all {
    balances' = Map(),
  }

  action mint(addr: Address, denom: Denom, amount: int): bool = all {
    amount > 0,
    val oldBalance = balanceOf(balances, addr, denom)
    balances' = balances.set((addr, denom), oldBalance + amount),
  }
}
```

## Nondeterministic Step Pattern

```quint executable
module NondetStep {
  const USERS: Set[str]
  var seen: Set[str]

  action init = all {
    seen' = Set(),
  }

  action touch(user: str): bool = all {
    USERS.contains(user),
    seen' = seen.union(Set(user)),
  }

  action step = {
    nondet user = USERS.oneOf()
    touch(user)
  }

  val seenIsSubset = seen.forall(u => USERS.contains(u))
}

module NondetStepTest {
  import NondetStep(USERS = Set("alice", "bob", "carol")).*
}
```

## Run Trace Example

```quint executable
module CounterTests {
  var value: int

  action init = all {
    value' = 0,
  }

  action inc = all {
    value' = value + 1,
  }

  run smoke =
    init
      .then(inc)
      .expect(value == 1)
}
```
