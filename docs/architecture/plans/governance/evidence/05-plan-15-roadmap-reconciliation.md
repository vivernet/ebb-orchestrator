---
id: ledger-05
kind: ledger
status: draft
title: Reconciliation ledger for plan-15 roadmap registration
created: 2026-09-25
updated: 2026-09-25
---

# Plan-15 roadmap reconciliation ledger

## Scope

Зарегистрированы родительский plan-15 и части 15-01–15-08. Все девять планов остаются `status: planned`; реализация production-кода и тестов не выполнялась. `docs/architecture/plans/16-documentation-cleanup-and-refresh.md` не входит в регистрацию и сохранён без изменения.

## Fresh validation

Проверены frontmatter и граф зависимостей девяти файлов plan-15: уникальные IDs `plan-15`, `plan-15-01`–`plan-15-08`; `kind: plan`, `roadmap: 01`, `stage: 13`, `status: planned`; граф ацикличен. Внешние зависимости родительского плана `plan-12` и `plan-13` разрешены как существующие предшествующие планы.

Read-back канонического roadmap подтвердил ровно 9 записей plan-15: `plan-15`, `plan-15-01`, `plan-15-02`, `plan-15-03`, `plan-15-04`, `plan-15-05`, `plan-15-06`, `plan-15-07`, `plan-15-08`; у всех `stage: 13` и `status: planned`; duplicate IDs отсутствуют. Generated output: `docs/roadmap/01-roadmap.md`.

## Command ledger

### `pnpm docs:check` before roadmap generation

- Exit code: `0`
- Result: PASS with one existing warning for `roadmap/generated.md` filename normalization.

```text
$ node scripts/docs-governance.mjs check
Found 1 warning(s):

[WARNING] roadmap/generated.md
  Filename does not start with numeric prefix
```

### `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md`

- Exit code: `0`
- Result: PASS; collected 27 plans and validated the requested repo-relative output.

```text
$ node scripts/roadmap-generator-cli.mjs "--" "--dry-run" "--output=docs/roadmap/01-roadmap.md"
=== DRY RUN MODE ===

Plans collected: 27
Output: docs/roadmap/01-roadmap.md

--- Generated content preview ---

---
id: roadmap-01
status: completed
kind: roadmap
title: Ebb Orchestrator Roadmap
summary: Unified roadmap consolidating all stages and plans
created: 2026-09-16
updated: 2026-09-25
---

# Ebb Orchestrator Roadmap

**Version:** Roadmap 01
**Last Updated:** 2026-09-25
**Status:** Active

> This document is auto-generated from plan metadata. For manual edits, see [Governance Guide](../architecture/plans/governance/00-01-documentation-governance.md).

---

## Table of Contents

1. [Overview](#...
```

### `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md`

- Exit code: `0`
- Result: PASS; canonical roadmap generated from the repository script.

```text
$ node scripts/roadmap-generator-cli.mjs "--" "--output=docs/roadmap/01-roadmap.md"
Roadmap generated: docs/roadmap/01-roadmap.md
Plans included: 27
```

### Canonical roadmap read-back

- Exit code: `0`
- Result: PASS; exact plan-15 count, IDs, stage/status and duplicate check verified.

```text
Canonical roadmap contains exactly 9 plan-15 entries: plan-15-01, plan-15-02, plan-15-03, plan-15-04, plan-15-05, plan-15-06, plan-15-07, plan-15-08, plan-15; all stage=13/status=planned; no duplicate plan-15 IDs.
```

### `pnpm docs:check` after generated roadmap

- Exit code: `0`
- Result: PASS with the same existing warning for `roadmap/generated.md` filename normalization.

```text
$ node scripts/docs-governance.mjs check
Found 1 warning(s):

[WARNING] roadmap/generated.md
  Filename does not start with numeric prefix
```

### `pnpm docs:test`

- Exit code: `0`
- Result: PASS; 11 tests passed, 0 failed, 0 skipped.

```text
$ node --test scripts/docs-governance.test.mjs
✔ parseFrontMatter extracts metadata and body (3.3851ms)
✔ parseDocument parses file content (0.4332ms)
✔ validateDocument returns empty for valid document (0.5104ms)
✔ validateDocument returns issues for invalid id (0.3107ms)
✔ loadMigrationMap parses migration document (2.7505ms)
✔ validateMigrationMap checks source paths exist (2.7685ms)
✔ resolveCanonicalDocument finds canonical target (2.9235ms)
✔ buildRoadmapModel aggregates plans by stage (17.4133ms)
✔ renderRoadmap generates sections with markers (0.7569ms)
✔ isGeneratedRoadmapUpToDate checks for matching content (0.8445ms)
✔ writeGeneratedRoadmap writes file to path (3.4292ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 182.3289
```

## Required governance normalization

`git diff --check` initially failed only because the generated roadmap emitted Markdown hard-break trailing spaces. The governance generator `scripts/roadmap-generator-cli.mjs` was updated to emit the same roadmap content without trailing whitespace; no production code or test file was changed. The canonical roadmap was regenerated after that targeted governance fix, now including the newly created ledger in the generator's total.

### Final `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md`

- Exit code: `0`
- Result: PASS; collected 28 documents and previewed the normalized generated output.

```text
$ node scripts/roadmap-generator-cli.mjs "--" "--dry-run" "--output=docs/roadmap/01-roadmap.md"
=== DRY RUN MODE ===

Plans collected: 28
Output: docs/roadmap/01-roadmap.md

--- Generated content preview ---

---
id: roadmap-01
status: completed
kind: roadmap
title: Ebb Orchestrator Roadmap
summary: Unified roadmap consolidating all stages and plans
created: 2026-09-16
updated: 2026-09-25
---

# Ebb Orchestrator Roadmap

**Version:** Roadmap 01
**Last Updated:** 2026-09-25
**Status:** Active

> This document is auto-generated from plan metadata. For manual edits, see [Governance Guide](../architecture/plans/governance/00-01-documentation-governance.md).

---

## Table of Contents

1. [Overview](#over...
```

### Final `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md`

- Exit code: `0`
- Result: PASS; canonical roadmap regenerated after the whitespace normalization.

```text
$ node scripts/roadmap-generator-cli.mjs "--" "--output=docs/roadmap/01-roadmap.md"
Roadmap generated: docs/roadmap/01-roadmap.md
Plans included: 28
```

## Preservation and warnings

- The unrelated plan-16 worktree edit was preserved; the roadmap command did not modify it.
- `pnpm docs:check` emits one pre-existing warning for `roadmap/generated.md`; it does not fail the command.
- No production code or tests were implemented or modified by this registration.
- `git diff --check` was run before registration and passed with Git's existing CRLF normalization warning for plan-16; it must be rerun after this ledger write before commit.
