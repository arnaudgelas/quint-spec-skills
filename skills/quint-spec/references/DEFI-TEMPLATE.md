# DeFi Protocol Templates

Starter templates for common DeFi protocol patterns. Copy and adapt these as a
starting point for your specification.

For syntax-validated runnable counterparts, use `EXECUTABLE-EXAMPLES.md`.

---

## Token / Balance Accounting (Cosmos Bank Pattern)

The foundation for any protocol that manages token balances.

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
    bals.set(addr, addrBals.set(denom, current + delta))
  }

  action init = all {
    balances' = Map(),
    totalSupply' = Map(),
  }

  action mint(receiver: Address, denom: Denom, amount: Amount): bool = all {
    amount > 0,
    amount <= MAX_AMOUNT,
    balances' = addBalance(balances, receiver, denom, amount),
    totalSupply' = totalSupply.set(denom, getSupply(totalSupply, denom) + amount),
  }

  action burn(from: Address, denom: Denom, amount: Amount): bool = all {
    amount > 0,
    getBalance(balances, from, denom) >= amount,
    balances' = addBalance(balances, from, denom, -amount),
    totalSupply' = totalSupply.set(denom, getSupply(totalSupply, denom) - amount),
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
```

---

## AMM Pool (Constant Product)

Constant product market maker with swap fees.

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
      lpShares' = lpShares.set(user, amountOf(lpShares, user) + newShares),
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
```

---

## ERC-4626 Vault (Share/Asset Conversion)

Tokenized vault with deposit/withdraw and share accounting.

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

  pure def assetsToShares(assets: int, totAssets: int, totShares: int): int =
    if (totAssets == 0) assets
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
      userShares' = userShares.set(user, amountOf(userShares, user) + shares),
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

  // Share accounting: no free tokens from rounding
  val roundingFavorsVault = USERS.forall(user =>
    val s = amountOf(userShares, user)
    val roundTrip = sharesToAssets(assetsToShares(s, totalAssets, totalShares), totalAssets, totalShares)
    // Original shares -> assets -> shares should not gain value
    roundTrip <= s or totalShares == 0
  )

  // Solvency: vault always has enough assets to cover shares
  val vaultSolvent = totalAssets >= 0 and totalShares >= 0
}
```

---

## Lending Position (Health Factor)

Basic lending with collateral, borrowing, and liquidation.

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
    collateral' = collateral.set(user, amountOf(collateral, user) + amount),
    borrows' = borrows,
    oraclePrice' = oraclePrice,
  }

  action borrow(user: Address, amount: int): bool = {
    val newDebt = amountOf(borrows, user) + amount
    val coll = amountOf(collateral, user)
    all {
      amount > 0,
      healthFactor(coll, newDebt, oraclePrice) >= COLLATERAL_FACTOR,
      borrows' = borrows.set(user, newDebt),
      collateral' = collateral,
      oraclePrice' = oraclePrice,
    }
  }

  action liquidate(liquidator: Address, user: Address): bool = {
    val debt = amountOf(borrows, user)
    val coll = amountOf(collateral, user)
    val seizedCollateral = debt * (100 + LIQUIDATION_BONUS) / (oraclePrice * 100)
    all {
      debt > 0,
      healthFactor(coll, debt, oraclePrice) < COLLATERAL_FACTOR,
      seizedCollateral <= coll,
      collateral' = collateral.set(user, coll - seizedCollateral),
      borrows' = borrows.set(user, 0),
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
    totalColl * oraclePrice >= totalDebt * 100 or totalDebt == 0

  // No negative positions
  val noNegativePositions = USERS.forall(u =>
    amountOf(collateral, u) >= 0 and amountOf(borrows, u) >= 0
  )
}
```
