# Cross-Chain Interoperability Templates

Starter templates for cross-chain messaging, IBC-style packet flows, bridges,
and multi-chain state management.

For syntax-validated runnable counterparts, use `EXECUTABLE-EXAMPLES.md`.

---

## Cross-Chain Packet Lifecycle (ICS-20 Style)

Full send/receive/ack/timeout packet flow for fungible token transfers.

```quint sketch
module ICS20Types {
  type ChainId = str
  type ChannelId = str
  type Address = str
  type Denom = str
  type Amount = int

  type PacketData = {
    sender: Address,
    receiver: Address,
    denom: Denom,
    amount: Amount,
  }

  type Packet = {
    sequence: int,
    srcChannel: ChannelId,
    dstChannel: ChannelId,
    data: PacketData,
    timeoutHeight: int,
  }

  type Ack = AckSuccess | AckError(str)

  type ChainState = {
    balances: Address -> (Denom -> int),
    escrow: (ChannelId, Denom) -> int,
    height: int,
    nextSeqSend: ChannelId -> int,
    nextSeqRecv: ChannelId -> int,
  }
}

module ICS20 {
  import ICS20Types.*

  const CHAINS: Set[ChainId]
  const CHANNELS: Set[ChannelId]
  const USERS: Set[Address]
  const DENOMS: Set[Denom]
  const MAX_AMOUNT: int
  const MAX_HEIGHT: int
  // Seed each user's balance so that sendTransfer is reachable from init.
  const INITIAL_BALANCE: int

  var chains: ChainId -> ChainState
  var inflight: Set[Packet]      // Packets sent but not yet received/timed out
  var acks: Set[(Packet, Ack)]   // Acknowledgements pending processing

  pure def getBalance(state: ChainState, addr: Address, denom: Denom): int =
    if (state.balances.keys().contains(addr) and state.balances.get(addr).keys().contains(denom))
      state.balances.get(addr).get(denom)
    else
      0

  pure def getEscrow(state: ChainState, channel: ChannelId, denom: Denom): int =
    if (state.escrow.keys().contains((channel, denom))) state.escrow.get((channel, denom)) else 0

  pure def getSeqOrOne(sequences: ChannelId -> int, channel: ChannelId): int =
    if (sequences.keys().contains(channel)) sequences.get(channel) else 1

  pure def addBalance(
    balances: Address -> (Denom -> int),
    addr: Address,
    denom: Denom,
    delta: int,
  ): Address -> (Denom -> int) = {
    val addrBalances = if (balances.keys().contains(addr)) balances.get(addr) else Map()
    val current = if (addrBalances.keys().contains(denom)) addrBalances.get(denom) else 0
    balances.put(addr, addrBalances.put(denom, current + delta))
  }

  action init = all {
    // Seed user balances so sendTransfer actions are reachable from the initial state.
    chains' = CHAINS.mapBy(c => {
      balances: USERS.mapBy(u => DENOMS.mapBy(d => INITIAL_BALANCE)),
      escrow: Map(),
      height: 1,
      nextSeqSend: Map(),
      nextSeqRecv: Map(),
    }),
    inflight' = Set(),
    acks' = Set(),
  }

  // Send: escrow tokens on source chain, create packet
  action sendTransfer(chain: ChainId, channel: ChannelId, sender: Address,
                      receiver: Address, denom: Denom, amount: Amount): bool = all {
    amount > 0,
    val state = chains.get(chain)
    getBalance(state, sender, denom) >= amount,
    val seq = getSeqOrOne(state.nextSeqSend, channel)
    val packet: Packet = {
      sequence: seq,
      srcChannel: channel,
      dstChannel: channel,  // Simplified: same channel ID
      data: { sender: sender, receiver: receiver, denom: denom, amount: amount },
      timeoutHeight: state.height + 10,
    }
    val newState = {
      ...state,
      balances: addBalance(state.balances, sender, denom, -amount),
      escrow: state.escrow.put((channel, denom), getEscrow(state, channel, denom) + amount),
      nextSeqSend: state.nextSeqSend.put(channel, seq + 1),
    }
    chains' = chains.put(chain, newState),
    inflight' = inflight.union(Set(packet)),
    acks' = acks,
  }

  // Receive: mint tokens on destination chain, produce ack
  action recvPacket(chain: ChainId, packet: Packet): bool = all {
    inflight.contains(packet),
    val state = chains.get(chain)
    val expectedSeq = getSeqOrOne(state.nextSeqRecv, packet.dstChannel)
    packet.sequence == expectedSeq,
    state.height < packet.timeoutHeight,
    // Mint voucher tokens on destination
    val d = packet.data
    val voucherDenom = packet.srcChannel + "/" + d.denom  // IBC denomination
    val newState = {
      ...state,
      balances: addBalance(state.balances, d.receiver, voucherDenom, d.amount),
      nextSeqRecv: state.nextSeqRecv.put(packet.dstChannel, expectedSeq + 1),
    }
    chains' = chains.put(chain, newState),
    inflight' = inflight.exclude(Set(packet)),
    acks' = acks.union(Set((packet, AckSuccess))),
  }

  // Timeout: return escrowed tokens to sender.
  // Per ICS-04, timeout is triggered when the DESTINATION chain height has passed
  // packet.timeoutHeight. The source chain processes the refund once that is proved.
  action timeoutPacket(srcChain: ChainId, dstChain: ChainId, packet: Packet): bool = all {
    inflight.contains(packet),
    val srcState = chains.get(srcChain)
    val dstState = chains.get(dstChain)
    dstState.height >= packet.timeoutHeight,
    // Return escrowed tokens to original sender on the source chain
    val d = packet.data
    val newSrcState = {
      ...srcState,
      balances: addBalance(srcState.balances, d.sender, d.denom, d.amount),
      escrow: srcState.escrow.setBy((packet.srcChannel, d.denom), e => e - d.amount),
    }
    chains' = chains.put(srcChain, newSrcState),
    inflight' = inflight.exclude(Set(packet)),
    acks' = acks,
  }

  // Process acknowledgement: on success escrow remains (backing destination vouchers);
  // on error refund escrowed tokens to the original sender on the source chain.
  action processAck(srcChain: ChainId, packet: Packet, ack: Ack): bool =
    match ack {
      | AckSuccess => all {
          acks.contains((packet, AckSuccess)),
          chains' = chains,
          acks' = acks.exclude(Set((packet, AckSuccess))),
          inflight' = inflight,
        }
      | AckError(_) => all {
          acks.contains((packet, ack)),
          val state = chains.get(srcChain)
          val d = packet.data
          val newState = {
            ...state,
            balances: addBalance(state.balances, d.sender, d.denom, d.amount),
            escrow: state.escrow.setBy((packet.srcChannel, d.denom), e => e - d.amount),
          }
          chains' = chains.put(srcChain, newState),
          acks' = acks.exclude(Set((packet, ack))),
          inflight' = inflight,
        }
    }

  // Advance block height
  action advanceHeight(chain: ChainId): bool = all {
    val state = chains.get(chain)
    state.height < MAX_HEIGHT,
    chains' = chains.put(chain, { ...state, height: state.height + 1 }),
    inflight' = inflight,
    acks' = acks,
  }

  action step = {
    nondet chain = CHAINS.oneOf()
    nondet channel = CHANNELS.oneOf()
    nondet sender = USERS.oneOf()
    nondet receiver = USERS.oneOf()
    nondet denom = DENOMS.oneOf()
    nondet amount = 1.to(MAX_AMOUNT).oneOf()
    any {
      sendTransfer(chain, channel, sender, receiver, denom, amount),
      // Nondeterministically pick a packet to receive or timeout
      if (inflight.size() > 0) {
        nondet packet = inflight.oneOf()
        nondet dstChain = CHAINS.oneOf()
        any {
          recvPacket(chain, packet),
          timeoutPacket(chain, dstChain, packet),
        }
      } else all { chains' = chains, inflight' = inflight, acks' = acks },
      if (acks.size() > 0) {
        nondet ackPair = acks.oneOf()
        processAck(chain, ackPair._1, ackPair._2)
      } else all { chains' = chains, inflight' = inflight, acks' = acks },
      advanceHeight(chain),
    }
  }

  // Every escrowed token on source has a corresponding voucher on destination (or is in-flight)
  val escrowConserved = CHAINS.forall(c =>
    CHANNELS.forall(ch =>
      DENOMS.forall(d =>
        getEscrow(chains.get(c), ch, d) >= 0
      )
    )
  )

  // No two distinct packets with the same (srcChannel, sequence) pair are both acknowledged
  val noDoubleProcessing = acks.forall(pair1 =>
    acks.forall(pair2 =>
      (pair1._1.srcChannel == pair2._1.srcChannel and pair1._1.sequence == pair2._1.sequence)
        implies pair1 == pair2
    )
  )
}
```

