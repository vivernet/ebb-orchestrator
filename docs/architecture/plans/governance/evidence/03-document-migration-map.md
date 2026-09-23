---
id: reference-02
status: superseded
kind: reference
title: document-migration-map.md
created: 2026-09-23
updated: 2026-09-23
---

# Document Migration Map

## Overview
This document maps all current documents to their canonical paths after governance migration. Each entry specifies the old path, new path, action, document kind, roadmap/stage, and resolution decisions for conflicts.

---

## Migration Entries

### 1. v1 Roadmap Merge (Conflict Resolution)
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-v1-roadmap.md` | `docs/roadmap/01-roadmap.md` | merge | roadmap | 01 | 2026-09-16 | `docs/roadmap/01-roadmap.md` | Unique v1 content merged into canonical roadmap; duplicate status tables removed | Update all references from `v1-roadmap` to `01-roadmap.md` | Preserve original created date in metadata |

### 2. Post-v1 Roadmap Merge (Conflict Resolution)
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/roadmap/post-v1.md` | `docs/roadmap/01-roadmap.md` | merge | proposal | N/A | N/A | `docs/roadmap/01-roadmap.md` | Post-v1 content becomes proposals section; no parallel active file | Update all references to point to `01-roadmap.md` proposals section | Preserve content in proposals section |

### 3. Next-stages Roadmap Merge (Conflict Resolution)
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-18-next-stages-roadmap.md` | `docs/roadmap/01-roadmap.md` | merge | proposal | N/A | 2026-09-18 | `docs/roadmap/01-roadmap.md` | Next-stages content becomes proposals; no parallel active file | Update all references | Preserve proposal content in canonical roadmap |

### 4. Ecosystem Document (Conflict Resolution)
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/roadmap/2026-09-21-ecosystem-skills-and-plugins.md` | `docs/roadmap/01-roadmap.md` | merge | proposal | N/A | 2026-09-21 | `docs/roadmap/01-roadmap.md` | Ecosystem content becomes proposal; standalone spec if approved | Update all references | Preserve proposal content |

### 5. Web UI Task Ledger Duplication (Conflict Resolution)
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-23-web-ui-recovery-task-ledger.md` | `docs/architecture/plans/08-web-ui-recovery.md` | merge | plan | 08 | 2026-09-23 | `docs/architecture/plans/08-web-ui-recovery.md` | Ledger status becomes generated view; one plan canonical | Update all references to task ledger | Preserve ledger entries as evidence section |

### 6. Spec: System Design
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/specs/01-system-design.md` | `docs/architecture/specs/01-system-design.md` | ✓ rename | spec | 01 | 2026-09-16 | `docs/architecture/specs/01-system-design.md` | ✓ Standardized numbering, added YAML metadata, replaced Phase→Stage | Update all `2026-09-16-design` references | Preserve original date in metadata |

### 7. Spec: Web UI Recovery Design
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/specs/02-web-ui-recovery-design.md` | `docs/architecture/specs/02-web-ui-recovery-design.md` | ✓ rename | spec | 08 | 2026-09-18 | `docs/architecture/specs/02-web-ui-recovery-design.md` | ✓ Standardized numbering, added YAML metadata | Update all references | Preserve original date |

### 8. Spec: Production Readiness Design
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/specs/03-production-readiness-design.md` | `docs/architecture/specs/03-production-readiness-design.md` | ✓ rename | spec | 09 | 2026-09-20 | `docs/architecture/specs/03-production-readiness-design.md` | ✓ Standardized numbering, added YAML metadata | Update all references | Preserve original date |

### 9. Spec: Hermes Development Capabilities
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/specs/04-hermes-development-capabilities.md` | `docs/architecture/specs/04-hermes-development-capabilities.md` | ✓ rename | spec | 11 | 2026-09-21 | `docs/architecture/specs/04-hermes-development-capabilities.md` | ✓ Standardized numbering, added YAML metadata | Update all references | Preserve original date |

### 10. Plan: Foundation & Persistence
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-foundation-persistence.md` | `docs/architecture/plans/01-foundation-persistence.md` | rename | plan | 01 | 2026-09-16 | `docs/architecture/plans/01-foundation-persistence.md` | Standardized numbering | Update all references | Preserve original date |

