---
title: Ebb Orchestrator Documentation
description: Central navigation and index for all documentation
type: documentation-index
version: 1.0
last_updated: 2026-09-23
---

# Ebb Orchestrator Documentation

## Governance

See the [Documentation Governance Guide](development/02-documentation-governance.md) for:
- Numbering conventions (01, 02, 03...)
- Glossary and terminology standards
- File naming policy
- YAML metadata requirements
- Validator rules and compliance checks
- File organization patterns

## Normalized Directories

| Directory | Purpose |
|-----------|---------|
| `architecture/` | Official specs, plans, and UI concepts |
| `audit/` | Audit reports, guidelines, and project state |
| `development/` | Development guidelines and code standards |
| `reference/` | API and implementation reference |
| `roadmap/` | Unified roadmap for all phases |

## Architecture

### Specs (`architecture/specs/`)

Official specifications serving as source of truth:

- `01-system-design.md` — Core architecture
- `02-web-ui-recovery-design.md` — UI recovery plans
- `03-production-readiness-design.md` — Production standards
- `04-hermes-development-capabilities.md` — Hermes integration specs

### Plans (`architecture/plans/`)

Implementation plans aligned with specs:

- `01-documentation-governance.md` — Governance implementation
- `02-v1-roadmap.md` — V1 implementation roadmap
- `02-domain-workflow-scheduler.md` — Domain workflows
- `02-foundation-persistence.md` — Data persistence
- `02-git-execution-security.md` — Security policies
- `02-hermes-autonomous-task.md` — Autonomous task handling
- `02-planning-epics-context-knowledge.md` — Planning structure
- `02-web-github-release.md` — Release process
- `02-final-v1-audit-hardening.md` — Audit hardening
- `03-agents-policy-review.md` — Agent policies
- `03-russian-jsdoc-readme.md` — JSDoc standards

### UI Concepts (`architecture/`)

Conceptual UI designs:
- Dashboard
- Task View
- Epic View
- Approval Inbox
- Execution Queue
- Project View

## Audit

See the [Audit Section](audit/) for:

- `01-final-audit.md` — Final audit execution
- `02-opencode-to-hermes-inventory.md` — Migration inventory
- `03-PROJECT_STATE.md` — Project status
- `2026-09-18-audit-report.md` — Audit findings
- `2026-09-18-audit-guidelines.md` — Audit standards
- `2026-09-18-full-audit.md` — Comprehensive audit process

## Development

See the [Development Section](development/) for:

- `01-architecture-review.md` — Architecture review documentation
- `02-documentation-governance.md` — Governance guidelines
- `jsdoc-style-guide.md` — Comment standards
- `jsdoc-execution-ledger.md` — Compliance tracking
- `hermes.md` — Hermes integration docs

## Roadmap

See the [Unified Roadmap](roadmap/01-roadmap.md) for all phases:

- `01-roadmap.md` — Main roadmap
- `2026-09-21-ecosystem-skills-and-plugins.md` — Ecosystem integration
- `post-v1.md` — Post-V1 planning

## Reference

See the [Reference Section](reference/) for:

- `ui/01-03-ui-spec.md` — UI specifications (Stage A)
- `ui/02-03-ui-spec.md` — UI specifications (Stage B)
- `ui/03-03-ui-spec.md` — UI specifications (Stage C)

## Key Links

| Link | Description |
|------|-------------|
| [Governance Guide](development/02-documentation-governance.md) | Documentation standards |
| [System Design](architecture/specs/01-system-design.md) | Core architecture |
| [Unified Roadmap](roadmap/01-roadmap.md) | Implementation roadmap |
|[Audit Report](audit/06-opencode-to-hermes-inventory.md) | Latest audit findings |

## Notes

1. **Architecture source of truth**: `architecture/specs/01-system-design.md`
2. **Canonical roadmap**: `roadmap/01-roadmap.md`
3. **JSDoc policy**: All production comments in Russian per `development/jsdoc-style-guide.md`
4. **Git policy**: Master branch, feature work in separate worktrees
5. **Quality gates**: Lint, typecheck, and test required before commit
