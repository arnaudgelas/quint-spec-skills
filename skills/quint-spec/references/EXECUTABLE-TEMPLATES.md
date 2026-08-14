# Executable Template Modules

These modules are type-checked in CI and each defines both `init` and `step`, so
they run as-is:

```bash
quint run --main=ExecutableBankTemplate --invariant=noNegativeSupply <file>.qnt
```

The `step` actions pick participants and amounts from small fixed sets so the
templates stay runnable without an instantiating module. Widen those sets, or
replace them with `const` parameters plus an `instance`, once you adapt a
template to your protocol.

## Bank Accounting Core

```quint executable
module ExecutableBankTemplate {
  type Address = str
  type Denom = str
  type Balances = (Address, Denom) -> int

  var balances: Balances
  var totalSupply: Denom -> int

  pure def balanceOf(bals: Balances, addr: Address, denom: Denom): int =
    if (bals.keys().contains((addr, denom))) bals.get((addr, denom)) else 0

  pure def supplyOf(supply: Denom -> int, denom: Denom): int =
    if (supply.keys().contains(denom)) supply.get(denom) else 0

  action init = all {
    balances' = Map(),
    totalSupply' = Map(),
  }

  action mint(receiver: Address, denom: Denom, amount: int): bool = all {
    amount > 0,
    // Bound the mint. `int` is unbounded in the language, but the default Rust
    // backend is i64 and an unbounded mint loop reaches QNT601 overflow.
    amount <= 1000,
    supplyOf(totalSupply, denom) + amount <= 1000000,
    balances' = balances.put((receiver, denom), balanceOf(balances, receiver, denom) + amount),
    totalSupply' = totalSupply.put(denom, supplyOf(totalSupply, denom) + amount),
  }

  action send(from: Address, receiver: Address, denom: Denom, amount: int): bool = all {
    from != receiver,
    amount > 0,
    balanceOf(balances, from, denom) >= amount,
    balances' = balances
      .put((from, denom), balanceOf(balances, from, denom) - amount)
      .put((receiver, denom), balanceOf(balances, receiver, denom) + amount),
    totalSupply' = totalSupply,
  }

  action step = {
    nondet from = Set("alice", "bob").oneOf()
    nondet receiver = Set("alice", "bob").oneOf()
    nondet amount = 1.to(10).oneOf()
    any {
      mint(receiver, "uatom", amount),
      send(from, receiver, "uatom", amount),
    }
  }

  val noNegativeSupply = totalSupply.keys().forall(d => supplyOf(totalSupply, d) >= 0)

  // Conservation: total supply equals the sum of all balances for that denom.
  val supplyMatchesBalances =
    totalSupply.keys().forall(d =>
      supplyOf(totalSupply, d) ==
        balances.keys().filter(k => k._2 == d).fold(0, (sum, k) => sum + balances.get(k)))
}
```

## Stateful Workflow Core

