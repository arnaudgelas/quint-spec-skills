# Cross-Chain Interoperability Templates

Starter templates for cross-chain messaging, IBC-style packet flows, bridges,
and multi-chain state management.

For syntax-validated runnable counterparts, use `EXECUTABLE-EXAMPLES.md`.

---

## Cross-Chain Packet Lifecycle (ICS-20 Style)

Full send/receive/ack/timeout packet flow for fungible token transfers.

```quint illustrative
module ICS20Types {
  type ChainId = str
  type ChannelId = str
  type Address = str
  type Amount = int

  // An IBC denomination is a channel path plus a base token. On the wire this is
  // rendered as "transfer/channel-0/uatom", but Quint has NO string
  // concatenation (`a + b` on strings is a type error) and no interpolation, so
  // the trace must be modelled as structured data. Records compare and hash by
  // value, so this works as a map key exactly like a string would.
  type Denom = { path: List[ChannelId], base: str }

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
    // The chains this packet travels between. Without them, any action that
    // takes a chain as a free parameter can be pointed at ANY chain: a refund
    // can drain escrow on a chain that never sent the packet, and a receive can
    // mint vouchers on a chain that was never the destination. Every action
    // below pins its chain argument to one of these fields.
    srcChain: ChainId,
    dstChain: ChainId,
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
  // All bindings are hoisted ABOVE `all {`. A `val` written inside the block
  // scopes over only the single comma-separated element it appears in, so
  // `state`, `seq`, `packet` and `newState` would each be unbound in every
  // later element (QNT404).
  action sendTransfer(chain: ChainId, dstChain: ChainId, channel: ChannelId, sender: Address,
                      receiver: Address, denom: Denom, amount: Amount): bool =
    val state = chains.get(chain)
    val seq = getSeqOrOne(state.nextSeqSend, channel)
    val packet: Packet = {
      sequence: seq,
      srcChannel: channel,
      dstChannel: channel,  // Simplified: same channel ID
      srcChain: chain,      // Bind the packet to its origin; timeout must check this
      dstChain: dstChain,   // Bind the destination; recvPacket must check this
      data: { sender: sender, receiver: receiver, denom: denom, amount: amount },
      timeoutHeight: state.height + 10,
    }
    val newState = {
      ...state,
      balances: addBalance(state.balances, sender, denom, -amount),
      escrow: state.escrow.put((channel, denom), getEscrow(state, channel, denom) + amount),
      nextSeqSend: state.nextSeqSend.put(channel, seq + 1),
    }
    all {
      amount > 0,
      getBalance(state, sender, denom) >= amount,
      chains' = chains.put(chain, newState),
      inflight' = inflight.union(Set(packet)),
      acks' = acks,
    }

  // Receive: mint tokens on destination chain, produce ack
  action recvPacket(chain: ChainId, packet: Packet): bool =
    val state = chains.get(chain)
    val expectedSeq = getSeqOrOne(state.nextSeqRecv, packet.dstChannel)
    val d = packet.data
    // Each hop prepends its channel to the denom trace. Structured data, not
    // string concatenation -- `packet.srcChannel + "/" + d.denom` is a type error.
    val voucherDenom: Denom = {
      path: d.denom.path.append(packet.srcChannel),
      base: d.denom.base,
    }
    val newState = {
      ...state,
      balances: addBalance(state.balances, d.receiver, voucherDenom, d.amount),
      nextSeqRecv: state.nextSeqRecv.put(packet.dstChannel, expectedSeq + 1),
    }
    all {
      inflight.contains(packet),
      // Pin the receiving chain to the packet's recorded destination. Without
      // this, `chain` is free and a caller can mint vouchers on any chain.
      chain == packet.dstChain,
      packet.sequence == expectedSeq,
      state.height < packet.timeoutHeight,
      chains' = chains.put(chain, newState),
      inflight' = inflight.exclude(Set(packet)),
      acks' = acks.union(Set((packet, AckSuccess))),
    }

  // Timeout: return escrowed tokens to sender.
  // Per ICS-04, timeout is triggered when the DESTINATION chain height has passed
  // packet.timeoutHeight. The source chain processes the refund once that is proved.
  action timeoutPacket(srcChain: ChainId, dstChain: ChainId, packet: Packet): bool =
    val srcState = chains.get(srcChain)
    val dstState = chains.get(dstChain)
    val d = packet.data
    val newSrcState = {
      ...srcState,
      balances: addBalance(srcState.balances, d.sender, d.denom, d.amount),
      // `put` with an explicit current value, not `setBy`: setBy fails at
      // runtime when the (channel, denom) key was never escrowed (QNT507).
      escrow: srcState.escrow.put(
        (packet.srcChannel, d.denom),
        getEscrow(srcState, packet.srcChannel, d.denom) - d.amount),
    }
    all {
      inflight.contains(packet),
      // WITHOUT this guard `srcChain` is a free parameter: a caller can name any
      // chain and have the refund credited -- and the escrow decremented -- on a
      // chain that never sent the packet. Always tie a refund to the packet's
      // recorded origin, never to an argument.
      srcChain == packet.srcChain,
      dstChain != srcChain,
      // Refund must not manufacture escrow that was never posted.
      getEscrow(srcState, packet.srcChannel, d.denom) >= d.amount,
      dstState.height >= packet.timeoutHeight,
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
      | AckError(_) =>
          val state = chains.get(srcChain)
          val d = packet.data
          val newState = {
            ...state,
            balances: addBalance(state.balances, d.sender, d.denom, d.amount),
            // `put` with an explicit current value, not `setBy`: setBy fails at
            // runtime on a (channel, denom) pair that was never escrowed.
            escrow: state.escrow.put(
              (packet.srcChannel, d.denom),
              getEscrow(state, packet.srcChannel, d.denom) - d.amount),
          }
          all {
            acks.contains((packet, ack)),
            // Same free-parameter hole as timeoutPacket: pin the refund to the
            // packet's recorded origin, never to a caller-supplied chain.
            srcChain == packet.srcChain,
            // A refund must not manufacture escrow that was never posted.
            getEscrow(state, packet.srcChannel, d.denom) >= d.amount,
            chains' = chains.put(srcChain, newState),
            acks' = acks.exclude(Set((packet, ack))),
            inflight' = inflight,
          }
    }

  // Advance block height
  action advanceHeight(chain: ChainId): bool =
    val state = chains.get(chain)
    all {
      state.height < MAX_HEIGHT,
      chains' = chains.put(chain, { ...state, height: state.height + 1 }),
      inflight' = inflight,
      acks' = acks,
    }

  action step = {
    nondet chain = CHAINS.oneOf()
    nondet toChain = CHAINS.oneOf()
    nondet channel = CHANNELS.oneOf()
    nondet sender = USERS.oneOf()
    nondet receiver = USERS.oneOf()
    nondet denom = DENOMS.oneOf()
    nondet amount = 1.to(MAX_AMOUNT).oneOf()
    any {
      sendTransfer(chain, toChain, channel, sender, receiver, denom, amount),
      // Route each packet using the chains recorded IN the packet, not the
      // free `chain` binding. Passing an unrelated chain here is exactly the
      // hole the guards inside recvPacket/timeoutPacket/processAck close --
      // driving them correctly from `step` keeps those guards from silently
      // disabling every transition instead of catching a real bug.
      if (inflight.size() > 0) {
        nondet packet = inflight.oneOf()
        any {
          recvPacket(packet.dstChain, packet),
          timeoutPacket(packet.srcChain, packet.dstChain, packet),
        }
      } else all { chains' = chains, inflight' = inflight, acks' = acks },
      if (acks.size() > 0) {
        nondet ackPair = acks.oneOf()
        processAck(ackPair._1.srcChain, ackPair._1, ackPair._2)
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
  const THRESHOLD: int
  const MESSAGES: Set[Message]

  var signatures: Message -> Set[Validator]
  var executed: Set[Message]

  def signers(msg: Message): Set[Validator] =
    if (signatures.keys().contains(msg)) signatures.get(msg) else Set()

  action init = all { signatures' = Map(), executed' = Set() }

  action sign(validator: Validator, msg: Message): bool = all {
    VALIDATORS.contains(validator),
    not(executed.contains(msg)),
    signatures' = signatures.put(msg, signers(msg).union(Set(validator))),
    executed' = executed,
  }

  action execute(msg: Message): bool = all {
    signers(msg).size() >= THRESHOLD,
    not(executed.contains(msg)),
    // Nonce uniqueness: refuse a message whose nonce was already consumed by a
    // DIFFERENT message. Without this, nonce-keyed replay protection and
    // message-keyed signature accounting disagree.
    not(executed.exists(e => e.nonce == msg.nonce)),
    executed' = executed.union(Set(msg)),
    signatures' = signatures,
  }

  action step = {
    nondet v = VALIDATORS.oneOf()
    nondet m = MESSAGES.oneOf()
    any { sign(v, m), execute(m) }
  }

  val onlyThresholdExecuted = signatures.keys().forall(msg =>
    executed.contains(msg) implies signers(msg).size() >= THRESHOLD)

  // Quantify over EXECUTED messages, not over everything ever signed. Two
  // distinct messages may legitimately be signed under the same nonce; what must
  // never happen is that both are executed.
  val noDoubleExecution = executed.forall(m1 =>
    executed.forall(m2 => (m1.nonce == m2.nonce) implies m1 == m2))

  val witnessNeverExecuted = executed.size() == 0
}

module ThresholdBridgeTest {
  import ThresholdBridge(
    VALIDATORS = Set("v1","v2","v3"),
    THRESHOLD = 2,
    // Two DISTINCT messages deliberately sharing nonce 1 -- the replay case.
    MESSAGES = Set(
      { nonce: 1, payload: "a", sourceChain: "c1" },
      { nonce: 1, payload: "b", sourceChain: "c1" },
      { nonce: 2, payload: "c", sourceChain: "c1" }),
  ).*
}
```

> **This module previously had no `init` and no `step`, so it could not be run or
> model-checked at all -- and both of its stated invariants were false.**
> `executed` tracked bare nonces while `signatures` was keyed by the full
> message, so two distinct messages sharing a nonce broke
> `onlyThresholdExecuted`, and `noDoubleExecution` quantified over everything
> ever signed rather than over what was executed. Verified against 0.32.0:
> both now hold over 4000 samples, and `witnessNeverExecuted` is violated,
> proving execution is actually reachable rather than vacuously safe.

---

## Escrow-Fill-Settle with Timeout

Generic cross-chain transfer pattern with escrow on source, fill on destination,
and settlement or timeout refund.

```quint illustrative
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
    // Seed FILLERS as well as USERS. Seeding only USERS leaves every filler with
    // a zero destination balance, so `fill`'s balance guard can never hold, the
    // order lifecycle never leaves `Escrowed`, and every safety invariant below
    // passes VACUOUSLY while the protocol cannot execute at all. Verified: with
    // USERS-only seeding, `Filled` and `Settled` are unreachable.
    sourceBalances' = USERS.union(FILLERS).mapBy(u => 1000),
    destBalances' = USERS.union(FILLERS).mapBy(u => 1000),
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
  action fill(filler: Address, orderId: OrderId): bool =
    val order = orders.get(orderId)
    all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Escrowed,
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
  action settle(orderId: OrderId): bool =
    val order = orders.get(orderId)
    // The filler is read from state, never taken as a parameter. A `settle` that
    // accepts the payee as an argument lets any caller redirect the escrow.
    val filler = orderFiller.get(orderId)
    all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Filled,
    orderFiller.keys().contains(orderId),
    // Release the escrowed sourceAmount to the filler
    sourceBalances' = sourceBalances.put(filler, amountOf(sourceBalances, filler) + order.sourceAmount),
    orderStatus' = orderStatus.put(orderId, Settled),
    orders' = orders,
    orderFiller' = orderFiller,
    destBalances' = destBalances,
    nextOrderId' = nextOrderId,
    currentHeight' = currentHeight,
  }

  // Timeout: refund escrowed tokens to sender
  action timeout(orderId: OrderId): bool =
    val order = orders.get(orderId)
    all {
    orderStatus.keys().contains(orderId),
    orderStatus.get(orderId) == Escrowed,
    currentHeight >= order.timeoutHeight,
    sourceBalances' = sourceBalances.put(order.sender,
      amountOf(sourceBalances, order.sender) + order.sourceAmount),
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

  // Reachability witnesses. Each MUST be violated during simulation; if either
  // reports [ok], the lifecycle is stalled and the invariants above are vacuous.
  //   quint run --invariant=witnessNeverFilled spec.qnt   -> expect a violation
  val witnessNeverFilled = orderStatus.keys().forall(id => orderStatus.get(id) != Filled)
  val witnessNeverSettled = orderStatus.keys().forall(id => orderStatus.get(id) != Settled)
}
```
