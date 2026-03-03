# System Architecture Templates

Templates for modeling multi-component systems, service-oriented architectures, and message-driven communication.

---

## Multi-Service Message Passing

Models a system with multiple services that communicate by sending and receiving messages. This pattern is ideal for microservices, actor systems, or distributed protocols.

```quint illustrative
module MsgTypes {
  type ServiceId = str
  type MsgId = int
  type Payload = str
  type Msg = { id: MsgId, src: ServiceId, dst: ServiceId, payload: Payload }
}

module SystemArch {
  import MsgTypes.*

  const SERVICES: Set[ServiceId]

  var serviceStates: ServiceId -> str
  var inFlightMessages: Set[Msg]
  var msgCounter: MsgId

  action init = all {
    serviceStates' = SERVICES.mapBy(s => "Idle"),
    inFlightMessages' = Set(),
    msgCounter' = 1,
  }

  // Service sends a message
  action sendMsg(src: ServiceId, dst: ServiceId, payload: Payload): bool = all {
    SERVICES.contains(src),
    SERVICES.contains(dst),
    val msg = { id: msgCounter, src: src, dst: dst, payload: payload }
    inFlightMessages' = inFlightMessages.union(Set(msg)),
    msgCounter' = msgCounter + 1,
    serviceStates' = serviceStates.set(src, "Waiting"),
  }

  // Service receives and processes a message
  action receiveMsg(dst: ServiceId): bool = {
    // Nondeterministically pick a message destined for this service
    val myMsgs = inFlightMessages.filter(m => m.dst == dst)
    all {
      myMsgs.size() > 0,
      nondet msg = myMsgs.oneOf()
      all {
        // Simple state update based on message
        serviceStates' = serviceStates.set(dst, "Processing"),
        inFlightMessages' = inFlightMessages.exclude(Set(msg)),
        msgCounter' = msgCounter,
      }
    }
  }

  // Internal service transition
  action internalTransition(s: ServiceId): bool = all {
    serviceStates.get(s) == "Processing",
    serviceStates' = serviceStates.set(s, "Idle"),
    inFlightMessages' = inFlightMessages,
    msgCounter' = msgCounter,
  }

  action step = {
    nondet s1 = SERVICES.oneOf()
    nondet s2 = SERVICES.oneOf()
    any {
      sendMsg(s1, s2, "request"),
      receiveMsg(s1),
      internalTransition(s1),
    }
  }

  // Invariant: If a service is "Waiting", there must be at least one message from it in flight
  // OR it will eventually transition back to "Idle" when its response is processed.
  // (Simplified for this template)
  val waitingHasReason = SERVICES.forall(s =>
    serviceStates.get(s) == "Waiting" implies inFlightMessages.exists(m => m.src == s)
  )
}
```

---

## Shared State with Lock/Mutex

Models a system where multiple processes access shared resources via a locking mechanism.

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
    processState' = processState.set(p, Requesting),
    locks' = locks,
  }

  action acquireLock(p: ProcessId, r: ResourceId): bool = all {
    processState.get(p) == Requesting,
    locks.get(r) == Free,
    locks' = locks.set(r, HeldBy(p)),
    processState' = processState.set(p, Holding),
  }

  action releaseLock(p: ProcessId, r: ResourceId): bool = all {
    processState.get(p) == Holding,
    locks.get(r) == HeldBy(p),
    locks' = locks.set(r, Free),
    processState' = processState.set(p, Idle),
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
}
```