```quint executable
module ExecutableWorkflowTemplate {
  type RequestId = int
  type Status = Pending | Approved | Completed

  type Request = {
    id: RequestId,
    creator: str,
    data: str,
    status: Status,
    approver: str,
  }

  const USERS: Set[str]
  const APPROVERS: Set[str]

  var requests: RequestId -> Request
  var nextId: RequestId

  action init = all {
    requests' = Map(),
    nextId' = 1,
  }

  action create(creator: str, data: str): bool = all {
    USERS.contains(creator),
    requests' = requests.put(nextId, {
      id: nextId,
      creator: creator,
      data: data,
      status: Pending,
      approver: "",
    }),
    nextId' = nextId + 1,
  }

  action approve(id: RequestId, approver: str): bool = all {
    APPROVERS.contains(approver),
    requests.keys().contains(id),
    requests.get(id).status == Pending,
    requests' = requests.put(id, {
      id: requests.get(id).id,
      creator: requests.get(id).creator,
      data: requests.get(id).data,
      status: Approved,
      approver: approver,
    }),
    nextId' = nextId,
  }

  action complete(id: RequestId): bool = all {
    requests.keys().contains(id),
    requests.get(id).status == Approved,
    requests' = requests.put(id, {
      id: requests.get(id).id,
      creator: requests.get(id).creator,
      data: requests.get(id).data,
      status: Completed,
      approver: requests.get(id).approver,
    }),
    nextId' = nextId,
  }

  action step = {
    nondet creator = USERS.oneOf()
    nondet approver = APPROVERS.oneOf()
    any {
      create(creator, "data"),
      all {
        requests.keys().size() > 0,
        nondet id = requests.keys().oneOf()
        any { approve(id, approver), complete(id) },
      },
    }
  }

  val completedWereApproved = requests.keys().forall(id =>
    requests.get(id).status == Completed implies requests.get(id).approver != ""
  )
}

// A module with `const` parameters cannot run on its own -- `quint run` reports
// QNT500 "Uninitialized const". Instantiate it, and point --main at the instance.
module ExecutableWorkflowTemplateTest {
  import ExecutableWorkflowTemplate(
    USERS = Set("u1", "u2"),
    APPROVERS = Set("a1"),
  ).*
}
```

## Intent Lifecycle Core

