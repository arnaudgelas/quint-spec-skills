# System Architecture Templates

Templates for modeling multi-component systems, service-oriented architectures, and message-driven communication.

---

## Multi-Service Message Passing

Models a system with multiple services that communicate by sending and receiving messages. This pattern is ideal for microservices, actor systems, or distributed protocols.

<!-- quint-check
main: SystemArchTest
invariants: waitingHasReason
witnesses: witnessNeverWaiting
-->

```quint illustrative
module MsgTypes {
  type ServiceId = str
  type MsgId = int
  type Payload = str
  type MsgKind = Request | Response
  type Msg = { id: MsgId, src: ServiceId, dst: ServiceId, kind: MsgKind, payload: Payload }
}

module SystemArch {
  import MsgTypes.*

  const SERVICES: Set[ServiceId]
  pure val NOBODY: ServiceId = ""

  var serviceStates: ServiceId -> str
  var inFlightMessages: Set[Msg]
  var msgCounter: MsgId
  // Correlation: which requester each processor is currently working for.
  // Without this the model cannot express "someone is handling my request",
  // and any waiting-related invariant is false the moment a request is consumed.
  var processingFor: ServiceId -> ServiceId

  action init = all {
    serviceStates' = SERVICES.mapBy(s => "Idle"),
    inFlightMessages' = Set(),
    msgCounter' = 1,
    processingFor' = SERVICES.mapBy(s => NOBODY),
  }

  action sendRequest(src: ServiceId, dst: ServiceId, payload: Payload): bool =
    val msg = { id: msgCounter, src: src, dst: dst, kind: Request, payload: payload }
    all {
      SERVICES.contains(src), SERVICES.contains(dst), src != dst,
      serviceStates.get(src) == "Idle",
      inFlightMessages' = inFlightMessages.union(Set(msg)),
      msgCounter' = msgCounter + 1,
      serviceStates' = serviceStates.put(src, "Waiting"),
      processingFor' = processingFor,
    }

  action receiveRequest(dst: ServiceId): bool = {
    val myMsgs = inFlightMessages.filter(m => m.dst == dst and m.kind == Request)
    all {
      myMsgs.size() > 0,
      serviceStates.get(dst) == "Idle",
      nondet msg = myMsgs.oneOf()
      all {
        serviceStates' = serviceStates.put(dst, "Processing"),
        inFlightMessages' = inFlightMessages.exclude(Set(msg)),
        msgCounter' = msgCounter,
        processingFor' = processingFor.put(dst, msg.src),
      }
    }
  }

  action respond(p: ServiceId): bool =
    val requester = processingFor.get(p)
    val reply = { id: msgCounter, src: p, dst: requester, kind: Response, payload: "response" }
    all {
      serviceStates.get(p) == "Processing",
      requester != NOBODY,
      serviceStates' = serviceStates.put(p, "Idle"),
      inFlightMessages' = inFlightMessages.union(Set(reply)),
      msgCounter' = msgCounter + 1,
      processingFor' = processingFor.put(p, NOBODY),
    }

  action receiveResponse(s: ServiceId): bool = {
    val myReplies = inFlightMessages.filter(m => m.dst == s and m.kind == Response)
    all {
      myReplies.size() > 0,
      nondet msg = myReplies.oneOf()
      all {
        serviceStates' = serviceStates.put(s, "Idle"),
        inFlightMessages' = inFlightMessages.exclude(Set(msg)),
        msgCounter' = msgCounter,
        processingFor' = processingFor,
      }
    }
  }

  action step = {
    nondet a = SERVICES.oneOf()
    nondet b = SERVICES.oneOf()
    any { sendRequest(a, b, "request"), receiveRequest(a), respond(a), receiveResponse(a) }
  }

  // A Waiting service always has an outstanding reason: its request is still
  // queued, a peer is processing it, or the response is in flight.
  val waitingHasReason = SERVICES.forall(s =>
    serviceStates.get(s) == "Waiting" implies (
      inFlightMessages.exists(m => m.kind == Request and m.src == s)
      or SERVICES.exists(p => processingFor.get(p) == s)
      or inFlightMessages.exists(m => m.kind == Response and m.dst == s)
    ))

  // Witness: Waiting must actually be reachable (violated => reachable).
  val witnessNeverWaiting = SERVICES.forall(s => serviceStates.get(s) != "Waiting")
}

module SystemArchTest {
  import SystemArch(SERVICES = Set("s1", "s2")).*
}
```

> **Why the correlation variable exists.** An earlier version of this template
> asserted `waiting implies inFlightMessages.exists(m => m.src == s)` with no
> `processingFor`. That invariant is violated in **three steps**: s1 sends (now
> Waiting, message in flight), s2 receives (message consumed), and s1 is still
> Waiting with nothing in flight. The model also had no path from `Waiting` back
> to `Idle`, so a waiting service was stuck forever. If a property about waiting
> is what you care about, the model must carry the request/response correlation
> that makes it expressible -- otherwise you are checking a property the model
> cannot satisfy, and a "violation" tells you nothing about the system.

---

## Shared State with Lock/Mutex

Models a system where multiple processes access shared resources via a locking mechanism.

<!-- quint-check
main: SharedResourceTest
invariants: mutualExclusion
witnesses: witnessNeverHeld
-->

```quint illustrative
module LockTypes {
  type ProcessId = str
  type ResourceId = str
  type LockOwner = Free | HeldBy(ProcessId)
  type ProcState = Idle | Requesting | Holding | Releasing
}

module SharedResource {
  import LockTypes.*

  const PROCESSES: Set[ProcessId]
  const RESOURCES: Set[ResourceId]

  var locks: ResourceId -> LockOwner
  var processState: ProcessId -> ProcState

  action init = all {
    locks' = RESOURCES.mapBy(r => Free),
    processState' = PROCESSES.mapBy(p => Idle),
  }

  action requestLock(p: ProcessId, r: ResourceId): bool = all {
    processState.get(p) == Idle,
    processState' = processState.put(p, Requesting),
    locks' = locks,
  }

  action acquireLock(p: ProcessId, r: ResourceId): bool = all {
    processState.get(p) == Requesting,
    locks.get(r) == Free,
    locks' = locks.put(r, HeldBy(p)),
    processState' = processState.put(p, Holding),
  }

  action releaseLock(p: ProcessId, r: ResourceId): bool = all {
    processState.get(p) == Holding,
    locks.get(r) == HeldBy(p),
    locks' = locks.put(r, Free),
    processState' = processState.put(p, Idle),
  }

  action step = {
    nondet p = PROCESSES.oneOf()
    nondet r = RESOURCES.oneOf()
    any {
      requestLock(p, r),
      acquireLock(p, r),
      releaseLock(p, r),
    }
  }

  // Invariant: No two processes hold the same lock
  val mutualExclusion = RESOURCES.forall(r =>
    val holder = locks.get(r)
    match holder {
      | HeldBy(p) => processState.get(p) == Holding
      | Free => true
    }
  )

  // Reachability witness: MUST be violated. Proves a lock is actually acquired --
  // mutualExclusion is trivially true if no lock is ever held.
  val witnessNeverHeld = RESOURCES.forall(r => locks.get(r) == Free)
}
module SharedResourceTest {
  import SharedResource(
    PROCESSES = Set("p1", "p2"),
    RESOURCES = Set("r1"),
  ).*
}
```
