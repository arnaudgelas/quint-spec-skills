# quint-spec-skill

An AI skill for building formal [Quint](https://quint.sh/) specifications to model, test, simulate, and verify properties of software systems, distributed protocols, and complex stateful logic.

## Overview

When activated, this skill guides an AI agent through a rigorous workflow to build, test, and formally verify system specifications, then bridge the model to actual code where useful:

1.  **System/Protocol Analysis** - Extract state, participants, messages, and transitions.
2.  **Domain Modeling** - Define precise types using sum types, records, and aliases.
3.  **State Space** - Declare variables, initialization, and constants with frame condition discipline.
4.  **Actions** - Build atomic state transitions using the guard + update pattern.
5.  **Properties** - Define invariants (safety) and temporal properties (liveness).
6.  **Testing** - Write executable test traces for scenario validation.
7.  **Verification** - Run simulations and formal model checking via Apalache.
8.  **Implementation Mapping** - Map Quint types and actions to specific implementation code.
9.  **Model-Based Testing & Fuzzing** - Generate test runners to replay Quint traces against the target stack.
10. **Refinement Modeling** - Prove that low-level models correctly implement abstract ones.
11. **Liveness & Fairness** - Prove that something good eventually happens (liveness).
12. **Spec-Driven Boilerplate Generation** - Generate code skeletons (Solidity/Go/Rust) from verified specs.
13. **Specification Visualization** - Auto-generate Mermaid diagrams for documentation.

## Agent Compatibility

This repository is primarily maintained for **Claude Code skill loading**.
Other agent environments may support it, but compatibility can vary by how each tool loads skills and references.

Known integration patterns:

| Agent               | Loading Method                               | Entry Point |
| :------------------ | :------------------------------------------- | :---------- |
| **Claude Code**     | Global or Project-level `skills/` directory  | `SKILL.md`  |
| **Codex**           | Local Codex skills directory                 | `SKILL.md`  |
| **Gemini CLI**      | Tooling-dependent; map skill entry manually  | `SKILL.md`  |
| **Roo Code**        | Tooling-dependent; reference from mode rules | `SKILL.md`  |
| **Cursor/Windsurf** | Tooling-dependent; import via local rules    | `SKILL.md`  |
| **ChatGPT/LLMs**    | Manual copy/adaptation                       | `SKILL.md`  |

## Setup & Installation

### 1. Prerequisites

You must have the Quint toolchain installed on your machine for the agent to run simulations and verification.
Use the canonical CLI manual for command/flag behavior: https://quint.sh/docs/quint

```bash
# Install Quint CLI
npm install -g @informalsystems/quint@latest

# For formal verification: JDK 17+ (Required for Apalache)
# See: https://apalache-mc.org/docs/apalache/installation/jvm.html
```

For repository maintenance, install the pinned local toolchain instead:

```bash
npm ci
```

### 2. Install the Skill

#### For Claude Code

```bash
# Global installation
mkdir -p ~/.claude/skills
cp -r skills/quint-spec ~/.claude/skills/

# Project-specific installation
mkdir -p .claude/skills
cp -r skills/quint-spec .claude/skills/
```

#### For Gemini CLI

Add the `skills` directory to your Gemini CLI configuration and run:

```bash
activate_skill quint-spec
```

#### For Codex

Copy or symlink the whole `skills/quint-spec` directory into the Codex skills directory
for your environment. The reference files are required; `SKILL.md` alone is not enough.

#### For Roo Code / Roo Cline

Reference the whole `skills/quint-spec` directory from mode rules where supported. If
you must paste rules manually, include the required reference files or expect degraded
behavior.

## Triggering the Skill

Mention any of these phrases to your AI agent to activate the workflow:

- _"Write a Quint spec for..."_
- _"Formal spec for this [system/protocol/logic]"_
- _"Prove correctness of [Logic/AMM/Bridge]"_
- _"Model check this state machine"_
- _"Specify the safety properties for..."_
- _"What invariants should this system have?"_
- _"Model this workflow in Quint"_

## Domain Coverage

- **General Systems**: Stateful workflows (pipelines, governance), resource allocation (CPU/Memory/Seats), shared state (locking/mutex), system architecture (message-passing).
- **DeFi**: AMMs (Constant Product, StableSwap), vaults (ERC-4626), lending markets, token accounting.
- **Interoperability**: IBC packet lifecycle, bridges, multi-chain state maps, escrow-fill-settle.
- **Intents**: ERC-7683 lifecycle, solver competition, batch auctions, optimistic verification.

## Repository Features

### Freshness Automation

This repo includes automated drift checks to keep its patterns aligned with upstream Quint releases.

```bash
# Check if references are stale (offline)
npm run upstream:check -- --offline

# Update tracked upstream metadata (requires network)
npm run upstream:update
```

If npm latest has moved past the pinned local `@informalsystems/quint`, bump the dev
dependency first with `npm install --save-dev @informalsystems/quint@<latest>`.

### Snippet Validation

Quint snippets are label-driven:

- ` ```quint executable ` blocks are standalone and validated in CI.
- ` ```quint illustrative ` blocks are self-contained enough for deep typecheck validation.
- ` ```quint sketch ` blocks are partial Quint fragments that are counted but intentionally not typechecked.

```bash
# CI-equivalent validation (standalone executable snippets only)
npm run validate:quint -- --strict-labels

# Stronger executable validation (parse + type/effect checks)
npm run validate:quint:typecheck

# Ensure every reference file declares fence and validation policy
npm run validate:references

# Deep audit: parses all executable and illustrative Quint fences.
# Recommended before release changes to references.
npm run validate:quint:all

# Runtime smoke for executable snippets that define init and step.
npm run validate:quint:runtime
```

## Project Structure

```text
skills/quint-spec/
├── SKILL.md                 # Core skill entry point (Workflow & Rules)
└── references/              # Specialized knowledge base
    ├── LANGUAGE.md          # Quint syntax quick-ref
    ├── PATTERNS.md          # 18+ production-proven design patterns
    ├── GENERIC-TEMPLATE.md  # Workflow & Resource allocation starters
    ├── SYSTEM-ARCH-TEMPLATE.md # Multi-service & Locking starters
    ├── DEFI-TEMPLATE.md     # AMM/Vault/Lending starters
    ├── INTENT-TEMPLATE.md   # ERC-7683 intent lifecycles
    ├── INTEROP-TEMPLATE.md  # IBC/Messaging starters
    ├── MODEL-BASED-TESTING.md # Harness generation and fuzzing guidance
    ├── ADVANCED-TOPICS.md   # Refinement, Liveness, and Forward Engineering
    ├── EXECUTABLE-EXAMPLES.md # CI-validated standalone snippets
    ├── EXECUTABLE-TEMPLATES.md # CI-validated runnable starter modules
    ├── TOOLCHAIN.md         # CLI reference & verification flags
    ├── UPSTREAM.json        # tracked upstream metadata snapshot
    ├── REFERENCE-GOVERNANCE.json # policy for reference-file validation coverage
    └── SPELLS.md            # Common utility modules
```

## References

- [Quint Language](https://quint.sh/)
- [Quint GitHub](https://github.com/informalsystems/quint)
- [Apalache Model Checker](https://apalache-mc.org/)

## License

MIT