```quint executable
module ExecutableIntentTemplate {
  type Address = str
  type ChainId = str
  type IntentId = int
  type Status = Pending | Filled | Settled | Expired

  type Intent = {
    id: IntentId,
    creator: Address,
    inputToken: str,
    outputToken: str,
    inputAmount: int,
    minOutput: int,
    sourceChain: ChainId,
    destChain: ChainId,
    deadline: int,
  }

  var intents: IntentId -> Intent
  var status: IntentId -> Status
  // WHO filled each intent. Settlement must pay this address. Without it,
  // settleIntent has to take the payee as a parameter, and then ANY caller can
  // name themselves and walk off with the creator's escrow.
  var intentSolver: IntentId -> Address
  var balances: (ChainId, Address, str) -> int
  var nextIntentId: IntentId
  var currentHeight: int

  def bal(chain: ChainId, addr: Address, token: str): int =
    if (balances.keys().contains((chain, addr, token))) balances.get((chain, addr, token)) else 0

  action init = all {
    intents' = Map(),
    status' = Map(),
    intentSolver' = Map(),
    balances' = Map(),
    nextIntentId' = 1,
    currentHeight' = 1,
  }

  action createIntent(
    creator: Address,
    srcChain: ChainId,
    dstChain: ChainId,
    inputToken: str,
    outputToken: str,
    inputAmount: int,
    minOutput: int,
  ): bool = all {
    inputAmount > 0,
    minOutput > 0,
    bal(srcChain, creator, inputToken) >= inputAmount,
    intents' = intents.put(nextIntentId, {
      id: nextIntentId,
      creator: creator,
      inputToken: inputToken,
      outputToken: outputToken,
      inputAmount: inputAmount,
      minOutput: minOutput,
      sourceChain: srcChain,
      destChain: dstChain,
      deadline: currentHeight + 10,
    }),
    status' = status.put(nextIntentId, Pending),
    intentSolver' = intentSolver,
    balances' = balances.put((srcChain, creator, inputToken), bal(srcChain, creator, inputToken) - inputAmount),
    nextIntentId' = nextIntentId + 1,
    currentHeight' = currentHeight,
  }

  action fillIntent(intentId: IntentId, solver: Address, outputAmount: int): bool = all {
    status.keys().contains(intentId),
    status.get(intentId) == Pending,
    currentHeight < intents.get(intentId).deadline,
    outputAmount >= intents.get(intentId).minOutput,
    bal(intents.get(intentId).destChain, solver, intents.get(intentId).outputToken) >= outputAmount,
    // A solver must not fill its own intent, AND the credit must read the
    // debited map. Two chained puts that both read `balances` alias when
    // solver == creator: the second overwrites the first with the pre-debit
    // value, minting `outputAmount`.
    solver != intents.get(intentId).creator,
    balances' = balances
      .put(
        (intents.get(intentId).destChain, solver, intents.get(intentId).outputToken),
        bal(intents.get(intentId).destChain, solver, intents.get(intentId).outputToken) - outputAmount
      )
      .put(
        (
          intents.get(intentId).destChain,
          intents.get(intentId).creator,
          intents.get(intentId).outputToken,
        ),
        bal(intents.get(intentId).destChain, intents.get(intentId).creator, intents.get(intentId).outputToken)
          + outputAmount
      ),
    status' = status.put(intentId, Filled),
    // Bind the payout to the address that actually delivered.
    intentSolver' = intentSolver.put(intentId, solver),
    intents' = intents,
    nextIntentId' = nextIntentId,
    currentHeight' = currentHeight,
  }

  // NOTE: no `solver` parameter. The payee is read from state, never supplied by
  // the caller -- otherwise settleIntent(id, attacker) drains the escrow.
  action settleIntent(intentId: IntentId): bool = all {
    status.keys().contains(intentId),
    status.get(intentId) == Filled,
    intentSolver.keys().contains(intentId),
    balances' = balances.put(
      (
        intents.get(intentId).sourceChain,
        intentSolver.get(intentId),
        intents.get(intentId).inputToken,
      ),
      bal(intents.get(intentId).sourceChain, intentSolver.get(intentId), intents.get(intentId).inputToken)
        + intents.get(intentId).inputAmount
    ),
    status' = status.put(intentId, Settled),
    intentSolver' = intentSolver,
    intents' = intents,
    nextIntentId' = nextIntentId,
    currentHeight' = currentHeight,
  }

  action expireIntent(intentId: IntentId): bool = all {
    status.keys().contains(intentId),
    status.get(intentId) == Pending,
    currentHeight >= intents.get(intentId).deadline,
    balances' = balances.put(
      (
        intents.get(intentId).sourceChain,
        intents.get(intentId).creator,
        intents.get(intentId).inputToken,
      ),
      bal(
        intents.get(intentId).sourceChain,
        intents.get(intentId).creator,
        intents.get(intentId).inputToken,
      ) + intents.get(intentId).inputAmount
    ),
    status' = status.put(intentId, Expired),
    intentSolver' = intentSolver,
    intents' = intents,
    nextIntentId' = nextIntentId,
    currentHeight' = currentHeight,
  }

  action advanceHeight = all {
    currentHeight' = currentHeight + 1,
    intents' = intents,
    status' = status,
    intentSolver' = intentSolver,
    balances' = balances,
    nextIntentId' = nextIntentId,
  }

  action step = {
    nondet creator = Set("alice", "bob").oneOf()
    nondet solver = Set("solver1", "solver2").oneOf()
    nondet amount = 1.to(10).oneOf()
    any {
      createIntent(creator, "chainA", "chainB", "tokenIn", "tokenOut", amount, amount),
      all {
        status.keys().size() > 0,
        nondet id = status.keys().oneOf()
        any {
          fillIntent(id, solver, amount),
          settleIntent(id),
          expireIntent(id),
        },
      },
      advanceHeight,
    }
  }

  val knownStatuses = status.keys().forall(id =>
    status.get(id) == Pending or status.get(id) == Filled or status.get(id) == Settled or status.get(id) == Expired
  )
}
```

## Escrow / Fill / Settle Core

