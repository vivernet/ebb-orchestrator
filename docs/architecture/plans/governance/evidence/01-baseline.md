---
id: reference-01
kind: reference
title: 01-baseline.md
created: 2026-09-23
updated: 2026-09-23
---

# Documentation Baseline (Task 0)

Generated: 2026-09-23
Branch: develop
HEAD: a10711b docs: запретить создание веток без одобрения

## Git State

| Property | Value |
|----------|-------|
| Branch | develop |
| HEAD | a10711b |
| Working Tree | Clean (no pending changes) |

## Docs Inventory

Total files: 49

### By Directory

| Directory | Count |
|-----------|-------|
| docs/architecture/plans/ | 20 |
| docs/architecture/reference-ui/ | 11 |
| docs/architecture/specs/ | 4 |
| docs/audit/ | 7 |
| docs/development/ | 4 |
| docs/roadmap/ | 2 |
| docs/ | 1 |

### By Type

| Type | Count |
|------|-------|
| .md | 45 |
| .html | 11 (reference UI) |

## Identified Conflicts

| Category | Issue | Location |
|----------|-------|----------|
| Duplicate Roadmap | Two v1 roadmap documents | `architecture/plans/2026-09-16-v1-roadmap.md`, `architecture/specs/01-system-design.md` |
| Competing Future Plans | Multiple competing roadmap perspectives | `next-stages-roadmap.md`, `post-v1.md`, `ecosystem-skills-and-plugins.md` |
| Phase/Stage Mixing | Use of "Phase" and Stage letters (A-F) mixed with numeric stages | Various plan files |
| Date Prefixes | Files use `2026-09-XX` prefixes instead of numeric IDs | All files in plans/specs/audit/development |
| Manual Index | `docs/README.md` contains incomplete manual file listing | docs/README.md |
| Missing References | References to non-existent `ebb-orchestrator-*` filenames | Multiple docs |
| Title Overlap | Web UI plans with overlapping status tracking | Multiple web-ui plans |

## Security Check

- No actual secrets found in docs/
- Documented references to secret management patterns (not actual keys)
- No credential leakage detected

## Status Validation

- Status not determined solely by filename (per governance rules)
- Unrelated files (e.g., `apps/web/test/...`) excluded from docs inventory
- All docs/ files are repository-tracked

## Next Steps (Task 1+)

1. Create `scripts/docs-governance.mjs` for automated inventory/validation
2. Define and enforce numeric prefix naming policy
3. Merge duplicate roadmap content into single canonical `docs/roadmap/01-roadmap.md`
4. Replace Phase/A-B-C terminology with numeric Stage
5. Generate canonical IDs and migrate historical content