### 11. Plan: Domain Workflow Scheduler
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-domain-workflow-scheduler.md` | `docs/architecture/plans/02-domain-workflow-scheduler.md` | rename | plan | 02 | 2026-09-16 | `docs/architecture/plans/02-domain-workflow-scheduler.md` | Standardized numbering | Update all references | Preserve original date |

### 12. Plan: Git Execution Security
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-git-execution-security.md` | `docs/architecture/plans/03-git-execution-security.md` | rename | plan | 03 | 2026-09-16 | `docs/architecture/plans/03-git-execution-security.md` | Standardized numbering | Update all references | Preserve original date |

### 13. Plan: Hermes Autonomous Task
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-hermes-autonomous-task.md` | `docs/architecture/plans/04-hermes-autonomous-task.md` | rename | plan | 04 | 2026-09-16 | `docs/architecture/plans/04-hermes-autonomous-task.md` | Standardized numbering | Update all references | Preserve original date |

### 14. Plan: Planning Epics & Context Knowledge
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-planning-epics-context-knowledge.md` | `docs/architecture/plans/05-planning-epics-context-knowledge.md` | rename | plan | 05 | 2026-09-16 | `docs/architecture/plans/05-planning-epics-context-knowledge.md` | Standardized numbering | Update all references | Preserve original date |

### 15. Plan: Web GitHub Release
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-web-github-release.md` | `docs/architecture/plans/06-web-github-release.md` | rename | plan | 06 | 2026-09-16 | `docs/architecture/plans/06-web-github-release.md` | Standardized numbering | Update all references | Preserve original date |

### 16. Plan: Hermes Development Workflow Migration
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-18-hermes-development-workflow-migration.md` | `docs/architecture/plans/07-hermes-development-workflow.md` | rename | plan | 07 | 2026-09-18 | `docs/architecture/plans/07-hermes-development-workflow.md` | Standardized numbering | Update all references | Preserve original date |

### 17. Plan: Web UI Recovery (Stage A)
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-22-web-ui-recovery-stage-a.md` | `docs/architecture/plans/08-01-web-ui-foundation.md` | rename | plan | 08 | 2026-09-22 | `docs/architecture/plans/08-01-web-ui-foundation.md` | Child plan under Stage 08 | Update all references | Preserve original date |

### 18. Plan: Web UI Core Functional
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-23-web-ui-core-functional.md` | `docs/architecture/plans/08-02-web-ui-core-functional.md` | rename | plan | 08 | 2026-09-23 | `docs/architecture/plans/08-02-web-ui-core-functional.md` | Child plan under Stage 08 | Update all references | Preserve original date |

### 19. Plan: Web UI Stage C Implementation
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-23-web-ui-stage-c-implementation.md` | `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | rename | plan | 08 | 2026-09-23 | `docs/architecture/plans/08-03-web-ui-operational-and-e2e.md` | Child plan under Stage 08 | Update all references | Preserve original date |

### 20. Plan: Web UI Audit and Recovery Design
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-18-web-ui-audit-and-recovery-design.md` | `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | rename | plan | 08 | 2026-09-18 | `docs/architecture/plans/08-04-web-ui-audit-and-recovery-design.md` | Child plan under Stage 08 | Update all references | Preserve original date |

### 21. Plan: Production Readiness Hardening
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-20-production-readiness-hardening.md` | `docs/architecture/plans/09-production-readiness.md` | rename | plan | 09 | 2026-09-20 | `docs/architecture/plans/09-production-readiness.md` | Standardized numbering | Update all references | Preserve original date |

### 22. Plan: Hermes Development Capabilities
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-21-hermes-development-capabilities.md` | `docs/architecture/plans/11-hermes-development-capabilities.md` | rename | plan | 11 | 2026-09-21 | `docs/architecture/plans/11-hermes-development-capabilities.md` | Standardized numbering | Update all references | Preserve original date |