```quint executable
module ExecutableEscrowFillSettleTemplate {
  type Address = str
  type Denom = str
  type OrderId = int
  type OrderStatus = Escrowed | Filled | Settled | Refunded

  type Order = {
    id: OrderId,
    sender: Address,
    receiver: Address,
    denom: Denom,
    sourceAmount: int,
    destAmount: int,
    timeoutHeight: int,
  }

  var orders: OrderId -> Order
  var orderStatus: OrderId -> OrderStatus
  // WHO filled each order. settle() must pay this address, never a caller-supplied
  // one, or any third party can claim the sender's escrow.
  var orderFiller: OrderId -> Address
  var sourceBalances: (Address, Denom) -> int
  var destBalances: (Address, Denom) -> int
  var nextOrderId: OrderId
  var currentHeight: int

  pure def amountOf(m: (Address, Denom) -> int, addr: Address, denom: Denom): int =
    if (m.keys().contains((addr, denom))) m.get((addr, denom)) else 0

  action init = all {
    orders' = Map(),
    orderStatus' = Map(),
    orderFiller' = Map(),
    sourceBalances' = Map(),
    destBalances' = Map(),
    nextOrderId' = 1,
    currentHeight' = 1,
  }

  action escrow(sender: Address, receiver: Address, denom: Denom, srcAmount: int, dstAmount: int): bool = all {
    srcAmount > 0,
    dstAmount > 0,
    amountOf(sourceBalances, sender, denom) >= srcAmount,
    orders' = orders.put(nextOrderId, {
      id: nextOrderId,
      sender: sender,
      receiver: receiver,
      denom: denom,
      sourceAmount: srcAmount,
      destAmount: dstAmount,
      timeoutHeight: currentHeight + 10,
    }),
    orderStatus' = orderStatus.put(nextOrderId, Escrowed),
    orderFiller' = orderFiller,
    sourceBalances' = sourceBalances.put((sender, denom), amountOf(sourceBalances, sender, denom) - srcAmount),
    destBalances' = destBalances,
    nextOrderId' = nextOrderId + 1,
    currentHeight' = currentHeight,
  }

  action fill(orderId: OrderId, filler: Address): bool = all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Escrowed,
    currentHeight < orders.get(orderId).timeoutHeight,
    amountOf(destBalances, filler, orders.get(orderId).denom) >= orders.get(orderId).destAmount,
    // Without this, filler == receiver makes the two chained puts alias: the
    // credit reads the pre-debit balance and the fill mints destAmount.
    filler != orders.get(orderId).receiver,
    destBalances' = destBalances
      .put(
        (filler, orders.get(orderId).denom),
        amountOf(destBalances, filler, orders.get(orderId).denom) - orders.get(orderId).destAmount
      )
      .put(
        (orders.get(orderId).receiver, orders.get(orderId).denom),
        amountOf(destBalances, orders.get(orderId).receiver, orders.get(orderId).denom)
          + orders.get(orderId).destAmount
      ),
    orderStatus' = orderStatus.put(orderId, Filled),
    // Bind the payout to the address that actually delivered.
    orderFiller' = orderFiller.put(orderId, filler),
    orders' = orders,
    sourceBalances' = sourceBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  // NOTE: no `filler` parameter -- the payee comes from state.
  action settle(orderId: OrderId): bool = all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Filled,
    orderFiller.keys().contains(orderId),
    sourceBalances' = sourceBalances.put(
      (orderFiller.get(orderId), orders.get(orderId).denom),
      amountOf(sourceBalances, orderFiller.get(orderId), orders.get(orderId).denom)
        + orders.get(orderId).sourceAmount
    ),
    orderStatus' = orderStatus.put(orderId, Settled),
    orderFiller' = orderFiller,
    orders' = orders,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  action timeout(orderId: OrderId): bool = all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Escrowed,
    currentHeight >= orders.get(orderId).timeoutHeight,
    sourceBalances' = sourceBalances.put(
      (orders.get(orderId).sender, orders.get(orderId).denom),
      amountOf(sourceBalances, orders.get(orderId).sender, orders.get(orderId).denom)
        + orders.get(orderId).sourceAmount
    ),
    orderStatus' = orderStatus.put(orderId, Refunded),
    orderFiller' = orderFiller,
    orders' = orders,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  action advanceHeight = all {
    currentHeight' = currentHeight + 1,
    orders' = orders,
    orderStatus' = orderStatus,
    orderFiller' = orderFiller,
    sourceBalances' = sourceBalances,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
  }

  action step = {
    nondet sender = Set("alice", "bob").oneOf()
    nondet filler = Set("filler1", "filler2").oneOf()
    nondet amount = 1.to(10).oneOf()
    any {
      escrow(sender, sender, "uatom", amount, amount),
      all {
        orderStatus.keys().size() > 0,
        nondet id = orderStatus.keys().oneOf()
        any { fill(id, filler), settle(id), timeout(id) },
      },
      advanceHeight,
    }
  }

  // Only the address that actually filled an order may be paid on settlement.
  val settledOrdersHaveFiller =
    orderStatus.keys().forall(id =>
      orderStatus.get(id) == Settled implies orderFiller.keys().contains(id))
}
```

