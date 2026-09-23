---
id: roadmap-01
status: completed
kind: roadmap
title: Ebb Orchestrator Roadmap
summary: Unified roadmap consolidating all stages and plans
created: 2026-09-16
updated: 2026-09-23
---

# Ebb Orchestrator Roadmap

**Version:** Roadmap 01  
**Last Updated:** 2026-09-23  
**Status:** Active

> This document is auto-generated from plan metadata. For manual edits, see [Governance Guide](../architecture/plans/governance/00-01-documentation-governance.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Global Stage Register](#global-stage-register)
3. [Plan Register](#plan-register)
4. [Dependency Graph](#dependency-graph)
5. [Blockers and Evidence](#blockers-and-evidence)
6. [Proposals](#proposals)
7. [Stage 01 Merge Decisions](#stage-01-merge-decisions)
8. [Governance Guide](#governance-guide)

---

## Overview

This roadmap consolidates all stages and plans into a single canonical document. It replaces competing roadmap sources (v1-roadmap.md, post-v1.md, next-stages-roadmap.md) with a unified structure.

See [Stage 01 Merge Decisions](../architecture/plans/governance/08-stage-01-merge-decisions.md) for merge provenance and conflict resolution details.

### Naming Policy

| Term | Meaning | Example |
|------|---------|---------|
| `Stage` | Global executable phase | `Stage 01` |
| `Plan` | Executable document | `Plan 01` |
| `Spec` | Approved design | `Spec 01` |
| `Proposal` | Unapproved direction | See Proposals section |

---

---\n\n<!-- BEGIN GENERATED: roadmap-summary -->\n\n## Global Stage Register

| Stage ID | Status | Title | Summary |
|----------|--------|-------|---------|
| `01` | `completed` | Foundation & Persistence | Backend startup, SQLite migrations, outbox/jobs |
| `02` | `completed` | Domain Workflow Scheduler | Project/Epic/Task lifecycle with FakeAgentRuntime |
| `03` | `completed` | Git Execution Security | Git/worktree, action gateway, permission engine |
| `04` | `in_progress` | Hermes Autonomous Task | Developer→Reviewer→QA→Integration flow |
| `05` | `proposed` | Planning Epics & Context Knowledge | Coordinator, Epic lifecycle, context engine |
| `06` | `proposed` | Web GitHub Release | Web UI, optional GitHub, diagnostics |
| `08` | `in_progress` | Web UI Recovery | Foundation, core functional, operational |
| `09` | `proposed` | Production Readiness | Production build, deployment, monitoring |
| `10` | `planned` | Final V1 Audit Hardening | Security/audit completion |
| `11` | `planned` | Hermes Development Capabilities | Hermes skills and tooling |

### Stage Details

#### Stage 01: Foundation & Persistence
- **Plan:** `../architecture/plans/01-foundation-persistence.md`
- **Status:** completed
- **Evidence:** `docs/audit/01-full-audit.md`

#### Stage 02: Domain Workflow Scheduler
- **Plan:** `../architecture/plans/02-domain-workflow-scheduler.md`
- **Status:** completed
- **Evidence:** `docs/audit/01-full-audit.md`

#### Stage 03: Git Execution Security
- **Plan:** `../architecture/plans/03-git-execution-security.md`
- **Status:** completed
- **Evidence:** `docs/audit/01-full-audit.md`

#### Stage 04: Hermes Autonomous Task
- **Plan:** `../architecture/plans/04-hermes-autonomous-task.md`
- **Status:** in_progress
- **Evidence:** `docs/audit/01-full-audit.md`

#### Stage 05: Planning Epics & Context Knowledge
- **Plan:** `../architecture/plans/05-planning-epics-context-knowledge.md`
- **Status:** proposed
- **Evidence:** N/A (pending approval)

#### Stage 06: Web GitHub Release
- **Plan:** `../architecture/plans/06-web-github-release.md`
- **Status:** proposed
- **Evidence:** N/A (pending approval)

#### Stage 08: Web UI Recovery
- **Plans:** 
  - `../architecture/plans/08-01-web-ui-foundation.md`
  - `../architecture/plans/08-02-web-ui-core-functional.md`
  - `../architecture/plans/08-03-web-ui-operational-and-e2e.md`
  - `../architecture/plans/08-04-web-ui-audit-and-recovery-design.md`
  - `../architecture/plans/12-401-web-completion.md`
- **Status:** in_progress
- **Evidence:** `docs/audit/08-web-ui-code-map.md`, `docs/audit/09-web-ui-gap-analysis.md`

#### Stage 09: Production Readiness
- **Plan:** `../architecture/plans/09-production-readiness.md`
- **Status:** proposed
- **Evidence:** N/A (pending approval)

#### Stage 10: Final V1 Audit Hardening
- **Plan:** `../architecture/plans/10-final-v1-audit-hardening.md`
- **Status:** planned
- **Evidence:** N/A (pending execution)

#### Stage 11: Hermes Development Capabilities
- **Plan:** `../architecture/plans/11-hermes-development-capabilities.md`
- **Status:** planned
- **Evidence:** N/A (pending execution)

---

## Plan Register

| Plan ID | Stage | Status | Title | Link |
|---------|-------|--------|-------|------|
| `01` | `01` | `completed` | Foundation & Persistence | [docs](../architecture/plans/01-foundation-persistence.md) |
| `02` | `02` | `completed` | Domain Workflow Scheduler | [docs](../architecture/plans/02-domain-workflow-scheduler.md) |
| `03` | `03` | `completed` | Git Execution Security | [docs](../architecture/plans/03-git-execution-security.md) |
| `04` | `04` | `in_progress` | Hermes Autonomous Task | [docs](../architecture/plans/04-hermes-autonomous-task.md) |
| `05` | `05` | `proposed` | Planning Epics & Context Knowledge | [docs](../architecture/plans/05-planning-epics-context-knowledge.md) |
| `06` | `06` | `proposed` | Web GitHub Release | [docs](../architecture/plans/06-web-github-release.md) |
| `07` | `07` | `completed` | Hermes Development Workflow | [docs](../architecture/plans/07-hermes-development-workflow.md) |
| `08-01` | `08` | `in_progress` | Web UI Foundation | [docs](../architecture/plans/08-01-web-ui-foundation.md) |
| `08-02` | `08` | `in_progress` | Web UI Core Functional | [docs](../architecture/plans/08-02-web-ui-core-functional.md) |
| `08-03` | `08` | `in_progress` | Web UI Operational & E2E | [docs](../architecture/plans/08-03-web-ui-operational-and-e2e.md) |
| `08-04` | `08` | `in_progress` | Web UI Audit & Recovery Design | [docs](../architecture/plans/08-04-web-ui-audit-and-recovery-design.md) |
| `12` | `08` | `proposed` | Web 401 и завершение проекта | [docs](../architecture/plans/12-401-web-completion.md) |
| `09` | `09` | `proposed` | Production Readiness | [docs](../architecture/plans/09-production-readiness.md) |
| `10` | `10` | `planned` | Final V1 Audit Hardening | [docs](../architecture/plans/10-final-v1-audit-hardening.md) |
| `11` | `11` | `planned` | Hermes Development Capabilities | [docs](../architecture/plans/11-hermes-development-capabilities.md) |

### Governance Plans (Stage 00)

| Plan ID | Title | Link |
|---------|-------|------|
| `00-01` | Documentation Governance | [docs](../architecture/plans/governance/00-01-documentation-governance.md) |
| `00-02` | Agents Policy Review | [docs](../architecture/plans/governance/00-02-agents-policy-review.md) |\n\n<!-- END GENERATED: roadmap-summary -->\n

---

## Dependency Graph

```text
Stage 01 (Foundation)
     ↓
Stage 02 (Domain Workflow)
     ↓
Stage 03 (Git Security)
     ↓
Stage 04 (Hermes Task)
     ↓
Stage 05 (Planning Epics)
     ↓
Stage 06 (Web Release)
     ↓
Stage 07 (Hermes Workflow)
     ↓
Stage 08 (Web UI Recovery)
     ↓
Stage 09 (Production Readiness)
     ↓
Stage 10 (Final Audit)
     ↓
Stage 11 (Hermes Capabilities)
```

### Plan Dependencies

| Plan | Depends On |
|------|------------|
| 01 | None |
| 02 | 01 |
| 03 | 02 |
| 04 | 03 |
| 05 | 04 |
| 06 | 05 |
| 07 | 06 |
| 08 | 07 |
| 09 | 08 |
| 10 | 09 |
| 11 | 10 |

---

## Blockers and Evidence

### Current Blockers

| Blocker ID | Affected Plan | Description | Resolution |
|------------|---------------|-------------|------------|
| `B001` | `04-hermes-autonomous-task` | Hermes skill synchronization pending | Run `pnpm hermes:setup` |
| `B002` | `08-01-web-ui-foundation` | Web UI design approval needed | Await user review |

### Evidence Links

| Evidence ID | Type | Link |
|-------------|------|------|
| `E001` | Full Audit | `docs/audit/01-full-audit.md` |
| `E002` | Audit Report | `docs/audit/02-audit-report.md` |
| `E003` | Guidelines | `docs/audit/03-audit-guidelines.md` |
| `E004` | Final Audit | `docs/audit/04-final-audit.md` |
| `E005` | Web UI Code Map | `docs/audit/08-web-ui-code-map.md` |
| `E006` | Web UI Gap Analysis | `docs/audit/09-web-ui-gap-analysis.md` |
| `E007` | Progress Ledger | `../architecture/plans/governance/evidence/02-progress-ledger.md` |

---

## Proposals

### Proposal 1: Multiple Runtimes
**Description:** Support for multiple AI providers (OpenAI, Anthropic, etc.)  
**Status:** Under review  
**Approval Required:** Yes  
**Link:** `docs/architecture/plans/2026-09-21-hermes-development-capabilities.md`

### Proposal 2: Container Mode
**Description:** Add container-based execution for isolation  
**Status:** Not approved  
**Approval Required:** Yes  
**Link:** `docs/roadmap/post-v1.md`

### Proposal 3: Distributed Execution
**Description:** Multi-worker distributed task execution  
**Status:** Not approved  
**Approval Required:** Yes  
**Link:** `docs/roadmap/post-v1.md`

### Proposal 4: Team Mode
**Description:** Multi-user collaboration with RBAC  
**Status:** Not approved  
**Approval Required:** Yes  
**Link:** `docs/roadmap/post-v1.md`

---
## Stage 01 Merge Decisions

This section documents the consolidation of all v1 roadmap items into the unified Stage 01 document.

### Merge Actions

| Action | Source | Target | Status |
|--------|--------|--------|--------|
| v1 Roadmap Consolidation | `docs/architecture/plans/02-v1-roadmap.md` | `docs/roadmap/01-roadmap.md` | ✅ Verified |
| Post-v1/Next-Stages Migration | `docs/architecture/plans/04-next-stages-roadmap.md` | `docs/roadmap/01-roadmap.md` | ✅ Verified |
| Duplicate Stage Cleanup | N/A | N/A | ✅ No duplicates found |

### Conflict Resolution

| Conflict | Resolution |
|----------|------------|
| Multiple v1 roadmap sources | All content consolidated into canonical roadmap |
| Post-v1/next-stages docs | Merged as proposed/planned stages |
| Duplicate stage declarations | None found in canonical file |

### Provenance

- **Original v1 roadmap:** `docs/architecture/plans/02-v1-roadmap.md` (2026-09-23)
- **Next-stages roadmap:** `docs/architecture/plans/04-next-stages-roadmap.md` (2026-09-23)
- **Canonical target:** `docs/roadmap/01-roadmap.md`
- **Merge date:** 2026-09-23

See [detailed merge decisions](../architecture/plans/governance/08-stage-01-merge-decisions.md) for full documentation.


## Governance Guide

For detailed governance rules, migration procedures, and lifecycle management, see:

- **Main Plan:** [`../architecture/plans/governance/00-01-documentation-governance.md`](../architecture/plans/governance/00-01-documentation-governance.md)
- **Migration Map:** [`../architecture/plans/governance/evidence/document-migration-map.md`](../architecture/plans/governance/evidence/document-migration-map.md)
- **Progress Ledger:** [`../architecture/plans/governance/evidence/02-progress-ledger.md`](../architecture/plans/governance/evidence/02-progress-ledger.md)

### Updating This Document

This roadmap is auto-generated from plan metadata using `pnpm docs:roadmap`. Manual edits to the generated sections will be overwritten. To make changes:

1. Update metadata in individual plan files
2. Run `pnpm docs:roadmap` to regenerate
3. Review changes with `git diff`

---

*Generated on 2026-09-23 from plan metadata.*