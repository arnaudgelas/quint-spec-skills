# Quint Spells (Reusable Utility Modules)

Spells are reusable Quint modules that provide common utilities. Import them
into your specifications to avoid re-implementing standard patterns.

For syntax-validated runnable counterparts, use `EXECUTABLE-EXAMPLES.md`.

## basicSpells

Core utilities used in most specifications. Adapted from the Quint standard
library and Informal Systems' production specs.

```quint illustrative
module basicSpells {
  /// Require: assertion helper. Returns the condition itself.
  /// Use in guards: `require(amount > 0)`
  pure def require(cond: bool): bool = cond

  /// Maximum of two integers
  pure def max(a: int, b: int): int = if (a >= b) a else b

  /// Minimum of two integers
  pure def min(a: int, b: int): int = if (a <= b) a else b

  /// Absolute value
  pure def abs(x: int): int = if (x >= 0) x else -x

  /// Clamp a value to [lo, hi]
  pure def clamp(x: int, lo: int, hi: int): int = max(lo, min(x, hi))

  /// Remove an element from a set (polymorphic: works for Set[int], Set[str], etc.)
  pure def setRemove(s: Set[a], elem: a): Set[a] =
    s.exclude(Set(elem))

  /// Remove a key from a map (polymorphic: works for any key -> value types)
  pure def mapRemove(m: a -> b, key: a): a -> b =
    m.keys().exclude(Set(key)).mapBy(k => m.get(k))

  /// Map values of a map (polymorphic over key, value, and result types)
  pure def mapValues(m: a -> b, f: b => c): a -> c =
    m.keys().mapBy(k => f(m.get(k)))

  /// Sum of a set of integers
  pure def setSum(s: Set[int]): int = s.fold(0, (acc, x) => acc + x)

  /// Check if a list contains an element (polymorphic)
  pure def listContains(l: List[a], elem: a): bool =
    l.foldl(false, (found, x) => found or x == elem)
}
```

## DeFi Helpers

Common operations for DeFi protocol specifications.

```quint illustrative
module defiSpells {
  /// Safe subtraction: returns 0 if result would be negative
  pure def safeSub(a: int, b: int): int = if (a >= b) a - b else 0

  /// Safe division: returns 0 if divisor is 0
  pure def safeDiv(a: int, b: int): int = if (b == 0) 0 else a / b

  /// Multiply then divide (reduces precision loss)
  pure def mulDiv(a: int, b: int, c: int): int =
    if (c == 0) 0 else (a * b) / c

  /// Multiply then divide, rounding up
  pure def mulDivUp(a: int, b: int, c: int): int =
    if (c == 0) 0
    else {
      val result = a * b
      (result + c - 1) / c
    }

  /// Get balance from nested map with safe defaults
  pure def getBalance(
    balances: str -> (str -> int),
    addr: str,
    denom: str
  ): int =
    if (balances.keys().contains(addr) and balances.get(addr).keys().contains(denom))
      balances.get(addr).get(denom)
    else
      0

  /// Update balance in nested map
  pure def updateBalance(
    balances: str -> (str -> int),
    addr: str,
    denom: str,
    delta: int
  ): str -> (str -> int) = {
    val addrBals = if (balances.keys().contains(addr)) balances.get(addr) else Map()
    val current = if (addrBals.keys().contains(denom)) addrBals.get(denom) else 0
    balances.put(addr, addrBals.put(denom, current + delta))
  }

  /// Transfer between two addresses (returns updated balances)
  pure def transferBalance(
    balances: str -> (str -> int),
    from: str,
    receiver: str,
    denom: str,
    amount: int
  ): str -> (str -> int) =
    balances
      .updateBalance(from, denom, -amount)
      .updateBalance(receiver, denom, amount)

  /// Check if an amount is within tolerance of an expected value
  pure def withinTolerance(actual: int, expected: int, tolerance: int): bool =
    val diff = if (actual >= expected) actual - expected else expected - actual
    diff <= tolerance

  /// Constant product: k = x * y
  pure def constantProduct(x: int, y: int): int = x * y

  /// Calculate swap output for constant product AMM (no fees).
  ///
  /// Guarding only `reserveIn + amountIn == 0` is NOT enough: with an empty input
  /// reserve the formula degenerates to `amountIn * reserveOut / amountIn`, i.e.
  /// the ENTIRE output reserve, for any input. `swapOutput(10, 0, 500) == 500`
  /// drains the pool for dust. A pool with no input liquidity must not trade.
  pure def swapOutput(amountIn: int, reserveIn: int, reserveOut: int): int =
    if (amountIn <= 0 or reserveIn <= 0 or reserveOut <= 0) 0
    else (amountIn * reserveOut) / (reserveIn + amountIn)

  /// Calculate swap output with fee (fee is basis points, e.g., 30 = 0.3%).
  /// Same zero-reserve guard as `swapOutput`; `feeBps` must be a real fraction.
  pure def swapOutputWithFee(
    amountIn: int,
    reserveIn: int,
    reserveOut: int,
    feeBps: int
  ): int =
    val amountInAfterFee = amountIn * (10000 - feeBps)
    if (amountIn <= 0 or reserveIn <= 0 or reserveOut <= 0) 0
    else if (feeBps < 0 or feeBps >= 10000) 0
    else (amountInAfterFee * reserveOut) / (reserveIn * 10000 + amountInAfterFee)
}
```

## Usage

Import spells into your specification modules:

```quint sketch
module MyProtocol {
  import basicSpells.*
  import defiSpells.*

  // Now use: max, min, abs, getBalance, transferBalance, etc.

  action transfer(from: str, receiver: str, denom: str, amount: int): bool = all {
    require(amount > 0),
    getBalance(balances, from, denom) >= amount,
    balances' = transferBalance(balances, from, receiver, denom, amount),
    totalSupply' = totalSupply,
  }
}
```

## Writing Custom Spells

When building spells for your protocol:

1. Use `pure def` -- spells should be stateless functions
2. **Implicit type variables work.** Any lowercase name in a type signature that is
   not a concrete type (`int`, `bool`, `str`) is treated as a free type variable.
   Write `pure def setRemove(s: Set[a], elem: a): Set[a]` and Quint infers `a`
   at each call site.
   **One limitation:** the explicit bracket syntax `pure def f[a](x: a): a` is a
   parse error (`QNT000: extraneous input '['`). Use implicit lowercase names only.
3. Keep them in a separate module for reuse
4. Document the expected behavior and edge cases
5. Test spells independently before using in protocol actions

```quint illustrative
module myCustomSpells {
  /// Calculate weighted average of values with weights.
  ///
  /// The length guard is load-bearing: the fold walks `values` while indexing
  /// `weights.nth(acc.i)`, so a `weights` list shorter than `values` reads past
  /// the end and aborts the whole simulation with
  /// `QNT510: Out of bounds, nth(...)`. Spells are called from guards, so an
  /// unguarded panic here takes down every trace, not just one action.
  pure def weightedAverage(values: List[int], weights: List[int]): int =
    val totalWeight = weights.foldl(0, (sum, w) => sum + w)
    if (values.length() != weights.length()) 0
    else if (totalWeight == 0) 0
    else {
      // Fold over values with an index counter to pair each value with its weight
      val weightedSum = values.foldl({ sum: 0, i: 0 }, (acc, v) =>
        { sum: acc.sum + v * weights.nth(acc.i), i: acc.i + 1 }
      ).sum
      weightedSum / totalWeight
    }
}
```
