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

Зарегистрированы родительский plan-15 и части 15-01–15-08. На этапе регистрации все девять планов имели `status: planned`; bootstrap перевёл только родительский plan-15 в `status: in_progress`, не меняя статусы частей. Последующая реализация 15-01 и 15-02 зафиксирована отдельными transition sections ниже; этот transition не изменяет production code или tests. `docs/architecture/plans/16-documentation-cleanup-and-refresh.md` не входит в регистрацию и сохранён без изменения.

## Fresh validation

Проверены frontmatter и граф зависимостей девяти файлов plan-15 после bootstrap: уникальные IDs `plan-15`, `plan-15-01`–`plan-15-08`; `kind: plan`, `roadmap: 01`, `stage: 13`; родительский `status: in_progress`, части `status: planned`; граф ацикличен. Все `specs`, `evidence` и зависимости разрешаются; внешние зависимости родительского плана `plan-12` и `plan-13` разрешены как существующие предшествующие планы.

Read-back канонического roadmap после bootstrap подтвердил ровно 9 записей plan-15: `plan-15`, `plan-15-01`, `plan-15-02`, `plan-15-03`, `plan-15-04`, `plan-15-05`, `plan-15-06`, `plan-15-07`, `plan-15-08`; у всех `stage: 13`, у родителя `status: in_progress`, у частей `status: planned`; duplicate IDs отсутствуют. Generated output: `docs/roadmap/01-roadmap.md`.

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

## Bootstrap execution (2026-09-25)

Родительский plan-15 переведён в `in_progress`; `updated: 2026-09-25` подтверждён. На этапе bootstrap production code и production tests не изменялись.

### Task state ledger

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE | Implementer и scoped re-review завершены; verdict PASS |
| 15-02 | READY | Зависимость 15-01 выполнена; следующий допустимый task |
| 15-03 | WAITING | Зависит от 15-02 |
| 15-04 | WAITING | Зависит от 15-01, 15-02 и 15-03 |
| 15-05 | WAITING | Зависит от 15-04 |
| 15-06 | WAITING | Зависит от 15-01, 15-04 и 15-05 |
| 15-07 | WAITING | Зависит от 15-05 и 15-06 |
| 15-08 | WAITING | Зависит от 15-03, 15-04, 15-05, 15-06 и 15-07 |

### Bootstrap command results

- `pnpm docs:check` before roadmap generation — exit `0`; PASS with the existing warning for `roadmap/generated.md` filename normalization.
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; `Plans collected: 28`, output `docs/roadmap/01-roadmap.md`.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; stdout exactly `Roadmap generated: docs/roadmap/01-roadmap.md` and `Plans included: 28`.
- Plan graph/path validation — exit `0`; 9 plan files, unique IDs, no unresolved dependencies, no missing specs/evidence, no cycles.
- Roadmap read-back — exit `0`; exactly 9 plan-15 entries, no duplicate IDs, parent `in_progress`, children `planned`, all `stage: 13`.

## Bootstrap verification results

- Повторный `pnpm docs:check` — exit `0`; PASS with the same existing warning for `roadmap/generated.md` filename normalization.
- `pnpm docs:test` — exit `0`; 11 tests passed, 0 failed, 0 skipped.
- `git diff --check` after ledger write — exit `0` после устранения добавленного blank line at EOF; Git оставил только существующее предупреждение о CRLF-нормализации plan-16.

## Task 15-01 completion transition (2026-09-25)

Parent metadata remains `plan-15: in_progress`; child metadata is reconciled as `plan-15-01: completed`. `plan-15-02` remains a planned child in frontmatter and is execution-state `READY` in this ledger; `15-03`–`15-08` remain planned children and execution-state `WAITING`. This preserves the distinction between roadmap lifecycle metadata and the controller task-state ledger.

### Implementer evidence

- Argon2 strict PHC fix-loop completed; the implementer result is `PASS`.
- Auth contract gate: **11 tests passed**.
- Server test suite: **741 passed, 2 skipped**.
- Typechecks, build checks and contracts checks: **PASS**.
- `git diff --check`: **PASS**.

### Scoped re-review evidence

- Scoped re-review of the 15-01 fix-loop: **PASS**.
- Findings: **none**; no BLOCKER or IMPORTANT finding remains.

### Known lint ruling

- Root lint retains exactly the pre-existing `apps/server/src/app/create-app.ts:199` error. It is tracked as an existing out-of-scope ruling; no new lint finding was introduced and no lint rule/test was weakened.

### Transition decision

`15-01` is `DONE` and unblocks `15-02`; no downstream task was started. `15-02` is the sole `READY` task. Tasks `15-03`–`15-08` remain `WAITING` on their declared dependencies.

## Transition validation (2026-09-25)

- `pnpm docs:check` before roadmap generation — exit `0`; one existing warning only: `[WARNING] roadmap/generated.md` / `Filename does not start with numeric prefix`.
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; `Plans collected: 28`; output `docs/roadmap/01-roadmap.md`.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; stdout exactly `Roadmap generated: docs/roadmap/01-roadmap.md` and `Plans included: 28`.
- Canonical roadmap read-back — exit `0`; exactly 9 plan-15 rows in generator order: `plan-15-01`, `plan-15-02`, `plan-15-03`, `plan-15-04`, `plan-15-05`, `plan-15-06`, `plan-15-07`, `plan-15-08`, `plan-15`; all `stage: 13`; `plan-15: in_progress`; `plan-15-01: completed`; `plan-15-02`–`plan-15-08: planned`; no duplicate IDs.
- `pnpm docs:check` after roadmap generation — exit `0`; the same existing `roadmap/generated.md` filename warning only.
- `pnpm docs:test` — exit `0`; 11 passed, 0 failed, 0 skipped.
- `git diff --check` — exit `0`; Git reported only the existing CRLF-normalization warning for `docs/architecture/plans/16-documentation-cleanup-and-refresh.md`.
- Unrelated plan-16 preservation — current Git blob hash remains `73ed2b4ec42627ad5820d3003421542266353ad2`.

## Task 15-02 completion transition (2026-09-25)

Parent metadata remains `plan-15: in_progress`; child metadata is reconciled as `plan-15-02: completed`. `plan-15-03` remains `status: planned` in frontmatter and is execution-state `READY` in this ledger; `15-04`–`15-08` remain planned children and execution-state `WAITING`. This preserves the distinction between roadmap lifecycle metadata and the controller task-state ledger.

### Implementer evidence

