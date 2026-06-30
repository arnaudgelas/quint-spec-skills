---
name: quint-spec
description: >
  Build formal Quint specifications to model, test, simulate, and verify
  properties of software systems, distributed protocols, or complex logic. Use
  this skill when a user mentions "quint", "formal spec", "model check",
  "specify protocol", "safety property", "formal state machine", or
  wants to verify system logic with Quint or Apalache.
metadata:
  author: zmanian
  version: 0.2.0
---

# Quint Specification Skill

## Overview

This skill guides you through building formal specifications in **Quint** -- a modern
specification language, originally developed by Informal Systems, that can be
checked with Apalache and TLC. Use this skill to:

- Model system state machines and verify stated safety/liveness properties
- Expose bugs and invalid assumptions in distributed algorithms, business workflows, and protocols
- Find edge cases in message flows, resource allocation, and concurrent systems
- Generate executable test traces from formal models
- Generate bounded evidence of correctness before implementation (full state-space coverage only
  when the state space is finite or an inductive invariant is established)

**When to activate:** User asks to specify, model, model-check, or verify properties
of system logic -- including distributed systems (consensus, messaging), business
processes (workflows, auctions), DeFi (AMMs, lending), or cross-chain interop
(IBC, bridges).

## Prerequisites

```bash
# Reproducible install -- use the version this skill was tested with
# (tracked in skills/quint-spec/references/UPSTREAM.json):
npm install -g @informalsystems/quint@0.32.0

# Verify installation
quint --version

# For formal verification (quint verify), install Apalache:
# Requires JDK 17+
# See: https://apalache-mc.org/docs/apalache/installation/jvm.html
```

> **Reproducibility note:** `@informalsystems/quint@latest` installs whatever is current
> at install time. For formal verification work where trace reproducibility matters, pin
> to the version above or run `npm ci` in the skill repository.

Use `references/TOOLCHAIN.md` for command examples, and prefer the canonical
CLI manual for changing flags/defaults: https://quint.sh/docs/quint

For syntax-validated template modules, see `references/EXECUTABLE-EXAMPLES.md`.

## Workflow

Use these phases as a risk-based workflow, not as ceremony. For small tasks, reach a
minimal executable model quickly and iterate. For protocol reviews, audits, or
implementation-linked work, carry the model through mapping and model-based testing.

**Detailed phase guidelines and worked code examples are in `references/WORKFLOW.md`.**

### Phase 1: System/Protocol Analysis

Extract state, participants, messages, transitions, and properties into a structured
table. Confirm with the user only when requirements are ambiguous or a modeling choice
would materially change the result.

### Phase 2: Domain Modeling

Define sum types for messages/states/errors, records for structured data, and type
aliases for readability. One `Types` module per logical component.

### Phase 3: State Space

Declare `var` (mutable state), `const`/`pure val` (parameters), and `action init`
that sets ALL variables to valid starting values. Frame condition rule: every action
must assign ALL `var` variables.

### Phase 4: Actions

Guard + update pattern: `action name = all { guard, ...updates }`. Use `any { ... }`
for nondeterministic choice in `step`. Use `nondet x = S.oneOf()` for parameter
selection. Use a safe helper (`addBalance`, `setOrDefault`) whenever writing to a map
key that may not exist; `.setBy(key, f)` fails on missing keys.

### Phase 5: Properties

State invariants (`val`): must hold in every reachable state. Temporal properties
(`temporal`): liveness. Always include a false-invariant witness to confirm the model
is not vacuously trivial.

### Phase 6: Testing

`run` traces with `.then()` and `.expect()` chains. Cover happy paths, edge cases,
and error paths. Use `quint test` for deterministic regression suites.

### Phase 7: Verification

Run `quint run` first (fast randomized simulation), then `quint verify` for bounded
model checking via Apalache. **Treat Apalache results as bounded evidence unless you
establish an inductive invariant or use a finite-state/TLC backend.** Do not claim
properties are "proven" from a bounded check alone. See `references/TOOLCHAIN.md`.