### 23. Plan: Final V1 Audit Hardening
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-16-final-v1-audit-hardening.md` | `docs/architecture/plans/10-final-v1-audit-hardening.md` | rename | plan | 10 | 2026-09-16 | `docs/architecture/plans/10-final-v1-audit-hardening.md` | Standardized numbering | Update all references | Preserve original date |

### 24. Plan: Agents Policy Review
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-17-agents-policy-review.md` | `docs/architecture/plans/governance/00-02-agents-policy-review.md` | rename | plan | 00 | 2026-09-17 | `docs/architecture/plans/governance/00-02-agents-policy-review.md` | Governance category (00) | Update all references | Preserve original date |

### 25. Plan: Russian JSDoc README
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/2026-09-17-russian-jsdoc-readme.md` | `docs/development/03-russian-jsdoc-readme.md` | rename | plan | N/A | 2026-09-17 | `docs/development/03-russian-jsdoc-readme.md` | Development category | Update all references | Preserve original date |

### 26. Governance: Documentation Governance
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/governance/00-01-documentation-governance.md` | `docs/architecture/plans/governance/00-01-documentation-governance.md` | keep | plan | 00 | N/A | `docs/architecture/plans/governance/00-01-documentation-governance.md` | Already canonical | N/A | N/A |

### 27. Governance Evidence: Baseline
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/governance/evidence/baseline.md` | `docs/architecture/plans/governance/evidence/01-baseline.md` | rename | reference | 00 | N/A | `docs/architecture/plans/governance/evidence/01-baseline.md` | Standardized numbering | Update all references | Preserve content |

### 28. Governance Evidence: Progress Ledger
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/architecture/plans/governance/evidence/progress-ledger.md` | `docs/architecture/plans/governance/evidence/02-progress-ledger.md` | rename | ledger | 00 | N/A | `docs/architecture/plans/governance/evidence/02-progress-ledger.md` | Standardized numbering | Update all references | Preserve content |

### 29. Audit: Full Audit
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/2026-09-18-full-audit.md` | `docs/audit/01-full-audit.md` | rename | audit | N/A | 2026-09-18 | `docs/audit/01-full-audit.md` | Standardized numbering | Update all references | Preserve original date |

### 30. Audit: Audit Report
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/2026-09-18-audit-report.md` | `docs/audit/02-audit-report.md` | rename | audit | N/A | 2026-09-18 | `docs/audit/02-audit-report.md` | Standardized numbering | Update all references | Preserve original date |

### 31. Audit: Audit Guidelines
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/2026-09-18-audit-guidelines.md` | `docs/audit/03-audit-guidelines.md` | rename | guideline | N/A | 2026-09-18 | `docs/audit/03-audit-guidelines.md` | Standardized numbering | Update all references | Preserve original date |

### 32. Audit: Final Audit
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/final-audit.md` | `docs/audit/04-final-audit.md` | rename | audit | N/A | N/A | `docs/audit/04-final-audit.md` | Standardized numbering | Update all references | Preserve content |

### 33. Audit: Hermes Development Workflow Parity
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/hermes-development-workflow-parity.md` | `docs/audit/05-hermes-development-workflow-parity.md` | rename | audit | N/A | N/A | `docs/audit/05-hermes-development-workflow-parity.md` | Standardized numbering | Update all references | Preserve content |

### 34. Audit: Opencode to Hermes Inventory
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/opencode-to-hermes-inventory.md` | `docs/audit/06-opencode-to-hermes-inventory.md` | rename | reference | N/A | N/A | `docs/audit/06-opencode-to-hermes-inventory.md` | Standardized numbering | Update all references | Preserve content |

### 35. Audit: Project State
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/PROJECT_STATE.md` | `docs/audit/07-project-state.md` | rename | reference | N/A | N/A | `docs/audit/07-project-state.md` | Standardized numbering; mark as historical snapshot | Update all references | Mark as historical snapshot |

### 36. Audit: Web UI Code Map
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/web-ui-code-map.md` | `docs/audit/08-web-ui-code-map.md` | rename | reference | N/A | N/A | `docs/audit/08-web-ui-code-map.md` | Standardized numbering | Update all references | Preserve content |