- Migration `026_local_auth.sql`, the SQLite auth ports/repository and Argon2 password-hasher implementation are present in the repository.
- Strict migrator catalog/name/checksum/gap validation is implemented and covered by the migration tests.
- Scheduler migration fixture uses the cumulative catalog; focused scheduler migration run: **10/10 tests passed**.
- Combined 15-02/auth contract focused run: **34/34 tests passed** across 6 files, including repository concurrency, backup/restore, migration, auth contract and password-hash feasibility coverage.
- Full server suite: **762 passed, 2 skipped**.
- Workspace typecheck, workspace build and `git diff --check`: **PASS**.

### Scoped re-review evidence

- Scoped re-review of task 15-02: **PASS**.
- Review confirmed the migration 026/repository boundary, fail-closed migrator validation, cumulative scheduler fixture and focused/full test evidence; findings: **none**; no BLOCKER or IMPORTANT finding remains.

### Known lint ruling

- Root lint retains exactly the pre-existing `apps/server/src/app/create-app.ts:199` error. It is tracked as an existing out-of-scope ruling; no new lint finding was introduced and no lint rule/test was weakened.

### Transition decision

`15-02` is `DONE` and unblocks `15-03`; `15-03` is the sole `READY` task. Tasks `15-04`–`15-08` remain `WAITING` on their declared dependencies. No production implementation or test file was changed during this controller transition.

## Current transition validation (2026-09-25)

- `pnpm docs:check` before roadmap generation — exit `0`; exact output:
  ```text
  $ node scripts/docs-governance.mjs check
  Found 1 warning(s):

  [WARNING] roadmap/generated.md
    Filename does not start with numeric prefix
  ```
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; exact result included `Plans collected: 28` and `Output: docs/roadmap/01-roadmap.md`.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; exact stdout: `Roadmap generated: docs/roadmap/01-roadmap.md` and `Plans included: 28`.
- Canonical roadmap read-back — exit `0`; exactly 9 plan-15 rows: `plan-15-01`, `plan-15-02`, `plan-15-03`, `plan-15-04`, `plan-15-05`, `plan-15-06`, `plan-15-07`, `plan-15-08`, `plan-15`; all `stage: 13`; `plan-15: in_progress`; `plan-15-01` and `plan-15-02: completed`; `plan-15-03`–`plan-15-08: planned`; no duplicate IDs. Frontmatter read-back matched the same states.
- `pnpm docs:check` after roadmap generation — exit `0`; the same one existing warning only: `[WARNING] roadmap/generated.md` / `Filename does not start with numeric prefix`.
- `pnpm docs:test` — exit `0`; **11 passed, 0 failed, 0 skipped**.
- `git diff --check` — exit `0` after removing the transition's trailing blank line; Git reported only the existing CRLF-normalization warning for `docs/architecture/plans/16-documentation-cleanup-and-refresh.md`.
- Unrelated plan-16 preservation — `git hash-object docs/architecture/plans/16-documentation-cleanup-and-refresh.md` returned `73ed2b4ec42627ad5820d3003421542266353ad2`.

## Task 15-03 completion transition (2026-09-25)

Parent metadata remains `plan-15: in_progress`; child metadata is reconciled as `plan-15-03: completed`. `plan-15-04` remains `status: planned` in frontmatter and is execution-state `READY` in this ledger; `15-05`–`15-08` remain planned children and execution-state `WAITING`. This preserves the distinction between roadmap lifecycle metadata and the controller task-state ledger.

### Implementer and scoped review evidence

- Scoped implementation review verdict: **PASS**; no BLOCKER or IMPORTANT finding remains.
- Server suite: **779 passed, 2 skipped across 84 files**.
- The TTY wizard cleanup/security/startup boundary is verified: non-TTY startup fails closed before listener/worker/READY; successful TTY adapter flow persists the local user without password disclosure; a subsequent startup uses the persisted user without prompting.
- Server typecheck, workspace build, `pnpm server:build && node scripts/verify-local-startup.mjs`, and `git diff --check`: **PASS**.

### Known lint ruling

- Root lint retains exactly the pre-existing out-of-scope error at `apps/server/src/app/create-app.ts:199`; it is untouched by 15-03. No new lint finding was introduced and no lint rule or test was weakened.

### Task state ledger

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE/PASS | Contract and crypto feasibility are completed and reviewed. |
| 15-02 | DONE/PASS | SQLite auth persistence and repository are completed and reviewed. |
| 15-03 | DONE/PASS | Wizard/startup implementation and scoped review passed. |
| 15-04 | READY | All declared dependencies (15-01, 15-02, 15-03) are complete. |
| 15-05 | WAITING | Depends on 15-04. |
| 15-06 | WAITING | Depends on 15-04 and 15-05. |
| 15-07 | WAITING | Depends on 15-05 and 15-06. |
| 15-08 | WAITING | Depends on 15-04–15-07. |

### Transition decision

`15-03` is `DONE/PASS` and unblocks `15-04`; `15-04` is the sole `READY` task. Tasks `15-05`–`15-08` remain `WAITING` on their declared dependencies. No production implementation or test file was changed during this controller transition.

### Controller transition validation

- `pnpm docs:check` before and after roadmap generation — exit `0`; the only warning was `[WARNING] roadmap/generated.md` / `Filename does not start with numeric prefix`.
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; `Plans collected: 28`, output `docs/roadmap/01-roadmap.md`.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; stdout: `Roadmap generated: docs/roadmap/01-roadmap.md` and `Plans included: 28`.
- Canonical roadmap read-back — exit `0`; exactly 9 plan-15 rows; `plan-15-01`–`plan-15-03` are `completed`, `plan-15-04`–`plan-15-08` are `planned`, and parent `plan-15` is `in_progress`.
- `pnpm docs:test` — exit `0`; **11 passed, 0 failed, 0 skipped**.
- `git diff --check` — exit `0`; it emitted only pre-existing CRLF-normalization warnings for plan-16 and `start.bat`.
- Unrelated plan-16 preservation — `git hash-object docs/architecture/plans/16-documentation-cleanup-and-refresh.md` returned `73ed2b4ec42627ad5820d3003421542266353ad2`.

## Atomic auth v2 remediation transition (2026-09-25)

The contract amendment review found that the completed-task ledger was inconsistent with current source: `AUTH_PORT_CONTRACT_VERSION=1` and a standalone `validateCsrf` seam remained, so route composition could authorize a stale CSRF token and touch the session in a separate operation. Completed `15-01`, `15-02` and `15-03` remain DONE/PASS historical records; this does not reopen or rewrite their implementation scope.