## AMM Constant Product Core

```quint executable
module ExecutableAmmTemplate {
  const MAX_AMOUNT: int
  const FEE_NUMERATOR: int
  const FEE_DENOMINATOR: int

  var reserve0: int
  var reserve1: int

  pure def swapOutput(amountIn: int, reserveIn: int, reserveOut: int, feeNum: int, feeDen: int): int =
    amountIn * (feeDen - feeNum) * reserveOut / (reserveIn * feeDen + amountIn * (feeDen - feeNum))

  action init = all {
    reserve0' = 1000,
    reserve1' = 1000,
  }

  action addLiquidity(amount0: int, amount1: int): bool = all {
    amount0 > 0,
    amount1 > 0,
    reserve0' = reserve0 + amount0,
    reserve1' = reserve1 + amount1,
  }

  action swap0For1(amountIn: int): bool = all {
    amountIn > 0,
    amountIn <= MAX_AMOUNT,
    reserve0 > 0,
    reserve1 > 0,
    reserve0 * FEE_DENOMINATOR + amountIn * (FEE_DENOMINATOR - FEE_NUMERATOR) > 0,
    swapOutput(amountIn, reserve0, reserve1, FEE_NUMERATOR, FEE_DENOMINATOR) > 0,
    swapOutput(amountIn, reserve0, reserve1, FEE_NUMERATOR, FEE_DENOMINATOR) < reserve1,
    reserve0' = reserve0 + amountIn,
    reserve1' = reserve1 - swapOutput(amountIn, reserve0, reserve1, FEE_NUMERATOR, FEE_DENOMINATOR),
  }

  action step = {
    nondet amount = 1.to(MAX_AMOUNT).oneOf()
    any {
      addLiquidity(amount, amount),
      swap0For1(amount),
    }
  }

  val reservesSolvent = reserve0 >= 0 and reserve1 >= 0
}

module ExecutableAmmTemplateTest {
  import ExecutableAmmTemplate(
    MAX_AMOUNT = 100,
    FEE_NUMERATOR = 3,
    FEE_DENOMINATOR = 1000,
  ).*
}
```

## Reusable Spells Core

```quint executable
module ExecutableSpellsTemplate {
  type OptionInt = Some(int) | None

  pure def unwrapOr(opt: OptionInt, fallback: int): int =
    match opt {
      | Some(v) => v
      | None => fallback
    }

  pure def absInt(x: int): int = if (x >= 0) x else -x

  pure def clamp(x: int, lo: int, hi: int): int =
    if (x < lo) lo else if (x > hi) hi else x

  pure def getOrDefault(m: str -> int, key: str, fallback: int): int =
    if (m.keys().contains(key)) m.get(key) else fallback

  pure def mapSum(m: str -> int): int =
    m.keys().fold(0, (acc, key) => acc + m.get(key))
}

// This module is a pure function library: it declares no `var`, so it has no
// `init`/`step` and is not runnable by design. Import it from a stateful module.
```
