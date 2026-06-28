# Executable Template Modules

These modules are syntax-validated in CI and can be copied directly as
starting points when you need runnable templates.

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

  val noNegativeSupply = totalSupply.keys().forall(d => supplyOf(totalSupply, d) >= 0)
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

  val completedWereApproved = requests.keys().forall(id =>
    requests.get(id).status == Completed implies requests.get(id).approver != ""
  )
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
  var balances: (ChainId, Address, str) -> int
  var nextIntentId: IntentId
  var currentHeight: int

  def bal(chain: ChainId, addr: Address, token: str): int =
    if (balances.keys().contains((chain, addr, token))) balances.get((chain, addr, token)) else 0

  action init = all {
    intents' = Map(),
    status' = Map(),
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
    intents' = intents,
    nextIntentId' = nextIntentId,
    currentHeight' = currentHeight,
  }

  action settleIntent(intentId: IntentId, solver: Address): bool = all {
    status.keys().contains(intentId),
    status.get(intentId) == Filled,
    balances' = balances.put(
      (
        intents.get(intentId).sourceChain,
        solver,
        intents.get(intentId).inputToken,
      ),
      bal(intents.get(intentId).sourceChain, solver, intents.get(intentId).inputToken)
        + intents.get(intentId).inputAmount
    ),
    status' = status.put(intentId, Settled),
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
    intents' = intents,
    nextIntentId' = nextIntentId,
    currentHeight' = currentHeight,
  }

  action advanceHeight = all {
    currentHeight' = currentHeight + 1,
    intents' = intents,
    status' = status,
    balances' = balances,
    nextIntentId' = nextIntentId,
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
  var sourceBalances: (Address, Denom) -> int
  var destBalances: (Address, Denom) -> int
  var nextOrderId: OrderId
  var currentHeight: int

  pure def amountOf(m: (Address, Denom) -> int, addr: Address, denom: Denom): int =
    if (m.keys().contains((addr, denom))) m.get((addr, denom)) else 0

  action init = all {
    orders' = Map(),
    orderStatus' = Map(),
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
    orders' = orders,
    sourceBalances' = sourceBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  action settle(orderId: OrderId, filler: Address): bool = all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Filled,
    sourceBalances' = sourceBalances.put(
      (filler, orders.get(orderId).denom),
      amountOf(sourceBalances, filler, orders.get(orderId).denom) + orders.get(orderId).sourceAmount
    ),
    orderStatus' = orderStatus.put(orderId, Settled),
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
    orders' = orders,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  action advanceHeight = all {
    currentHeight' = currentHeight + 1,
    orders' = orders,
    orderStatus' = orderStatus,
    sourceBalances' = sourceBalances,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
  }
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

  val reservesSolvent = reserve0 >= 0 and reserve1 >= 0
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
```