A new planned prerequisite, `plan-15-09` / `15-09-atomic-auth-v2-remediation.md`, now depends on `15-01`–`15-03` and owns the internal v2 port, repository, service, fake and concurrency remediation. Its `validateCsrf` source-absence proof is limited to `auth-ports.ts`, `auth-repository.ts`, `auth-service.ts`, `test/helpers/auth.ts`, `auth-onboarding-contract.test.ts` and `auth-service-red.test.ts`; it does not read or assert `create-app.ts`. It requires `AUTH_PORT_CONTRACT_VERSION=2`, exactly one repository `BEGIN IMMEDIATE` authorized-mutation transaction, and rotation-vs-authorized-mutation plus touch-vs-logout races in both controlled orders. Each race uses two independent file-backed workers that acknowledge readiness, blocks both on a barrier, releases only the designated first worker, waits for its `BEGIN IMMEDIATE` acquisition acknowledgement before releasing the second, and records durable snapshots after first completion and after both completions; missing or duplicate acknowledgements fail the test. `15-04` now depends on verified `15-09`, exclusively removes `validateCsrf` adapter references from `create-app.ts`/route tests, consumes rather than redefines the atomic port, and owns the exact green assertion that every accepted protected mutation makes one and only one `authenticateCsrfAndTouch` call.

### Current task state and corrected roadmap assertion

The next generated-roadmap read-back must contain exactly 10 `plan-15` entries: parent `plan-15` plus nine child plans `plan-15-01`–`plan-15-09`. Expected metadata is parent `in_progress`; `plan-15-01`, `plan-15-02` and `plan-15-03` `completed`; and `plan-15-09`, `plan-15-04`, `plan-15-05`, `plan-15-06`, `plan-15-07` and `plan-15-08` `planned`. Every entry remains stage 13 with unique IDs and a valid acyclic dependency graph. Earlier nine-entry records above are historical bootstrap evidence from before `plan-15-09` existed and must not be reused as the current assertion.

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE/PASS | Completed contract/crypto task; frontmatter restored to `completed`. |
| 15-02 | DONE/PASS | Completed persistence/repository task; retained as historical PASS. |
| 15-03 | DONE/PASS | Completed wizard/startup task; retained as historical PASS. |
| 15-09 | READY | New atomic v2 prerequisite; all declared dependencies are DONE/PASS. |
| 15-04 | WAITING | Must not begin route composition until 15-09 is independently verified DONE/PASS. |
| 15-05–15-08 | WAITING | Existing downstream dependencies remain unsatisfied. |

No production source or test was changed in this controller/Plan Fixer transition. `15-09` is the sole executable remediation task; no implementation is claimed until its direct Vitest command, typecheck and independent review pass.

## Plan-controller transition: 15-09 READY / 15-04 BLOCKED (2026-09-25)

This controller transition preserves the historical DONE/PASS records for `15-01`–`15-03` and does not claim implementation or verification for `15-09`. The independently approved `15-09` plan is now the sole `READY` remediation task. `15-04` is `BLOCKED` by `15-09`: route composition must not start until the prerequisite has independently verified DONE/PASS. Child frontmatter remains lifecycle metadata (`completed` for `15-01`–`15-03`; `planned` for `15-09` and `15-04`–`15-08`), while this ledger records controller execution state.

### Task state ledger

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE/PASS | Historical completed contract/crypto task; retained unchanged. |
| 15-02 | DONE/PASS | Historical completed persistence/repository task; retained unchanged. |
| 15-03 | DONE/PASS | Historical completed wizard/startup task; retained unchanged. |
| 15-09 | READY | Approved atomic auth v2 remediation; all declared dependencies (`15-01`–`15-03`) are DONE/PASS. |
| 15-04 | BLOCKED | Blocked by `15-09`; route composition may start only after its independently verified DONE/PASS. |
| 15-05 | WAITING | Depends on blocked `15-04`. |
| 15-06 | WAITING | Downstream dependencies remain unsatisfied. |
| 15-07 | WAITING | Downstream dependencies remain unsatisfied. |
| 15-08 | WAITING | Depends on `15-09` and remaining downstream tasks. |

### Transition validation

- `pnpm docs:check` before roadmap generation — exit `0`; the only warning was `[WARNING] roadmap/generated.md` / `Filename does not start with numeric prefix`.
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; `Plans collected: 29`; output `docs/roadmap/01-roadmap.md`.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; stdout: `Roadmap generated: docs/roadmap/01-roadmap.md` and `Plans included: 29`.
- Canonical roadmap read-back — exit `0`; exactly 10 unique stage-13 `plan-15` entries; parent `plan-15` is `in_progress`; `plan-15-01`–`plan-15-03` and `plan-15-09` are `completed`; `plan-15-04`–`plan-15-08` are `planned`; dependency `plan-15-09 → plan-15-04` is present.
- `pnpm docs:check` after roadmap generation — exit `0`; the same existing `roadmap/generated.md` filename warning only.
- `pnpm docs:test` — exit `0`; **11 passed, 0 failed, 0 skipped**.
- `git diff --check` — exit `0`; it emitted only pre-existing CRLF-normalization warnings for plan-16 and `start.bat`.
- Unrelated plan-16 preservation — `git hash-object docs/architecture/plans/16-documentation-cleanup-and-refresh.md` returned `73ed2b4ec42627ad5820d3003421542266353ad2`.

## Plan-controller transition: 15-09 DONE/PASS / 15-04 READY (2026-09-25)

The approved `15-09` atomic auth v2 prerequisite completed its independent task/security review with **PASS**. Its focused verification is complete: **27/27** focused assertions and **10/10** concurrency assertions passed; server typecheck and `git diff --check` passed. The known full-suite limitation remains: **17 route 503 failures** are attributable to pending `15-04` create-app composition and are not evidence against the completed `15-09` scope.

### Task state ledger

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE/PASS | Historical completed contract/crypto task; retained unchanged. |
| 15-02 | DONE/PASS | Historical completed persistence/repository task; retained unchanged. |
| 15-03 | DONE/PASS | Historical completed wizard/startup task; retained unchanged. |
| 15-09 | DONE/PASS | Independent task/security review PASS; focused 27/27 and concurrency 10/10 passed; typecheck and diff checks passed. |
| 15-04 | READY | All declared dependencies (`15-01`–`15-03` and verified `15-09`) are DONE/PASS. |
| 15-05 | WAITING | Depends on `15-04`. |
| 15-06 | WAITING | Depends on `15-04` and `15-05`. |
| 15-07 | WAITING | Depends on `15-05` and `15-06`. |
| 15-08 | WAITING | Depends on `15-04`–`15-07` and verified `15-09`. |

### Transition decision

`15-09` is `DONE/PASS` and unblocks `15-04`; `15-04` is the sole `READY` task. Tasks `15-05`–`15-08` remain `WAITING`. No production or test files were changed by this controller transition; plan-16 remains unrelated and preserved.

### Transition validation