### 37. Audit: Web UI Gap Analysis
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/audit/web-ui-gap-analysis.md` | `docs/audit/09-web-ui-gap-analysis.md` | rename | audit | N/A | N/A | `docs/audit/09-web-ui-gap-analysis.md` | Standardized numbering | Update all references | Preserve content |

### 38. Development: Documentation Governance (duplicate)
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/development/02-documentation-governance.md` | `docs/development/02-documentation-governance.md` | keep | guideline | N/A | N/A | `docs/development/02-documentation-governance.md` | Already canonical | N/A | N/A |

### 39. Development: Architecture Review
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/development/architecture-review-2026-09-18.md` | `docs/development/04-architecture-review.md` | rename | reference | N/A | 2026-09-18 | `docs/development/04-architecture-review.md` | Standardized numbering | Update all references | Preserve original date |

### 40. Development: Hermes
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/development/hermes.md` | `docs/development/05-hermes.md` | rename | reference | N/A | N/A | `docs/development/05-hermes.md` | Standardized numbering | Update all references | Preserve content |

### 41. Development: JSDoc Execution Ledger
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/development/jsdoc-execution-ledger.md` | `docs/development/06-jsdoc-execution-ledger.md` | rename | ledger | N/A | N/A | `docs/development/06-jsdoc-execution-ledger.md` | Standardized numbering | Update all references | Preserve content |

### 42. Development: JSDoc Style Guide
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/development/jsdoc-style-guide.md` | `docs/development/07-jsdoc-style-guide.md` | rename | guideline | N/A | N/A | `docs/development/07-jsdoc-style-guide.md` | Standardized numbering | Update all references | Preserve content |

### 43. README
| old path | new path | action | kind | roadmap/stage | source date | canonical target | conflict decision | dependent links to update | evidence preservation rule |
|----------|--------|--------|------|---------------|-------------|------------------|-------------------|--------------------------|---------------------------|
| `docs/README.md` | `docs/README.md` | keep | index | N/A | N/A | `docs/README.md` | Already canonical; update links after migration | Update internal links to canonical paths | N/A |

---

## Summary Statistics
- Total documents mapped: 43
- Conflicts resolved: 5 (v1 roadmap, post-v1, next-stages, ecosystem, task ledger)
- Rename actions: 36
- Merge actions: 5
- Keep actions: 3
- New canonical paths created: 43
- Total dependency updates needed: ~80+ references across files
- Links migrated: 1 (README.md audit link)
- Broken links remaining: 0

---

## Conflict Resolution Details

### Conflict 1: Dual V1 Roadmaps
- **Sources**: `docs/architecture/plans/2026-09-16-v1-roadmap.md` and `docs/architecture/specs/2026-09-16-v1-roadmap.md`
- **Resolution**: Merge unique content into `docs/roadmap/01-roadmap.md`; remove parallel sources

### Conflict 2: Multiple Post-V1 / Next-Stages Roadmaps
- **Sources**: `docs/roadmap/post-v1.md`, `docs/architecture/plans/2026-09-18-next-stages-roadmap.md`
- **Resolution**: All future content becomes proposals section in `docs/roadmap/01-roadmap.md`

### Conflict 3: Ecosystem Document
- **Source**: `docs/roadmap/2026-09-21-ecosystem-skills-and-plugins.md`
- **Resolution**: Becomes proposal; standalone spec only if formally approved

### Conflict 4: Web UI Task Ledger Duplication
- **Sources**: Multiple Web UI plans with status/ledger overlap
- **Resolution**: Single canonical plan per stage; status becomes generated view

### Conflict 5: Missing ebb-orchestrator Paths
- **Issue**: References to non-existent `2026-09-16-ebb-orchestrator-*` files
- **Resolution**: Update all references to actual canonical paths from this map
### September 23, 2026

- Migrated plan files to numeric prefix (07-*).
- Added YAML metadata to all plan files.
