# DeFi Protocol Templates

Starter templates for common DeFi protocol patterns. Copy and adapt these as a
starting point for your specification.

For syntax-validated runnable counterparts, use `EXECUTABLE-EXAMPLES.md`.

---

## Fixed-Point Arithmetic and Scaling

Quint's `int` is mathematically unbounded, but the default `quint run`/`quint test`
backend is Rust/i64 and raises `QNT601` past `2^63-1` with no floating-point or rational
number support. DeFi protocols that work with fractional values (interest rates,
prices, fee percentages) must model them as scaled integers -- the same technique
used in Solidity and most EVM contracts.

**Standard scaling conventions:**

| Precision   | Scale factor | Typical use                           | Safe to simulate?                 |
| ----------- | ------------ | ------------------------------------- | --------------------------------- |
| 2 decimals  | × 100        | Simple percentages                    | yes                               |
| 4 decimals  | × 10,000     | Basis points (30 bps = 0.3% swap fee) | yes                               |
| 6 decimals  | × 10^6       | USDC, most stablecoins                | only for small balances           |
| 18 decimals | × 10^18      | ETH/ERC-20 wei, default Solidity math | **no — overflows i64, see below** |

> **Do not scale by 10^18 in a spec you intend to `quint run` or `quint test`.**
> The default backend is Rust/i64 (max `9223372036854775807`). At 18 decimals, a
> balance of just **10 tokens** is `10^19` and dies before any invariant is
> evaluated:
>
> ```
> action init = { bal' = Map("alice" -> 10 * SCALE) }   // SCALE = 10^18
> → Error [QNT601]: Integer overflow in arithmetic operations: 10 * 1000000000000000000
> ```
>
> Model decimals **abstractly** — use a scale of 100 or 10,000 and a handful of
> tokens. Precision bugs (truncation, rounding direction, share dilution) reproduce
> identically at small scale, and the spec stays runnable. If you genuinely need
> full-width values, use `--backend=typescript` (BigInt) or check with Apalache,
> and state that choice in the spec's Modeling Limits.

**Modeling rules:**

- **Integer division truncates** toward zero -- identical to Solidity's `/`. The
  operation order affects rounding: `(a * b) / c` loses at most 1 unit; `(a / c) * b`
  can lose up to `(c-1) * b / c` units. Always multiply before dividing.
- **Tolerance-based invariants.** Replace `result == expected` with
  `result >= expected - 1 and result <= expected + 1` wherever integer division
  is involved. Use `withinTolerance` from SPELLS.md.
- **Overflow does not model itself.** Quint's `int` is mathematically unbounded, so a
  spec will never reproduce the `2^256` wraparound of a `uint256` implementation --
  you must guard it explicitly, e.g. `amount <= MAX_UINT256 - reserve`, or carry the
  hardware bound as a `const`. Note this is the _modelling_ gap; separately, the
  default Rust/i64 execution backend raises `QNT601` past `2^63-1`, which is a
  _tooling_ limit and not the semantics you are trying to capture. The two are
  independent: guard for the first, keep numbers small for the second.

```quint illustrative
// 0.3% swap fee modeled in basis points (scale = 10,000)
const FEE_BPS: int    // e.g., 30
const BPS_DENOM: int  // e.g., 10000

// Apply fee: multiply first, then divide
pure def applyFee(amount: int): int =
  amount * (BPS_DENOM - FEE_BPS) / BPS_DENOM

// Conservation check: net + fee <= original (integer division may consume 1 unit)
val feeConservation = applyFee(1000) + (1000 * FEE_BPS / BPS_DENOM) <= 1000
```

---

## Token / Balance Accounting (Cosmos Bank Pattern)

The foundation for any protocol that manages token balances.

<!-- quint-check
main: BankTest
invariants: supplyConserved noNegativeBalances noNegativeSupply
-->