- Focused `15-09` verification — **27/27 passed**.
- Deterministic concurrency verification — **10/10 passed**.
- Server typecheck — **PASS**.
- `git diff --check` — **PASS**.
- Full suite — known **17 route 503 failures** caused by pending `15-04` create-app composition; not a `15-09` failure.
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; `Plans collected: 29`.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; `Roadmap generated: docs/roadmap/01-roadmap.md`; `Plans included: 29`.
- Canonical roadmap read-back — exit `0`; exactly 10 stage-13 `plan-15` entries: `plan-15-01`–`plan-15-03` and `plan-15-09` are `completed`; `plan-15-04`–`plan-15-08` are `planned`; parent `plan-15` is `in_progress`; no duplicate IDs.
- `pnpm docs:check` — exit `0`; one existing warning only: `roadmap/generated.md` filename lacks numeric prefix.
- `pnpm docs:test` — exit `0`; **11 passed, 0 failed, 0 skipped**.
- `git diff --check` — exit `0`; only pre-existing CRLF-normalization warnings for plan-16 and `start.bat`.
- Unrelated plan-16 preservation — hash `73ed2b4ec42627ad5820d3003421542266353ad2`.

## Plan-controller transition: 15-04 DONE/PASS (2026-09-25)

The `15-04` server security boundary implementation and independent review returned **PASS** after metadata-only reconciliation. Frontmatter now uses the repository lifecycle convention `status: completed`, which maps to controller state `DONE/PASS`. Parent `plan-15` remains `in_progress`; completed `15-01`, `15-02`, `15-03` and `15-09` remain unchanged. Pending children `15-05`–`15-08` remain `WAITING` in the controller ledger and `status: planned` in frontmatter. No production source or test file was changed by this transition. The unrelated status-only worktree change to `docs/architecture/plans/16-documentation-cleanup-and-refresh.md` was preserved exactly.

### Implementer and review evidence

- Focused security/E2E verification: **32/32 passed**.
- Server suite: **792 passed, 2 skipped**.
- Typecheck, lint, build and documentation/diff gates: **PASS**.
- Real HTTP/SSE and production-serve E2E: **PASS**.
- Real browser verification was retried but unavailable because CDP returned Windows `WinError 1225`; this remains a limitation owned by the pending browser/Web work, not a failed server boundary result.

### Task state ledger

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE/PASS | Historical completed contract/crypto task; retained unchanged. |
| 15-02 | DONE/PASS | Historical completed persistence/repository task; retained unchanged. |
| 15-03 | DONE/PASS | Historical completed wizard/startup task; retained unchanged. |
| 15-09 | DONE/PASS | Independent atomic auth v2 prerequisite; retained unchanged. |
| 15-04 | DONE/PASS | Server security boundary implementation and review passed; metadata reconciled. |
| 15-05 | WAITING | Depends on 15-04; not started. |
| 15-06 | WAITING | Depends on 15-04 and 15-05; not started. |
| 15-07 | WAITING | Depends on 15-05 and 15-06; not started. |
| 15-08 | WAITING | Depends on 15-04–15-07 and 15-09; not started. |

### Transition validation

- `pnpm docs:check` before roadmap generation — exit `0`; one existing warning only: `roadmap/generated.md` filename lacks a numeric prefix.
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; `Plans collected: 29`; output `docs/roadmap/01-roadmap.md`.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; `Roadmap generated: docs/roadmap/01-roadmap.md`; `Plans included: 29`.
- Canonical roadmap read-back — exit `0`; exactly 10 stage-13 plan-15 rows with unique IDs: `plan-15-01`, `plan-15-02`, `plan-15-03`, `plan-15-04`, `plan-15-05`, `plan-15-06`, `plan-15-07`, `plan-15-08`, `plan-15-09`, `plan-15`; `plan-15` is `in_progress`, `15-01`–`15-04` and `15-09` are `completed`, and `15-05`–`15-08` are `planned`.
- `pnpm docs:check` after roadmap generation — exit `0`; the same existing warning only.
- `pnpm docs:test` — exit `0`; **11 passed, 0 failed, 0 skipped**.
- `git diff --check` — exit `0`; only existing CRLF-normalization warnings for plan-16 and `start.bat`.
- Unrelated plan-16 preservation — `git hash-object docs/architecture/plans/16-documentation-cleanup-and-refresh.md` returned `73ed2b4ec42627ad5820d3003421542266353ad2`.

### Scope verification

Only the three intended metadata documents were touched by this transition: `docs/architecture/plans/15-04-server-security-boundary.md`, `docs/roadmap/01-roadmap.md` (generated), and this ledger. Existing production/source/test changes in the worktree were preserved; no commit, push or merge was performed.

## Plan-controller transition: 15-05 DONE/PASS (2026-09-25)

The approved `15-05` Web auth/restore and SSE expiry implementation completed its independent implementation and security reviews with **PASS**. Frontmatter now uses the repository lifecycle convention `status: completed`, which maps to controller state `DONE/PASS`. Parent `plan-15` remains `in_progress`; completed `15-01`–`15-04` and `15-09` remain unchanged. Pending children `15-06`–`15-08` remain `WAITING` in the controller ledger and `status: planned` in frontmatter. No production or test files were changed by this metadata transition.

### Implementer and review evidence

- Web focused/auth/SSE verification: **16 files, 161 passed**.
- Server suite: **792 passed, 2 skipped**.
- Contracts verification: **3 passed**.
- Workspace typecheck, lint, test, build and `git diff --check`: **PASS**.
- Independent implementation review: **PASS**.
- Independent security review: **PASS**.
- Browser E2E is explicitly **deferred/blocked**: the existing first-run backend harness requires an interactive TTY, and the previously attempted Browser CDP path failed with Windows `WinError 1225`. This is an execution-environment limitation, not a claimed browser-pass result; the stale bootstrap E2E harness files remain owned by plan `15-07`.

### Task state ledger

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE/PASS | Historical completed contract/crypto task; retained unchanged. |
| 15-02 | DONE/PASS | Historical completed persistence/repository task; retained unchanged. |
| 15-03 | DONE/PASS | Historical completed wizard/startup task; retained unchanged. |
| 15-09 | DONE/PASS | Independent atomic auth v2 prerequisite; retained unchanged. |
| 15-04 | DONE/PASS | Server security boundary implementation and review passed; retained unchanged. |
| 15-05 | DONE/PASS | Web auth/restore/SSE implementation and independent implementation/security reviews passed. |
| 15-06 | WAITING | Depends on 15-04 and 15-05; not started. |
| 15-07 | WAITING | Depends on 15-05 and 15-06; stale bootstrap E2E harness ownership remains here. |
| 15-08 | WAITING | Depends on 15-04–15-07 and 15-09; not started. |