### Phase 8: Implementation Mapping

Map Quint types and actions to implementation types and functions. Document the
abstraction gap explicitly: what Quint models that the implementation omits, and vice
versa.

### Phase 9: Model-Based Testing & Differential Fuzzing

Export ITF traces with `--out-itf` and generate test runners for the target stack.
**Generated runners are not verified implementations.** Explicitly document all
state-mapper assumptions (integer overflow, missing-key defaults, type coercions) and
keep generated code in a clearly labeled directory. See `references/MODEL-BASED-TESTING.md`.

### Phase 10: Refinement Modeling (Advanced)

Prove a concrete model implements an abstract one via a refinement mapping. See
`references/ADVANCED-TOPICS.md`.

### Phase 11: Liveness & Fairness (Advanced)

Use `temporal`, `weakFair`, `strongFair`, and `leadsTo` (v0.32.0) for liveness
properties. Verify with `--backend=tlc --temporal=...`. Results are **bounded** by
`--max-steps`. Nondeterminism in `step` is not an economic fairness model or
scheduler guarantee; it is bounded distribution testing under free choice. For
stronger fairness claims, add explicit fairness assumptions. See
`references/ADVANCED-TOPICS.md`.

### Phase 12: Spec-Driven Boilerplate Generation (Advanced)

Convert type-checked Quint types and guards to implementation skeletons. Generated code
is a starting point, not a verified implementation. See `references/ADVANCED-TOPICS.md`.

### Phase 13: Specification Visualization

Generate Mermaid state/sequence diagrams from sum types and action names. See
`references/ADVANCED-TOPICS.md`.

## Domain-Specific Guidance

Read the relevant reference file **before** writing any Quint for the domain:

| Domain               | Key concerns                                                                         | Reference                                                              |
| -------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| General Systems      | State transitions, resource constraints, liveness, concurrency                       | `references/GENERIC-TEMPLATE.md`, `references/SYSTEM-ARCH-TEMPLATE.md` |
| DeFi                 | Balance conservation, rounding/precision, solvency, share accounting                 | `references/DEFI-TEMPLATE.md`                                          |
| Cross-Chain Interop  | Packet lifecycle, exactly-once delivery, timeout, escrow correctness                 | `references/INTEROP-TEMPLATE.md`                                       |
| Intent-Based Systems | Intent lifecycle, constraint satisfaction, solver distribution (bounded), settlement | `references/INTENT-TEMPLATE.md`                                        |

## Common Pitfalls

1. **Missing Frame Conditions** -- Assign `variable' = variable` for every unchanged var.
2. **Vacuously True Invariants** -- Write a false-invariant witness; verify it gets violated.
3. **Overly Constrained Nondeterminism** -- Reduce `nondet` ranges; verify `step` can fire.
4. **Integer Overflow Modeling** -- Add explicit bounds in guards; Quint `int` is unbounded.
5. **Confusing `all` vs `any`** -- `all` = conjunction (must all succeed); `any` = nondeterministic OR.
6. **Forgetting `nondet` in Step** -- Use `nondet x = S.oneOf()` before parameterized actions.
7. **Unsafe Map Access** -- `Map.get(key)` and `.setBy(key, f)` both fail on missing keys.
   Always guard with `.keys().contains(key)` or use a safe `getOrDefault`/`addBalance` helper.

See `references/PATTERNS.md` for 18+ field-tested modeling patterns. Check each
snippet's fence label (`executable`/`illustrative`/`sketch`) before use.

## Modeling Limits

Quint checks the model you write, not the implementation or the real world directly.
Keep these limits explicit in every nontrivial spec:

- **Bounds**: finite sets, ranges, trace depth, and any constants chosen for tractability.
- **Abstractions**: behavior intentionally omitted, such as gas, timing, I/O, failures,
  or cryptography.
- **Fairness**: assumptions needed for liveness, such as messages eventually being
  delivered or enabled actions eventually being scheduled.
- **Refinement gap**: how Quint state/actions map to implementation state/functions, and
  what the mapping does not cover.
