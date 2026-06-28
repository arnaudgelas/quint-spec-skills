# Generic System Templates

Starter templates for modeling general state machines, workflows, and resource allocation. Use these as a starting point for any domain.

For syntax-validated runnable counterparts, use `EXECUTABLE-TEMPLATES.md`.

---

## Generic Stateful Workflow

Models a process that moves through a series of states (e.g., a ticket system, a governance proposal, or a fulfillment pipeline).

```quint sketch
module WorkflowTypes {
  type RequestId = int
  type Status = Pending | Approved | Rejected | InProgress | Completed | Cancelled
  type Request = {
    id: RequestId,
    creator: str,
    status: Status,
    data: str,
    approver: str,
  }
}

module Workflow {
  import WorkflowTypes.*

  const USERS: Set[str]
  const APPROVERS: Set[str]

  var requests: RequestId -> Request
  var nextId: RequestId

  action init = all {
    requests' = Map(),
    nextId' = 1,
  }

  action createRequest(creator: str, data: str): bool = all {
    USERS.contains(creator),
    val req = { id: nextId, creator: creator, status: Pending, data: data, approver: "" }
    requests' = requests.put(nextId, req),
    nextId' = nextId + 1,
  }

  action approveRequest(approver: str, id: RequestId): bool = all {
    APPROVERS.contains(approver),
    requests.keys().contains(id),
    val req = requests.get(id)
    req.status == Pending,
    requests' = requests.put(id, { ...req, status: Approved, approver: approver }),
    nextId' = nextId,
  }

  action startProgress(id: RequestId): bool = all {
    requests.keys().contains(id),
    val req = requests.get(id)
    req.status == Approved,
    requests' = requests.put(id, { ...req, status: InProgress }),
    nextId' = nextId,
  }

  action completeRequest(id: RequestId): bool = all {
    requests.keys().contains(id),
    val req = requests.get(id)
    req.status == InProgress,
    requests' = requests.put(id, { ...req, status: Completed }),
    nextId' = nextId,
  }

  action cancelRequest(id: RequestId): bool = all {
    requests.keys().contains(id),
    val req = requests.get(id)
    req.status != Completed and req.status != Cancelled,
    requests' = requests.put(id, { ...req, status: Cancelled }),
    nextId' = nextId,
  }

  action step = {
    nondet user = USERS.oneOf()
    nondet approver = APPROVERS.oneOf()
    nondet id = requests.keys().oneOf()
    any {
      createRequest(user, "data"),
      approveRequest(approver, id),
      startProgress(id),
      completeRequest(id),
      cancelRequest(id),
    }
  }

  // Invariants
  val idUnique = requests.keys().size() == nextId - 1

  val onlyApproversApprove = requests.keys().forall(id =>
    val req = requests.get(id)
    req.status == Approved implies APPROVERS.contains(req.approver)
  )

  // Temporal: eventually every approved request is either completed or cancelled
  temporal eventuallyTerminal = requests.keys().forall(id =>
    val req = requests.get(id)
    req.status == Approved implies eventually(requests.get(id).status == Completed or requests.get(id).status == Cancelled)
  )
}
```

---

## Generic Resource Allocation

A general pattern for managing any finite resource (CPU, memory, permissions, seats) among participants.

```quint sketch
module ResourceTypes {
  type ResourceId = str
  type Participant = str
  type Allocation = {
    resource: ResourceId,
    owner: Participant,
    amount: int,
  }
}

module ResourceAllocation {
  import ResourceTypes.*

  const RESOURCES: Set[ResourceId]
  const PARTICIPANTS: Set[Participant]
  const TOTAL_CAPACITY: ResourceId -> int

  var currentAllocations: Participant -> (ResourceId -> int)
  var totalAllocated: ResourceId -> int

  action init = all {
    currentAllocations' = Map(),
    totalAllocated' = Map(),
  }

  action allocate(p: Participant, r: ResourceId, amount: int): bool = all {
    amount > 0,
    PARTICIPANTS.contains(p),
    RESOURCES.contains(r),
    val currentTotal = if (totalAllocated.keys().contains(r)) totalAllocated.get(r) else 0
    val capacity = if (TOTAL_CAPACITY.keys().contains(r)) TOTAL_CAPACITY.get(r) else 0
    currentTotal + amount <= capacity,
    val pAlloc = if (currentAllocations.keys().contains(p)) currentAllocations.get(p) else Map()
    val currentAlloc = if (pAlloc.keys().contains(r)) pAlloc.get(r) else 0
    currentAllocations' = currentAllocations.put(p, pAlloc.put(r, currentAlloc + amount)),
    totalAllocated' = totalAllocated.put(r, currentTotal + amount),
  }

  action deallocate(p: Participant, r: ResourceId, amount: int): bool = all {
    amount > 0,
    PARTICIPANTS.contains(p),
    RESOURCES.contains(r),
    val pMap = if (currentAllocations.keys().contains(p)) currentAllocations.get(p) else Map()
    val pAlloc = if (pMap.keys().contains(r)) pMap.get(r) else 0
    val currentTotal = if (totalAllocated.keys().contains(r)) totalAllocated.get(r) else 0
    pAlloc >= amount,
    currentAllocations' = currentAllocations.put(p, pMap.put(r, pAlloc - amount)),
    totalAllocated' = totalAllocated.put(r, currentTotal - amount),
  }

  action step = {
    nondet p = PARTICIPANTS.oneOf()
    nondet r = RESOURCES.oneOf()
    nondet amount = 1.to(10).oneOf()
    any {
      allocate(p, r, amount),
      deallocate(p, r, amount),
    }
  }

  // Invariants
  val capacityRespected = RESOURCES.forall(r =>
    val allocated = if (totalAllocated.keys().contains(r)) totalAllocated.get(r) else 0
    val capacity = if (TOTAL_CAPACITY.keys().contains(r)) TOTAL_CAPACITY.get(r) else 0
    allocated <= capacity
  )

  val totalMatchesSum = RESOURCES.forall(r =>
    val allocated = if (totalAllocated.keys().contains(r)) totalAllocated.get(r) else 0
    allocated == PARTICIPANTS.fold(0, (sum, p) =>
      val pMap = if (currentAllocations.keys().contains(p)) currentAllocations.get(p) else Map()
      sum + if (pMap.keys().contains(r)) pMap.get(r) else 0
    )
  )
}
```