### Transition decision

`15-05` is `DONE/PASS`. Tasks `15-06`–`15-08` remain `WAITING` on their declared dependencies. Browser E2E remains deferred/blocked under the explicit limitation above; no stale `15-07` harness or plan-16 files were modified.

### Transition validation

- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; generated-roadmap preview completed.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; canonical roadmap regenerated from repository metadata.
- Canonical roadmap read-back — exit `0`; exactly 10 unique stage-13 `plan-15` entries: parent `plan-15` is `in_progress`; `plan-15-01`–`plan-15-05` and `plan-15-09` are `completed`; `plan-15-06`–`plan-15-08` are `planned`; no duplicate IDs.
- `pnpm docs:check` — exit `0`; one existing warning only: `roadmap/generated.md` filename lacks a numeric prefix.
- `pnpm docs:test` — exit `0`; **11 passed, 0 failed, 0 skipped**.
- `git diff --check` — exit `0`; only pre-existing CRLF-normalization warnings remain.

### Scope verification

Only plan metadata, this evidence ledger, and the generated roadmap are intended transition outputs. Existing uncommitted Web implementation changes were preserved; no production/Web code, stale `15-07` harness, or plan-16 file was modified. No commit, push, or merge was performed.

## Plan-controller transition: 15-06 DONE/PASS (2026-09-25)

The approved onboarding draft and scheduler-guard implementation completed fresh independent task and security reviews with **PASS**. The task reviewer recommends promoting `plan-15-06` from `planned` to `completed`; the parent `plan-15` remains `in_progress`, and `15-07`/`15-08` remain pending. No migration history was changed.

### Implementer and review evidence

- Server full suite on Node 24.21.0 with the isolated process pool: **93 files, 825 passed, 2 skipped**.
- Plan-15-06-focused Web tests: **3 files, 70 passed**.
- Contracts suite: **3 files, 4 passed**.
- Server, Web and contracts typechecks: **PASS**; full ESLint: **PASS**; server TypeScript build and migration-resource copy: **PASS**; Web TypeScript build and Vite build: **PASS**.
- `git diff --check`: **PASS**.
- Latest independent security review: **PASS**; no repository-path bypass found. Latest independent Plan-15-06 review: **PASS**, status promotion recommended.
- The full Web suite still reports **6 failures in 3 unrelated store/API test files**. A minimal `.rejects.toThrow()` Vitest probe reproduces `TypeError: Cannot read properties of undefined (reading 'indexOf')`; the direct Node 24 store probe rejects with the expected `Error`. The full Web suite is not claimed as passing.
- Real-browser E2E remains blocked by the previously recorded CDP `WinError 1225`; browser verification and bootstrap harness cleanup remain with `15-07`/`15-08`.

### Task state ledger

| Task | State | Причина |
|---|---|---|
| 15-01 | DONE/PASS | Historical completed contract/crypto task; retained unchanged. |
| 15-02 | DONE/PASS | Historical completed persistence/repository task; retained unchanged. |
| 15-03 | DONE/PASS | Historical completed wizard/startup task; retained unchanged. |
| 15-09 | DONE/PASS | Independent atomic auth v2 prerequisite; retained unchanged. |
| 15-04 | DONE/PASS | Server security boundary implementation and review passed; retained unchanged. |
| 15-05 | DONE/PASS | Web auth/restore/SSE implementation and reviews passed; retained unchanged. |
| 15-06 | DONE/PASS | Onboarding lifecycle, project-bound approved repository path, scheduler guard, focused verification, and independent reviews passed. |
| 15-07 | WAITING | Depends on 15-05 and 15-06; Russian UI/accessibility and bootstrap artifact cleanup remain. |
| 15-08 | WAITING | Depends on 15-04–15-07 and 15-09; final verification/reconciliation remains. |

### Transition decision and validation

`15-06` is `DONE/PASS`; its frontmatter is `status: completed`. The parent plan remains `in_progress`. The known full-Web matcher failure and browser/CDP limitation are recorded explicitly and are not represented as passing evidence for this child plan.

- Node 24.21.0 server suite `vitest run --pool=forks --maxWorkers=4` — exit `0`; 93 files, 825 passed, 2 skipped.
- Plan-15-06-focused Web suite — exit `0`; 3 files, 70 passed.
- Contracts Vitest suite — exit `0`; 3 files, 4 passed.
- Server/Web/contracts TypeScript checks, ESLint, server build, Web build, and `git diff --check` — exit `0`.
- Full Web suite — not green: 6 failures in unrelated `.rejects.toThrow()` tests; minimal probe confirms the installed Vitest matcher failure independently of application logic.

## Повторное открытие 15-07 (2026-09-26)

- Свежая независимая проверка реализации 15-07 (`deleg_d4a01c76`) вернула `CHANGES_REQUIRED`: английские пользовательские статусы/этапы, generic fallback для известных auth/onboarding-кодов и недоступные именованные роли трёх индикаторов/таймлайна. Прежний `completed` и проверки до замечаний не закрывают эти дефекты.
- После исправления двух замечаний к последовательности RED и pre/post-review Web gates независимая проверка поправки планов (`deleg_547104f2`) дала `APPROVED`. Это утверждение плана, не проверка реализации.
- Метаданные `plan-15-07` переведены из `completed` в `in_progress`; `plan-15-08` остаётся `planned`, родитель `plan-15` остаётся `in_progress`. Владелец исправлений Web и регрессионных тестов — 15-07. До новых тестов и независимого `PASS` 15-07 задача 15-08 заблокирована; ранее пройденные тесты не засчитываются повторно.

### Первый раунд исправления и оставшийся блокер

- `pnpm --filter @ebb-orchestrator/web test test/api-client-foundation.test.ts test/auth-ui.test.tsx test/main-auth-state.test.ts test/sse-session-expiry.test.ts test/features/onboarding.test.tsx test/localization-accessibility.test.tsx test/app-shell.test.tsx test/core-views.test.tsx test/shared-primitives.test.tsx test/configuration-views.test.tsx test/operations-views.test.tsx test/features/RunPage.test.tsx test/ui-api-remediation.test.tsx test/routing-bootstrap.test.ts` — exit `0`, 14 файлов / 163 теста; результат промежуточный, не закрывает повторный review.
- `pnpm lint` — exit `0`; `pnpm test` — exit `0`, Web 181/181, server 825 passed / 2 skipped, contracts 4/4; `pnpm --filter @ebb-orchestrator/web build` — exit `0`; `node --test apps/web/test/e2e/credential-handoff.test.mjs` — exit `0`, 14/14; `pnpm --filter @ebb-orchestrator/web test:e2e` — первый exit `1` из-за прежнего ожидания `DRAFT` вместо русского UI, после изменения только видимых E2E assertions повторный exit `0`, 4/4. Исходные API status assertions сохранены. `pnpm typecheck` и `pnpm build` — exit `0` после этой E2E-правки.
- Независимый review `deleg_66543ba8` вернул `CHANGES_REQUESTED`: некоторые реальные run/status/scope ещё не локализованы, ряд страниц выводит сырые status и английские `reason.message`. Это текущий IMPORTANT-блокер. 15-07 остаётся `in_progress`, 15-08 остаётся `planned`; исправления и свежие gates/review обязательны до повторного закрытия.

