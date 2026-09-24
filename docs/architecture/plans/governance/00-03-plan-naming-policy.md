---
id: plan-00-03
kind: plan
roadmap: 01
stage: 00
status: completed
title: Naming Convention for Implementation Plans
created: 2026-09-18
updated: 2026-09-24
depends_on:
specs:
  - ../specs/01-system-design.md
evidence: []
---

# Policy: Naming Convention for Implementation Plans

## Purpose
Ensure all implementation plans follow project-established naming conventions and are properly tracked in the roadmap.

## Naming Pattern
All plan files in `docs/architecture/plans/` must follow:

| Pattern | Example | Notes |
|---------|---------|-------|
| `XX-name.md` | `01-foundation-persistence.md` | Primary plans |
| `XX-YY-name.md` | `08-01-web-ui-foundation.md` | Sub-plans within a stage |

**Do NOT use:**
- `YYYY-MM-DD-name.md` (this is the default from writing-plans skill, not used in Ebb)
- UUID-based names
- Unnumbered names

## Frontmatter Requirements
Every plan file must start with YAML frontmatter:

```yaml
---
id: plan-XX
kind: plan
roadmap: 01
stage: XX
status: proposed|in_progress|completed
title: Plan Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
depends_on:
  - plan-XX-YY
specs:
  - ../specs/01-system-design.md
evidence: []
---
```

## Plan Registration
After creating a plan:

1. Update `docs/roadmap/01-roadmap.md`:
   - Add to Stage section under appropriate stage
   - Add row to Plan Register table

2. Update `docs/architecture/plans/governance/evidence/02-progress-ledger.md` (if exists)

## Subagent Instructions
When creating a new plan as a subagent:

1. Check existing files in `docs/architecture/plans/` to determine next available XX number
2. For sub-plans within a stage, use XX-YY pattern (e.g., 08-01, 08-02)
3. Add proper frontmatter as shown above
4. Update roadmap to include the new plan
5. Commit with: `feat: add plan XX-title`