---

## Multi-Chain State with Channel Topology

Model a network of chains with explicit channel connections.

```quint illustrative
module ChainNetwork {
  type ChainId = str
  type ChannelEnd = { chainId: ChainId, channelId: str }
  type Connection = { end1: ChannelEnd, end2: ChannelEnd }

  const TOPOLOGY: Set[Connection]

  pure def counterparty(conn: Connection, chain: ChainId): ChannelEnd =
    if (conn.end1.chainId == chain) conn.end2 else conn.end1

  pure def channelsOn(chain: ChainId): Set[str] =
    TOPOLOGY.filter(c => c.end1.chainId == chain).map(c => c.end1.channelId)
      .union(TOPOLOGY.filter(c => c.end2.chainId == chain).map(c => c.end2.channelId))
}
```

---

## Threshold Verification (m-of-n)

Model multi-signature or threshold verification for bridge validators.

```quint illustrative
module ThresholdBridge {
  type Validator = str
  type Message = { nonce: int, payload: str, sourceChain: str }

  const VALIDATORS: Set[Validator]
  const THRESHOLD: int  // m in m-of-n

  var signatures: Message -> Set[Validator]
  var executed: Set[int]  // Nonces of executed messages

  def signers(msg: Message): Set[Validator] =
    if (signatures.keys().contains(msg)) signatures.get(msg) else Set()

  action sign(validator: Validator, msg: Message): bool = all {
    VALIDATORS.contains(validator),
    not(executed.contains(msg.nonce)),
    signatures' = signatures.put(msg, signers(msg).union(Set(validator))),
    executed' = executed,
  }

  action execute(msg: Message): bool = all {
    signers(msg).size() >= THRESHOLD,
    not(executed.contains(msg.nonce)),
    executed' = executed.union(Set(msg.nonce)),
    signatures' = signatures,
  }

  // For messages still tracked in signatures: executed nonces required threshold
  val onlyThresholdExecuted = signatures.keys().forall(msg =>
    executed.contains(msg.nonce) implies signers(msg).size() >= THRESHOLD
  )

  // No two distinct messages with the same nonce are both tracked and executed
  val noDoubleExecution = signatures.keys().forall(m1 =>
    signatures.keys().forall(m2 =>
      (m1.nonce == m2.nonce and executed.contains(m1.nonce)) implies m1 == m2
    )
  )
}
```