### Второй раунд и остаточные замечания review

- После второго раунда: `pnpm --filter @ebb-orchestrator/web test test/api-client-foundation.test.ts test/auth-ui.test.tsx test/main-auth-state.test.ts test/sse-session-expiry.test.ts test/features/onboarding.test.tsx test/localization-accessibility.test.tsx test/app-shell.test.tsx test/core-views.test.tsx test/shared-primitives.test.tsx test/configuration-views.test.tsx test/operations-views.test.tsx test/features/RunPage.test.tsx test/ui-api-remediation.test.tsx test/routing-bootstrap.test.ts` — exit `0`, 14 файлов / 176 тестов. `pnpm lint` — exit `0`; `pnpm test` — exit `0`, Web 194/194, server 825 passed / 2 skipped, contracts 4/4; `pnpm --filter @ebb-orchestrator/web build` — exit `0`; `node --test apps/web/test/e2e/credential-handoff.test.mjs` — exit `0`, 14/14; `pnpm --filter @ebb-orchestrator/web test:e2e` — exit `0`, 4/4. Browser E2E намеренно подаёт некорректный ответ dashboard для проверки error boundary, поэтому console error этого сценария не является PASS всего UI.
- Свежий независимый review `deleg_732cb9eb` вернул `CHANGES_REQUESTED`: оставшиеся сырые значения в Execution/Approvals/Project/AgentRun, небезопасный вывод recovery reason и route statusText, а также утраченное browser-покрытие Agent Run и пустых Dashboard/Approvals/Execution из исходного E2E. Это третья ограниченная итерация исправлений; до её проверки и `PASS` 15-07 остаётся `in_progress`, 15-08 остаётся `planned`.

### Третья итерация и дополнительная browser-проверка

- После исправления UI и возвращения двух браузерных сценариев: pre-review focused Web command из строки выше — exit `0`, 14/14 файлов, 179/179 тестов; `pnpm lint` — exit `0`; `pnpm test` — exit `0`, Web 197/197, server 825 passed / 2 skipped, contracts 4/4; `pnpm --filter @ebb-orchestrator/web build` — exit `0`; `node --test apps/web/test/e2e/credential-handoff.test.mjs` — exit `0`, 14/14. В первом совместном browser run 5/6, потому что восстановленный Agent Run тест всё ещё ожидал сырые английские подписи; после корректировки видимых assertions совместный browser E2E — exit `0`, 6/6. `pnpm typecheck`, `pnpm build`, `git diff --check` — exit `0`.
- Независимый read-only review `deleg_ec203d48` прочитал промежуточный E2E-файл до указанной корректировки и вернул `CHANGES_REQUESTED`: устаревшие ожидания Agent Run и потерянные браузерные проверки missing epic/task, usage, read-only settings. Тест восстановлен с реальным HTTP для отсутствующих epic/task, проверкой reload задачи и русских состояний usage/settings; промежуточный browser run 5/6 выявил несовпадение ожидаемой пунктуации breadcrumbs, затем скорректирован тест. Повторный `pnpm --filter @ebb-orchestrator/web test:e2e` — exit `0`, 6/6 с совместным запуском backend/frontend. Независимая проверка этой последней E2E-правки ещё ожидается; `15-07` остаётся `in_progress`, `15-08` — `planned`.
- Свежая независимая read-only проверка `deleg_7ca4976b` текущего E2E-файла и прежних двух блокеров вернула `PASS`: русские и безопасные Agent Run assertions совпадают с фактическим UI, отсутствующие epic/task, reload/breadcrumbs, usage и settings снова проверяются в Chromium. После fresh focused Web 179/179, root test Web 197/197 + server 825 passed/2 skipped + contracts 4/4, lint, typecheck, build, credential-handoff 14/14 и реального backend/frontend Chromium E2E 6/6 план `15-07` вновь `completed`; `15-08` теперь разблокирован для отдельного post-review verification, но остаётся `planned` до её собственных gates.

## 15-08: post-review verification и предфинальная сверка

Отдельный post-review запуск focused Web (после `deleg_7ca4976b PASS`) не подменяется pre-review запуском. Все строки ниже — команды из корня репозитория на текущем worktree; вывод не содержит секретов. `PASS` означает exit `0`, если не указано иное.

