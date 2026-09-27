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
| `architecture/reference-ui/` | UI concept gallery |
| `roadmap/` | Generated Plan dependency roadmap and historical snapshots |

## Architecture

### Specs (`architecture/specs/`)

Official specifications serving as source of truth:

- `01-system-design.md` — Core architecture
- `02-web-ui-recovery-design.md` — UI recovery plans
- `03-production-readiness-design.md` — Production standards
- `04-hermes-development-capabilities.md` — Hermes integration specs

### Plans (`architecture/plans/`)

Canonical implementation plans live in [`architecture/plans/`](architecture/plans/). Current governance references:

- [`00-01-documentation-governance.md`](architecture/plans/governance/00-01-documentation-governance.md) — Plan metadata and documentation policy
- [`00-05-governance-integration.md`](architecture/plans/governance/00-05-governance-integration.md) — current governance migration
- [`17-ci-runtime-home-and-env-hardening.md`](architecture/plans/17-ci-runtime-home-and-env-hardening.md) — CI, runtime home and local environment hardening

### UI Concepts (`architecture/`)

Conceptual UI designs:
- Dashboard
- Task View
- Epic View
- Approval Inbox
- Execution Queue
- Project View

## Audit

See the [Audit Section](audit/) for current audit records. The [`06-plan-grouping-removal-inventory.md`](architecture/plans/governance/evidence/06-plan-grouping-removal-inventory.md) preserves the baseline and current reconciliation for the Plan-only migration.

## Development

See the [Development Section](development/) for current guidelines, including the [documentation governance guide](development/02-documentation-governance.md) and [JSDoc style guide](development/07-jsdoc-style-guide.md).

## Roadmap

See the [generated Plan roadmap](roadmap/generated.md) for current Plans and dependencies. [`01-roadmap.md`](roadmap/01-roadmap.md) is retained only as a historical snapshot; it is not a current Plan register.

## Reference

See the [UI concept gallery](architecture/reference-ui/), including [Dashboard](architecture/reference-ui/01-dashboard-concept.html), [Task](architecture/reference-ui/02-task-view-concept.html), and [Epic](architecture/reference-ui/03-epic-view-concept.html) concepts.

## Key Links

| Link | Description |
|------|-------------|
| [Governance Guide](development/02-documentation-governance.md) | Documentation standards |
| [System Design](architecture/specs/01-system-design.md) | Core architecture |
| [Generated Plan roadmap](roadmap/generated.md) | Current Plans and dependencies |
|[Audit Report](audit/06-opencode-to-hermes-inventory.md) | Latest audit findings |

## Notes

1. **Architecture source of truth**: `architecture/specs/01-system-design.md`
2. **Canonical generated roadmap**: `roadmap/generated.md`; `roadmap/01-roadmap.md` is a historical snapshot
3. **JSDoc policy**: All production comments in Russian per `development/jsdoc-style-guide.md`
4. **Git policy**: Master branch, feature work in separate worktrees
5. **Quality gates**: Lint, typecheck, and test required before commit