---

## Escrow-Fill-Settle with Timeout

Generic cross-chain transfer pattern with escrow on source, fill on destination,
and settlement or timeout refund.

```quint sketch
module EscrowFillSettle {
  type Address = str
  type OrderId = int

  type Order = {
    id: OrderId,
    sender: Address,
    receiver: Address,
    sourceAmount: int,
    destAmount: int,
    timeoutHeight: int,
  }

  type OrderStatus = Escrowed | Filled | Settled | Refunded

  const USERS: Set[Address]
  const FILLERS: Set[Address]
  const MAX_AMOUNT: int

  var orders: OrderId -> Order
  var orderStatus: OrderId -> OrderStatus
  var orderFiller: OrderId -> Address  // Records who filled each order (set by fill action)
  var sourceBalances: Address -> int
  var destBalances: Address -> int
  var nextOrderId: int
  var currentHeight: int

  pure def amountOf(m: Address -> int, user: Address): int =
    if (m.keys().contains(user)) m.get(user) else 0

  pure def addAmount(m: Address -> int, user: Address, delta: int): Address -> int =
    m.put(user, amountOf(m, user) + delta)

  action init = all {
    orders' = Map(),
    orderStatus' = Map(),
    orderFiller' = Map(),
    sourceBalances' = USERS.mapBy(u => 1000),
    destBalances' = USERS.mapBy(u => 1000),
    nextOrderId' = 1,
    currentHeight' = 1,
  }

  // Step 1: User escrows tokens on source chain
  action escrow(sender: Address, receiver: Address, srcAmt: int, dstAmt: int): bool = all {
    srcAmt > 0,
    dstAmt > 0,
    amountOf(sourceBalances, sender) >= srcAmt,
    val order: Order = {
      id: nextOrderId, sender: sender, receiver: receiver,
      sourceAmount: srcAmt, destAmount: dstAmt,
      timeoutHeight: currentHeight + 10,
    }
    orders' = orders.put(nextOrderId, order),
    orderStatus' = orderStatus.put(nextOrderId, Escrowed),
    orderFiller' = orderFiller,
    sourceBalances' = sourceBalances.setBy(sender, b => b - srcAmt),
    destBalances' = destBalances,
    nextOrderId' = nextOrderId + 1,
    currentHeight' = currentHeight,
  }

  // Step 2: Filler delivers tokens on destination chain
  action fill(filler: Address, orderId: OrderId): bool = all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Escrowed,
    val order = orders.get(orderId)
    currentHeight < order.timeoutHeight,
    amountOf(destBalances, filler) >= order.destAmount,
    destBalances' = addAmount(
      addAmount(destBalances, filler, -order.destAmount),
      order.receiver,
      order.destAmount,
    ),
    orderStatus' = orderStatus.put(orderId, Filled),
    orderFiller' = orderFiller.put(orderId, filler),  // Record who filled this order
    // Frame conditions
    orders' = orders,
    sourceBalances' = sourceBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  // Step 3: Settlement releases escrowed tokens to the filler on source chain
  action settle(orderId: OrderId): bool = all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Filled,
    orderFiller.keys().contains(orderId),
    val order = orders.get(orderId)
    val filler = orderFiller.get(orderId)
    // Release the escrowed sourceAmount to the filler
    sourceBalances' = sourceBalances.setBy(filler, b => b + order.sourceAmount),
    orderStatus' = orderStatus.put(orderId, Settled),
    orders' = orders,
    orderFiller' = orderFiller,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  // Timeout: refund escrowed tokens to sender
  action timeout(orderId: OrderId): bool = all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Escrowed,
    val order = orders.get(orderId)
    currentHeight >= order.timeoutHeight,
    sourceBalances' = sourceBalances.setBy(order.sender, b =>
      b + order.sourceAmount),
    orderStatus' = orderStatus.put(orderId, Refunded),
    orders' = orders,
    orderFiller' = orderFiller,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  action advanceHeight: bool = all {
    currentHeight' = currentHeight + 1,
    orders' = orders,
    orderStatus' = orderStatus,
    orderFiller' = orderFiller,
    sourceBalances' = sourceBalances,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
  }

  action step = {
    nondet user = USERS.oneOf()
    nondet receiver = USERS.oneOf()
    nondet filler = FILLERS.oneOf()
    nondet amount = 1.to(MAX_AMOUNT).oneOf()
    nondet amount2 = 1.to(MAX_AMOUNT).oneOf()
    any {
      escrow(user, receiver, amount, amount2),
      if (orders.keys().size() > 0) {
        nondet orderId = orders.keys().oneOf()
        any {
          fill(filler, orderId),
          settle(orderId),
          timeout(orderId),
        }
      } else all {
        orders' = orders, orderStatus' = orderStatus, orderFiller' = orderFiller,
        sourceBalances' = sourceBalances, destBalances' = destBalances,
        nextOrderId' = nextOrderId, currentHeight' = currentHeight,
      },
      advanceHeight,
    }
  }

  // Every escrowed order eventually settles or refunds
  val noStuckOrders = orders.keys().forall(id =>
    val status = orderStatus.get(id)
    status == Escrowed or status == Filled or status == Settled or status == Refunded
  )

  // No negative balances
  val noNegativeBalances =
    USERS.forall(u => amountOf(sourceBalances, u) >= 0) and
    USERS.forall(u => amountOf(destBalances, u) >= 0)
}
```