```quint illustrative
module BankTypes {
  type Address = str
  type Denom = str
  type Amount = int
  type Balances = Address -> (Denom -> Amount)
}

module Bank {
  import BankTypes.*

  const ADDRESSES: Set[Address]
  const DENOMS: Set[Denom]
  const MAX_AMOUNT: int

  var balances: Balances
  var totalSupply: Denom -> Amount

  pure def getBalance(bals: Balances, addr: Address, denom: Denom): Amount =
    if (bals.keys().contains(addr) and bals.get(addr).keys().contains(denom))
      bals.get(addr).get(denom)
    else
      0

  pure def getSupply(supply: Denom -> Amount, denom: Denom): Amount =
    if (supply.keys().contains(denom)) supply.get(denom) else 0

  pure def addBalance(
    bals: Balances,
    addr: Address,
    denom: Denom,
    delta: Amount,
  ): Balances = {
    val addrBals = if (bals.keys().contains(addr)) bals.get(addr) else Map()
    val current = if (addrBals.keys().contains(denom)) addrBals.get(denom) else 0
    bals.put(addr, addrBals.put(denom, current + delta))
  }

  action init = all {
    balances' = Map(),
    totalSupply' = Map(),
  }

  action mint(receiver: Address, denom: Denom, amount: Amount): bool = all {
    amount > 0,
    amount <= MAX_AMOUNT,
    balances' = addBalance(balances, receiver, denom, amount),
    totalSupply' = totalSupply.put(denom, getSupply(totalSupply, denom) + amount),
  }

  action burn(from: Address, denom: Denom, amount: Amount): bool = all {
    amount > 0,
    getBalance(balances, from, denom) >= amount,
    balances' = addBalance(balances, from, denom, -amount),
    totalSupply' = totalSupply.put(denom, getSupply(totalSupply, denom) - amount),
  }

  action send(from: Address, receiver: Address, denom: Denom, amount: Amount): bool = all {
    amount > 0,
    from != receiver,
    getBalance(balances, from, denom) >= amount,
    balances' = addBalance(addBalance(balances, from, denom, -amount), receiver, denom, amount),
    totalSupply' = totalSupply,
  }

  action step = {
    nondet from = ADDRESSES.oneOf()
    nondet receiver = ADDRESSES.oneOf()
    nondet denom = DENOMS.oneOf()
    nondet amount = 1.to(MAX_AMOUNT).oneOf()
    any {
      mint(from, denom, amount),
      burn(from, denom, amount),
      send(from, receiver, denom, amount),
    }
  }

  // Invariants
  val supplyConserved = DENOMS.forall(d =>
    getSupply(totalSupply, d) ==
      ADDRESSES.fold(0, (sum, addr) => sum + getBalance(balances, addr, d))
  )

  val noNegativeBalances = ADDRESSES.forall(addr =>
    DENOMS.forall(d => getBalance(balances, addr, d) >= 0)
  )

  val noNegativeSupply = DENOMS.forall(d => getSupply(totalSupply, d) >= 0)
}
module BankTest {
  import Bank(
    ADDRESSES = Set("alice", "bob"),
    DENOMS = Set("uatom"),
    MAX_AMOUNT = 20,
  ).*
}
```

---

## AMM Pool (Constant Product)

Constant product market maker with swap fees.

<!-- quint-check
main: AMMTest
invariants: kNonDecreasing reservesSolvent
-->