| Команда | Exit | Фактический результат |
|---|---:|---|
| `pnpm --filter @ebb-orchestrator/web test test/api-client-foundation.test.ts test/auth-ui.test.tsx test/main-auth-state.test.ts test/sse-session-expiry.test.ts test/features/onboarding.test.tsx test/localization-accessibility.test.tsx test/app-shell.test.tsx test/core-views.test.tsx test/shared-primitives.test.tsx test/configuration-views.test.tsx test/operations-views.test.tsx test/features/RunPage.test.tsx test/ui-api-remediation.test.tsx test/routing-bootstrap.test.ts` | 0 | PASS; 14 файлов, 179/179 тестов. Post-review invocation. |
| `pnpm --filter @ebb-orchestrator/server test auth-repository.concurrency.test.ts` | 0 | PASS; 1 файл, 5/5 тестов. |
| `pnpm --filter @ebb-orchestrator/server test transport-origin.test.ts v1-security.test.ts` | 0 | PASS; 2 файла, 6/6 тестов; real HTTP Origin/session/CSRF. |
| `pnpm --filter @ebb-orchestrator/server test scheduler.test.ts runs-dispatch.test.ts run-event-handlers.test.ts epic-orchestrator.test.ts scheduler-projection.test.ts scheduler-fixture-inventory.test.ts` | 0 | PASS; 6 файлов, 52/52 теста. |
| `pnpm --filter @ebb-orchestrator/server test:auth-contract` | 0 | PASS; 2 файла, 12/12 тестов. |
| `pnpm --filter @ebb-orchestrator/server test test/platform/database/backup-restore.test.ts test/platform/database/migrator.test.ts test/platform/process/startup.test.ts test/platform/security/local-user-wizard.test.ts` | 0 | PASS; 4 файла, 43/43 теста. |
| `pnpm lint` | 0 | PASS; ESLint без ошибок. |
| `pnpm typecheck` | 0 | PASS; contracts/testing/server TypeScript checks. |
| `pnpm test` | 0 | PASS; contracts 4/4, Web 197/197, server 825 passed / 2 skipped; testing package без test-файлов, `--passWithNoTests`. |
| `pnpm build` | 0 | PASS; contracts, server и Web, Vite 160 modules transformed. |
| `pnpm server:build` | 0 | PASS; built server до browser E2E. |
| `pnpm web:build` | 0 | PASS; Web `tsc -b` и Vite. |
| `node scripts/verify-local-startup.mjs` | 0 | PASS; `local startup verification passed`. |
| `node --test apps/web/test/e2e/credential-handoff.test.mjs` | 0 | PASS; 14/14 negative-path, secret handoff и teardown проверок. |
| `pnpm --filter @ebb-orchestrator/web test:e2e` | 0 | PASS; Chromium 6/6; launcher собрал реальный backend, поднял backend и frontend на динамических loopback-портах, проверил login/logout, error boundary, пустые и отсутствующие страницы, заполненный Agent Run с подменой только пяти read projections, реальный onboarding и cookie session после restart/stop/start с общей SQLite. Намеренно невалидный mock в тесте error boundary пишет console error, но ожидаемое русское error UI проверено. |
| `pnpm --filter @ebb-orchestrator/server test startup.test.ts scheduler.test.ts` | 0 | PASS; 2 файла, 51/51 тест. |
| `pnpm --filter @ebb-orchestrator/server typecheck` | 0 | PASS; `tsc -p tsconfig.json --noEmit`. |
| `pnpm docs:check` (до roadmap) | 0 | PASS; `Found 1 warning(s): [WARNING] roadmap/generated.md — Filename does not start with numeric prefix`; новых ошибок нет. |
| `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` | 0 | PASS; `=== DRY RUN MODE ===`, `Plans collected: 29`, `Output: docs/roadmap/01-roadmap.md`; stdout далее содержит preview generated content. |
| `pnpm docs:test` (предварительный запуск, не финальная последовательность) | 0 | PASS; 11/11 тестов. |

- Прочитаны frontmatter всех десяти plan-15 перед promotion: уникальные `plan-15`, `plan-15-01`–`plan-15-09`; у всех `kind: plan`, `stage: 13`, `roadmap: 01`; parent `in_progress`, `15-08` `planned`, остальные восемь `completed`; граф внутренних зависимостей ацикличен. До финального генератора канонический roadmap ещё содержит устаревшее `plan-15-07: planned`, поэтому его нельзя принимать за свежий read-back; сравнение ведётся с текущими файлами планов.
- Независимый review плана `deleg_0532794e` вернул `CHANGES_REQUIRED` из-за устаревших status expectations родителя и frontmatter evidence на отсутствующие `local-session.ts`/удалённый `get-link.html`. Plan Fixer заменил ссылки на существующие `auth-service.ts`, `auth-ports.ts`, `credential-handoff.test.mjs` и согласовал parent status contract. Повторная независимая read-only проверка `deleg_db318b46` вернула `APPROVED`: десять уникальных ID, предфинальные статусы, все frontmatter evidence существуют; новых противоречий нет. Статусы `15-08` и родителя не повышены до итогового implementation review и сверки генератора.

### Финальное implementation review: исправление выявленных блокеров

- Независимый read-only final implementation review `deleg_707f1a1f` вернул `CHANGES_REQUESTED`: discovered Git remote URL с credentials попадал в `onboarding_configs.facts_json` и approval metadata до UI-редактирования; отклонённый approval делал сохранённый draft нечитаемым. Ни план, ни roadmap до устранения не переводились в `completed`.
- Для обоих дефектов создан test-first RED в `apps/server/test/modules/projects/onboarding-service.test.ts`: persistence test обнаружил неочищенный marker в facts JSON; reject test обнаружил `Persisted onboarding state is inconsistent`. Затем `OnboardingService` очищает URL удалением userinfo, query и fragment до записи facts/approval metadata; rejected/cancelled linked approval проецируется как восстанавливаемый `DRAFT` с сохранённым proposed и null approval, без активации до нового approval. `pnpm --filter @ebb-orchestrator/server test onboarding-service.test.ts onboarding-approval-transaction.test.ts` — exit `0`, 10/10; `pnpm --filter @ebb-orchestrator/server typecheck` и `pnpm lint` — exit `0`. Browser E2E дополнен реальным reject→reload→повторный request→approve→activate: `pnpm --filter @ebb-orchestrator/web test:e2e` — exit `0`, Chromium 6/6 после сборки реального backend/frontend.
- Дополнительный RED для `ApprovalService.requestChanges` выявил существующее ограничение SQLite CHECK approvals: `CHANGES_REQUESTED` не входит в persisted `PENDING/APPROVED/REJECTED/CANCELLED`; этот путь не был молча объявлен работающим и не менялся без утверждённого migration scope. Тест на невыполнимый переход исключён из regression для исправления reject; вопрос о его влиянии на финальную приёмку передан независимому review. Два независимых read-only review текущего узкого исправления ещё ожидаются.
- После этих кодовых правок повторно выполнены `pnpm lint` — exit `0`; `pnpm typecheck` — exit `0`; `pnpm test` — exit `0`, Web 197/197, server 827 passed / 2 skipped, contracts 4/4; `pnpm build`, `pnpm server:build`, `pnpm web:build`, `git diff --check` — exit `0`. Предшествующие post-review gate rows выше сохраняются как история, не подменяют эти свежие результаты. `15-08` и parent по-прежнему не закрыты.
- Независимый scoped security review `deleg_ca261429` — `PASS` по редактированию discovered remote: новые facts/approval metadata не сохраняют URL userinfo/query/fragment, нераспознаваемые URL заменяются безопасной строкой. Независимый implementation review того же исправления подтвердил оба исходных дефекта устранёнными, но вернул `CHANGES_REQUESTED` по отдельной существующей ветке «Запросить изменения»: UI и HTTP предлагают операцию, а исторический `003_work_control.sql` CHECK отклоняет `CHANGES_REQUESTED`; запрос остаётся pending с HTTP 409. Это не исправлено в plan-15 и требует явного решения по scope: отдельная новая forward migration либо удаление неподдерживаемого действия. Исторические миграции не редактировались; `15-08`/parent остаются открытыми, roadmap не пересобирался после этого review.

## Финальная приёмка и сверка plan-15 (2026-09-26)

### RED → GREEN и независимые review