```quint illustrative
module AMMTypes {
  type Address = str
  type Pool = {
    reserve0: int,
    reserve1: int,
    totalShares: int,
    feeNumerator: int,    // e.g., 3 for 0.3%
    feeDenominator: int,  // e.g., 1000
  }
}

module AMM {
  import AMMTypes.*

  const USERS: Set[Address]
  const MAX_AMOUNT: int

  var pool: Pool
  var lpShares: Address -> int
  var userBalance0: Address -> int
  var userBalance1: Address -> int
  var kFloor: int  // Ghost: minimum k = reserve0 * reserve1 maintained since last liquidity event

  pure def amountOf(bals: Address -> int, addr: Address): int =
    if (bals.keys().contains(addr)) bals.get(addr) else 0

  action init = all {
    pool' = { reserve0: 0, reserve1: 0, totalShares: 0,
              feeNumerator: 3, feeDenominator: 1000 },
    lpShares' = Map(),
    userBalance0' = USERS.mapBy(u => 1000),
    userBalance1' = USERS.mapBy(u => 1000),
    kFloor' = 0,
  }

  // Add liquidity (simplified: proportional deposits)
  // val bindings hoisted before all{} so they are in scope across multiple updates
  action addLiquidity(user: Address, amount0: int, amount1: int): bool = {
    val newShares = if (pool.totalShares == 0) amount0  // First LP
      else amount0 * pool.totalShares / pool.reserve0
    val newReserve0 = pool.reserve0 + amount0
    val newReserve1 = pool.reserve1 + amount1
    all {
      amount0 > 0,
      amount1 > 0,
      amountOf(userBalance0, user) >= amount0,
      amountOf(userBalance1, user) >= amount1,
      newShares > 0,
      pool' = { ...pool,
        reserve0: newReserve0,
        reserve1: newReserve1,
        totalShares: pool.totalShares + newShares },
      lpShares' = lpShares.put(user, amountOf(lpShares, user) + newShares),
      userBalance0' = userBalance0.setBy(user, b => b - amount0),
      userBalance1' = userBalance1.setBy(user, b => b - amount1),
      kFloor' = newReserve0 * newReserve1,
    }
  }

  // Swap token0 for token1
  action swap0For1(user: Address, amountIn: int): bool = {
    val amountInAfterFee = amountIn * (pool.feeDenominator - pool.feeNumerator)
    val amountOut = amountInAfterFee * pool.reserve1 /
      (pool.reserve0 * pool.feeDenominator + amountInAfterFee)
    all {
      amountIn > 0,
      amountOf(userBalance0, user) >= amountIn,
      pool.reserve0 > 0,
      pool.reserve1 > 0,
      amountOut > 0,
      amountOut < pool.reserve1,
      pool' = { ...pool,
        reserve0: pool.reserve0 + amountIn,
        reserve1: pool.reserve1 - amountOut },
      userBalance0' = userBalance0.setBy(user, b => b - amountIn),
      userBalance1' = userBalance1.setBy(user, b => b + amountOut),
      lpShares' = lpShares,
      kFloor' = kFloor,
    }
  }

  action step = {
    nondet user = USERS.oneOf()
    nondet amount = 1.to(MAX_AMOUNT).oneOf()
    nondet amount2 = 1.to(MAX_AMOUNT).oneOf()
    any {
      addLiquidity(user, amount, amount2),
      swap0For1(user, amount),
    }
  }

  // k = reserve0 * reserve1 must never fall below kFloor (set after each liquidity event)
  val kNonDecreasing = pool.reserve0 * pool.reserve1 >= kFloor

  // No negative reserves
  val reservesSolvent = pool.reserve0 >= 0 and pool.reserve1 >= 0
}
module AMMTest {
  import AMM(USERS = Set("alice", "bob"), MAX_AMOUNT = 20).*
}
```

---

## ERC-4626 Vault (Share/Asset Conversion)

Tokenized vault with deposit/withdraw and share accounting.

<!-- quint-check
main: VaultTest
invariants: roundingFavorsVault vaultSolvent
-->

```quint illustrative
module Vault {
  type Address = str

  const USERS: Set[Address]
  const MAX_DEPOSIT: int
  pure val ROUNDING_TOLERANCE = 1

  var totalAssets: int
  var totalShares: int
  var userShares: Address -> int
  var userAssets: Address -> int  // External balances

  pure def amountOf(bals: Address -> int, user: Address): int =
    if (bals.keys().contains(user)) bals.get(user) else 0

  // Both directions must branch on totShares == 0, not just totAssets == 0.
  // If every share is redeemed while residual assets remain (donated dust, or
  // truncation leftovers), then totShares == 0 and totAssets > 0. The naive
  // `assets * totShares / totAssets` then yields 0 for ANY deposit, the
  // `shares > 0` guard fails forever, and the vault is permanently bricked --
  // no one can ever deposit again.
  pure def assetsToShares(assets: int, totAssets: int, totShares: int): int =
    if (totShares == 0 or totAssets == 0) assets   // re-seed 1:1 on an empty vault
    else assets * totShares / totAssets

  pure def sharesToAssets(shares: int, totAssets: int, totShares: int): int =
    if (totShares == 0) 0
    else shares * totAssets / totShares

  action init = all {
    totalAssets' = 0,
    totalShares' = 0,
    userShares' = Map(),
    userAssets' = USERS.mapBy(u => 1000),
  }

  action deposit(user: Address, assets: int): bool =
    val shares = assetsToShares(assets, totalAssets, totalShares)
    all {
      assets > 0,
      amountOf(userAssets, user) >= assets,
      shares > 0,
      totalAssets' = totalAssets + assets,
      totalShares' = totalShares + shares,
      userShares' = userShares.put(user, amountOf(userShares, user) + shares),
      userAssets' = userAssets.setBy(user, a => a - assets),
    }

  action withdraw(user: Address, shares: int): bool =
    val assets = sharesToAssets(shares, totalAssets, totalShares)
    all {
      shares > 0,
      amountOf(userShares, user) >= shares,
      assets > 0,
      totalAssets' = totalAssets - assets,
      totalShares' = totalShares - shares,
      userShares' = userShares.setBy(user, s => s - shares),
      userAssets' = userAssets.setBy(user, a => a + assets),
    }

  action step = {
    nondet user = USERS.oneOf()
    nondet amount = 1.to(MAX_DEPOSIT).oneOf()
    any {
      deposit(user, amount),
      withdraw(user, amount),
    }
  }

  // Share accounting: no free tokens from rounding.
  //
  // Round-trip an ASSET amount: assets -> shares -> assets must never gain.
  // Feeding a SHARE balance into `assetsToShares` (whose first parameter is an
  // asset amount) mixes units and tests nothing meaningful -- the two quantities
  // are only interchangeable at a 1:1 exchange rate, which is precisely the case
  // where rounding bugs cannot appear.
  val roundingFavorsVault = 1.to(MAX_DEPOSIT).forall(assets =>
    val shares = assetsToShares(assets, totalAssets, totalShares)
    val roundTrip = sharesToAssets(shares, totalAssets, totalShares)
    roundTrip <= assets
  )

  // Solvency: vault always has enough assets to cover shares
  val vaultSolvent = totalAssets >= 0 and totalShares >= 0
}
module VaultTest {
  import Vault(USERS = Set("alice", "bob"), MAX_DEPOSIT = 20).*
}
```

---

## Lending Position (Health Factor)

Basic lending with collateral, borrowing, and liquidation.

<!-- quint-check
main: LendingTest
invariants: protocolSolvent noNegativePositions
-->