- RED исходного onboarding-регресса уже зафиксирован выше: после отрицательного approval чтение сохранённого проекта падало с `Persisted onboarding state is inconsistent`; исправление восстанавливает `DRAFT` и сохраняет историю. Для старого persisted CHECK дополнительно выполнена read-only SQLite-проверка именно на миграциях `001`–`026`:

  ```text
  $ node --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; import {readdirSync,readFileSync} from "node:fs"; import {join} from "node:path"; const dir="apps/server/src/platform/database/migrations"; const db=new DatabaseSync(":memory:"); const files=readdirSync(dir).filter(f=>f.endsWith(".sql")&&Number(f.slice(0,3))<=26).sort(); for(const file of files) db.exec(readFileSync(join(dir,file),"utf8")); db.prepare("INSERT INTO approvals (id,type,subject_id,subject_type,status,requested_by,created_at) VALUES (?,?,?,?,?,?,?)").run("approval-red","WORKFLOW_CHANGE","project-red","PROJECT","PENDING","local-user",new Date().toISOString()); let error=""; try { db.prepare("UPDATE approvals SET status=? WHERE id=?").run("CHANGES_REQUESTED","approval-red"); } catch(e) { error=e instanceof Error?e.message:String(e); } const status=db.prepare("SELECT status FROM approvals WHERE id=?").get("approval-red").status; const result={baseline:"migrations 001-026",updateError:error,approvalStatusAfter:status}; console.log(JSON.stringify(result)); if(!error.includes("CHECK constraint failed")||status!=="PENDING")process.exitCode=1; db.close();'
  {"baseline":"migrations 001-026","updateError":"CHECK constraint failed: status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')","approvalStatusAfter":"PENDING"}
  ```

  Exit `0`: проверка подтвердила исходный CHECK и отсутствие перехода из `PENDING`.
- GREEN: `pnpm --filter @ebb-orchestrator/server test test/platform/database/migrator.test.ts test/modules/approvals/approvals.test.ts test/modules/projects/onboarding-service.test.ts test/app/api.test.ts` — exit `0`, 4 файла / 53 теста; покрыты populated 026→027 upgrade, fresh schema, rollback/FK restoration, approval/outbox/audit, onboarding projection/history/re-request и HTTP.
- `pnpm --filter @ebb-orchestrator/server test test/modules/approvals/approval-service.transaction.test.ts` — exit `0`, 1 файл / 3 теста.
- `pnpm --filter @ebb-orchestrator/server test test/platform/database/backup-restore.test.ts test/platform/database/migrator.test.ts test/platform/process/startup.test.ts test/platform/security/local-user-wizard.test.ts` — exit `0`, 4 файла / 45 тестов.
- `pnpm --filter @ebb-orchestrator/server test transport-origin.test.ts v1-security.test.ts` — exit `0`, 2 файла / 6 тестов; `pnpm --filter @ebb-orchestrator/server test:auth-contract` — exit `0`, 2 файла / 12 тестов.
- Scheduler regression command `pnpm --filter @ebb-orchestrator/server test scheduler.test.ts runs-dispatch.test.ts run-event-handlers.test.ts epic-orchestrator.test.ts scheduler-projection.test.ts scheduler-fixture-inventory.test.ts` — exit `0`, 6 файлов / 52 теста.
- Post-review Web focused command из строки 592 — exit `0`, 14 файлов / 179 тестов. `pnpm --filter @ebb-orchestrator/web test:e2e` — exit `0`, Chromium 6/6; реальная кнопка отправляет request-changes (HTTP 200), повторная загрузка показывает `DRAFT`, последующий request получает новый approval ID, затем проверены rejection/re-request/approval/activation и сохранение cookie-сессии после перезапуска backend. `node --test apps/web/test/e2e/credential-handoff.test.mjs` — exit `0`, 14/14; credential-channel/teardown проверки проходят без сохранения секретов.
- Полный server suite `pnpm --filter @ebb-orchestrator/server test` — exit `0`, 93 файла / 832 passed / 2 skipped. `pnpm test` — exit `0`: contracts 4/4, Web 197/197, server 832 passed / 2 skipped. `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm server:build`, `pnpm web:build` — все exit `0`.
- Независимый implementation/security review `deleg_c01c4ea5` — `PASS`; независимый plan review `deleg_af292aea` — `APPROVED`; свежий final code/architecture review `deleg_307e2dce` — `PASS`. Блокеров `BLOCKER/IMPORTANT` нет. Остался только `MINOR`: `runMigrations` распознаёт 027 по версии/имени даже без `foreignKeys: "disabled"` (`apps/server/src/platform/database/migrator.ts:129–131`); production и основной test-loader задают flag, проверка текущей миграции проходит. Это advisory зафиксирован, не скрыт.

### Governance и promotion

- До promotion прочитаны все десять frontmatter: уникальные ID `plan-15`, `plan-15-01`–`plan-15-09`, `stage: 13`; parent был `in_progress`, `15-01`–`15-07` и `15-09` — `completed`, `15-08` — `planned`; зависимости ацикличны.
- `pnpm docs:check` до promotion — exit `0`; единственное предупреждение: `[WARNING] roadmap/generated.md — Filename does not start with numeric prefix`.
- `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — exit `0`; точный результат: `Plans collected: 29`, `Output: docs/roadmap/01-roadmap.md`.
- После прохождения acceptance gates parent `plan-15` и child `plan-15-08` переведены в `completed`; остальные восемь child уже были `completed`. История этого ledger сохранена append-only; его frontmatter не менялся.
- `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — exit `0`; точный stdout: `Roadmap generated: docs/roadmap/01-roadmap.md` / `Plans included: 29`.
- Read-back frontmatter + сгенерированного `docs/roadmap/01-roadmap.md` — exit `0`: ровно десять уникальных записей `plan-15-01`, `plan-15-02`, `plan-15-03`, `plan-15-04`, `plan-15-05`, `plan-15-06`, `plan-15-07`, `plan-15-08`, `plan-15-09`, `plan-15`; все `stage: 13`, `status: completed`; граф зависимостей ацикличен.
- `pnpm docs:check` после генерации — exit `0`; сохранилось то же единственное предупреждение про `roadmap/generated.md`.
- Plan-16 не менялся: `git hash-object docs/architecture/plans/16-documentation-cleanup-and-refresh.md` → `73ed2b4ec42627ad5820d3003421542266353ad2`. Исторические миграции `001`–`026` не изменялись; в migration status присутствует только новый файл `027_approval_changes_requested.sql`. Push/merge/commit не выполнялись; секреты в ledger не записывались.

После финальной записи ledger обязательны только терминальные проверки из `15-08`: `pnpm docs:check` → `pnpm docs:test` → `git diff --check`, без repository writes между или после них. Их точные результаты будут указаны только в итоговом отчёте.