```quint illustrative
module Lending {
  type Address = str

  const USERS: Set[Address]
  const COLLATERAL_FACTOR: int  // e.g., 150 = 150% collateralization
  const LIQUIDATION_BONUS: int  // e.g., 5 = 5%
  const PRICE_RANGE: Set[int]   // Possible oracle prices

  var collateral: Address -> int
  var borrows: Address -> int
  var oraclePrice: int          // Price of collateral in borrow terms

  pure def amountOf(m: Address -> int, user: Address): int =
    if (m.keys().contains(user)) m.get(user) else 0

  pure def healthFactor(coll: int, debt: int, price: int): int =
    if (debt == 0) 99999  // Healthy if no debt
    else coll * price * 100 / debt

  action init = all {
    collateral' = Map(),
    borrows' = Map(),
    oraclePrice' = 100,
  }

  action depositCollateral(user: Address, amount: int): bool = all {
    amount > 0,
    collateral' = collateral.put(user, amountOf(collateral, user) + amount),
    borrows' = borrows,
    oraclePrice' = oraclePrice,
  }

  action borrow(user: Address, amount: int): bool = {
    val newDebt = amountOf(borrows, user) + amount
    val coll = amountOf(collateral, user)
    all {
      amount > 0,
      healthFactor(coll, newDebt, oraclePrice) >= COLLATERAL_FACTOR,
      borrows' = borrows.put(user, newDebt),
      collateral' = collateral,
      oraclePrice' = oraclePrice,
    }
  }

  action liquidate(liquidator: Address, user: Address): bool = {
    val debt = amountOf(borrows, user)
    val coll = amountOf(collateral, user)
    // Integer division truncates toward zero.  For dust debt relative to asset
    // price (e.g. debt=1, oraclePrice=200, LIQUIDATION_BONUS=5):
    //   1 * 105 / 20000 = 0
    // Without seizedCollateral > 0, a liquidator clears debt while seizing
    // zero collateral -- a well-known dust-debt exploit in DeFi lending.
    val idealSeize = debt * (100 + LIQUIDATION_BONUS) / (oraclePrice * 100)
    // Cap the seizure at the collateral actually available. Writing
    // `idealSeize <= coll` as a GUARD instead would disable liquidation entirely
    // once a position goes deeply underwater -- exactly when liquidation matters
    // most -- and the model would then "prove" solvency only because it forbade
    // the protocol from ever clearing bad debt.
    val seizedCollateral = if (idealSeize > coll) coll else idealSeize
    all {
      debt > 0,
      healthFactor(coll, debt, oraclePrice) < COLLATERAL_FACTOR,
      seizedCollateral > 0,   // prevent zero-collateral debt clearance
      collateral' = collateral.put(user, coll - seizedCollateral),
      // When the seizure was capped, the position was underwater: the shortfall
      // is realised bad debt. A real protocol must socialise or write this off;
      // clearing `borrows` to 0 here silently absorbs it. Model that explicitly
      // if solvency is the property under test.
      borrows' = borrows.put(user, 0),
      oraclePrice' = oraclePrice,
    }
  }

  // Oracle price can change nondeterministically
  action priceChange: bool = {
    nondet newPrice = PRICE_RANGE.oneOf()
    all {
      oraclePrice' = newPrice,
      collateral' = collateral,
      borrows' = borrows,
    }
  }

  action step = {
    nondet user = USERS.oneOf()
    nondet amount = 1.to(100).oneOf()
    nondet liquidator = USERS.oneOf()
    any {
      depositCollateral(user, amount),
      borrow(user, amount),
      liquidate(liquidator, user),
      priceChange,
    }
  }

  // Protocol is always solvent: total collateral value >= total borrows
  val protocolSolvent =
    val totalColl = USERS.fold(0, (sum, u) => sum + amountOf(collateral, u))
    val totalDebt = USERS.fold(0, (sum, u) => sum + amountOf(borrows, u))
    // Units must match the borrow guard. `healthFactor` compares
    // `coll * price * 100 / debt` against COLLATERAL_FACTOR, i.e. it treats debt
    // as a raw amount and collateral as amount x price. Writing
    // `totalColl * oraclePrice >= totalDebt * 100` here instead demands 100x
    // overcollateralization, so the invariant is violated by any ordinary
    // borrow that the guard permits -- alice deposits 21, borrows 60, and the
    // spec reports insolvency on a healthy position.
    totalDebt == 0 or totalColl * oraclePrice >= totalDebt

  // No negative positions
  val noNegativePositions = USERS.forall(u =>
    amountOf(collateral, u) >= 0 and amountOf(borrows, u) >= 0
  )
}
module LendingTest {
  import Lending(
    USERS = Set("alice", "bob"),
    COLLATERAL_FACTOR = 150,
    LIQUIDATION_BONUS = 5,
    PRICE_RANGE = Set(90, 100, 110),
  ).*
}
```
