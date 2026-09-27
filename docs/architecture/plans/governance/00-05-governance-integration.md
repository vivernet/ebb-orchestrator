---
id: plan-00-05
kind: plan

status: completed
title: Интеграция политик документации и governance
summary: Упрощение naming/lifecycle policy и удаление дублирующей модели группировки планов из документации и governance tooling
created: 2026-09-24
updated: 2026-09-27
depends_on:
  - plan-00
specs:
  - docs/architecture/specs/01-system-design.md
evidence:
  - docs/architecture/plans/governance/00-01-documentation-governance.md
---

# Интеграция политик документации и governance — план реализации

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`.

**Goal:** интегрировать уточнённую политику именования и lifecycle, устранить из проектной документации и связанных governance/roadmap tools отдельную группировку планов, дублирующую Plan, и оставить Plan ID с `depends_on` единственной моделью идентичности и зависимостей. Уже обновлённые skills не изменять.

**Architecture:**
- `docs/development/02-documentation-governance.md` — канонический guide по naming/lifecycle/README
- Нормативные требования из вложений перечислены в `Embedded Source Requirements`; исполнителю не требуется обращаться к attachment paths.

**Tech Stack:** Markdown/YAML frontmatter, Node.js governance tooling, pnpm, Git. Сами skills в этой работе не редактируются.

**Source of Truth:** `.hermes.md`, `AGENTS.md`, актуальные repository schema/validator и связанные canonical governance документы; дополнительные согласованные требования сведены ниже в `Embedded Source Requirements`.

## Embedded Source Requirements

Ниже зафиксированы нормативные решения из пользовательских вложений, чтобы исполнителю не требовался доступ к локальным attachment paths:

- Numeric prefix используется только когда несколько документов одного типа образуют упорядочиваемую серию; уникальные по природе файлы получают описательные имена без цифрового префикса. Не выводить prefix из roadmap milestone или отдельной оси группировки планов.
- `README.md` не получает цифровой префикс или YAML frontmatter.
- Для plan-файлов сохраняются canonical filenames и IDs, установленные repository policy; Plan ID и `depends_on` задают идентичность и зависимости без второй оси группировки. Не вводить `XX`/`YY` naming convention из roadmap milestone-схемы.
- Lifecycle enum для `kind: plan`: `proposed`, `planned`, `in_progress`, `blocked`, `completed`, `superseded`, `cancelled`. Lifecycle-валидация не применяется к документам с иным `kind` (включая `kind: ledger`): их собственные статусы, например `draft`, сохраняются без нормализации и не считаются ошибкой plan lifecycle.
- Roadmap registers являются generated output; их изменяют через генератор, а не вручную.
- Согласованный индекс содержит 11 skills; обновить только соответствующий список в root `README.md`, не менять skill source files:

| Skill | Краткая ответственность для индекса |
|---|---|
| `ebb-repository-context` | Однократная разведка репозитория и компактный Context Brief для контроллера |
| `ebb-write-plan` | Исследование требований и создание implementation plan |
| `ebb-review-plan` | Независимая read-only проверка плана |
| `ebb-execute-plan` | Ledger зависимостей, запуск готовых задач и whole-plan closeout |
| `ebb-implement-task` | Реализация одной задачи, TDD, task review и необходимые локальные проверки |
| `ebb-debug-issue` | Воспроизведение, root-cause analysis и выбор bounded fix или плана |
| `ebb-review-task` | Read-only проверка диффа одной задачи |
| `ebb-quality-gates` | Выбор и выполнение необходимых проверок с evidence |
| `ebb-security-review` | Проверка trust boundaries и security-регрессий |
| `ebb-web-e2e` | Проверка реальных browser/HTTP/SSE сценариев |
| `ebb-final-review` | Независимая попытка опровергнуть готовность всего изменения |

Английские названия responsibilities являются краткими пояснениями, а не новыми требованиями к содержимому skills.

## Acceptance Criteria

- Naming/lifecycle decisions in `Embedded Source Requirements` are integrated in canonical docs.
- Только точные пути корневого `README.md` и `docs/README.md` исключены из frontmatter/id validation; `checkDocs` по-прежнему применяет filename validation ко всем scanned records и lifecycle validation к plan metadata.
- Валидатор `pnpm docs:check` проверяет lifecycle enum только для `kind: plan`; documents with other `kind` retain their own statuses (including evidence `status: draft`) without plan-lifecycle validation.
- Normal `pnpm docs:check` pipeline owned by `scripts/docs-governance.mjs` combines recursive `docs/` scan records `{ path, fullPath, metadata, body }` (where scan `path` is slash-normalized relative to `docs/`) with an explicit root `README.md` record. Before validation, `checkDocs` normalizes every path to a slash-separated repository-relative path (`docs/${scanPath}` for scanned docs records; `README.md` for the root record). Only exact `README.md` and `docs/README.md` paths skip missing-frontmatter/`id` errors; filename checks still run, and every other record retains existing frontmatter/`id` and filename checks. For each record with plan metadata, `checkDocs` adapts `{ kind: metadata.kind, status: metadata.status }` and calls pure `validatePlanLifecycle(record)` from `docs-governance-lib.mjs`; map returned lifecycle issues to the CLI issue shape without replacing existing checks. The library exports no `runDocsCheck` seam.
- Во всех документах проекта удалены упоминания отдельной группировки планов, дублирующей Plan; порядок, идентичность и зависимости задаются Plan IDs и `depends_on`.
- Связанные schema, parser, collector, roadmap generators и их tests не требуют и не производят дублирующую группировку; generated roadmaps строятся только из Plan metadata и зависимостей.
- Независимые runtime workflow concepts не переименовываются и не меняют семантику.
- Generated roadmap регенерируется через `pnpm docs:roadmap`
- Numeric prefix применяется только к нескольким документам одного типа, составляющим упорядочиваемую серию; уникальные по природе документы получают описательные имена без цифрового префикса. Исключения и machine-managed categories определяет canonical policy/schema.
- README.md остаётся уникальным индексом без numeric prefix и plan frontmatter.
- Skills не переустанавливаются, не переписываются и не валидируются как часть их содержимого; разрешено обновить только перечень состава/ответственности в root `README.md`.
- Все repository gates проходят

## Global Constraints

- Основная ветка — `master`; не merge/push/rebase/reset/clean/tag/release
- Работать в текущем worktree
- Максимум два одновременно работающих субагента
- Production comments — русский; technical identifiers не переводить
- Preserve unrelated changes

## Verified Baseline Before Implementation

- `pnpm docs:test`: PASS, 11/11 tests.
- `pnpm docs:check`: exit 0 with a warning that unique `docs/roadmap/generated.md` lacks a numeric prefix; Task 3 must make the validator honor the unique-file rule and add a regression test, not rename the generated file.
- `pnpm docs:inventory`: 67 files. The expanded content scan currently returns 618 matching lines across 96 paths; the tracked-filename scan returns 2 paths. These are pre-migration counts, not final acceptance totals; Task 1 must rerun all three inventories and classify every result.
- `pnpm exec tsx --test scripts/plan-collector.test.ts`: PASS, 6/6 tests against the current legacy grouping API; Task 2 must replace those assertions with Plan-only collection checks.
- The current combined Vitest invocation is not a valid gate because `scripts/plan-collector.test.ts` uses `node:test`, not Vitest. The parser tests also currently assert obsolete metadata and stale status (`proposed` while the fixture is `completed`); Task 2 must update those assertions to the approved metadata contract and actual fixture facts. Do not weaken tests to preserve the legacy field.

## Review Focus

1. Префикс требуется только для повторяющихся документов одного типа; уникальность нельзя определять простым исключением произвольного списка имён или ослаблением всей filename validation.
2. README exception не должен отключить validation для других unnumbered docs.
3. Plan ID, filename и `depends_on` согласованы; в metadata и roadmap нет второй оси группировки планов.
4. `completed` нельзя выставить только из-за успешного Hermes exit code.
5. Generated roadmap не становится вторым writable source of truth.
6. Existing superseded/evidence docs не превращаются ошибочно в active implementation plans; исторические даты, статусы и результаты сохраняются, а устаревшая группировка излагается через Plan IDs или удаляется.
7. Runtime workflow concepts сохраняют прежнюю семантику и не меняются в рамках этой миграции.
8. Не изменять содержимое skills или другие skill indexes; синхронизировать только перечень состава/ответственности в root `README.md`.

## Task Dependency Map

| Task | Depends on | Produces | Consumed by |
|---|---|---|---|
| 1 | — | complete reference inventory and migration decisions | 2, 3, 4 |
| 2 | 1 | canonical Plan metadata and parser/collector contract | 3, 4 |
| 3 | 2 | roadmap and governance generators without duplicate grouping | 4, 5 |
| 4 | 1, 2, 3 | normalized documentation and regenerated roadmaps | 5 |
| 5 | 2, 3, 4 | verified migration and independent review | — |

### Task 1: Составить полный inventory и классифицировать упоминания

**Purpose:** найти все occurrences retired planning-grouping concept в tracked project files, отделить его от независимых runtime workflow concepts и определить целевые изменения до массовой нормализации.

**Owner:** governance inventory agent.

**Files:**
- Create: `docs/architecture/plans/governance/evidence/06-plan-grouping-removal-inventory.md`
- Read: `docs/architecture/plans/governance/00-01-documentation-governance.md`, `docs/development/02-documentation-governance.md`, `scripts/plan-parser.ts`, `scripts/plan-collector.ts`, `scripts/docs-governance-lib.mjs`, `scripts/docs-governance.mjs`, `README.md`, and tracked files returned by the repository-wide search.
- Read: `docs/README.md` and inspect tracked schema-named files; existing runtime database schemas are not plan metadata schemas.
- Read: `Embedded Source Requirements` in this plan; do not depend on local attachment paths.
- Do not modify: skill files, application runtime contracts, or user-unrelated worktree files.

**Interfaces:**
- Produces: inventory with exact path and line, context category, action, target/owner, and rationale; records all exact docs paths consumed by Task 4 and exact schema/validator owners.
- Consumes: naming/lifecycle rules and skill-index data embedded in this plan.

**Acceptance for this task:**
- Inventory covers documentation, metadata/parser/collector, both roadmap generation paths, and their tests.
- Inventory identifies where plan metadata is actually defined/validated and records whether a separate plan schema file exists; do not infer a standalone schema from database-schema files. Current known owners are `docs/architecture/plans/governance/00-01-documentation-governance.md`, `docs/development/02-documentation-governance.md`, `scripts/plan-parser.ts`, and `scripts/docs-governance.mjs`.
- Every hit is classified as obsolete plan grouping, distinct runtime workflow meaning, or unrelated text; no global replacement is applied blindly.
- Historical dates, statuses and test results are preserved while obsolete grouping references are rewritten in Plan terms or removed.
- `README.md` section `Hermes development skills` is reconciled with the embedded 11-skill table; no other skill-related file may be modified.
- Skill source files and all other skill indexes/references remain untouched.

- [x] **Step 1:** Run `pnpm docs:inventory`, `git grep -inE '[sS][tT][aA][gG][eE]|roadmap[Ss][tT][aA][gG][eE]|grouped[Bb]y[Ss][tT][aA][gG][eE]|groupInto[Ss][tT][aA][gG][eE]|render[Ss][tT][aA][gG][eE]Register|groupBy[Ss][tT][aA][gG][eE]|[sS][tT][aA][gG][eE]sMap' -- . ':(exclude)docs/architecture/plans/governance/00-05-governance-integration.md'`, and `git ls-files | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s.split(String.fromCharCode(10)).filter(p=>/[sS][tT][aA][gG][eE]|roadmap[sS][tT][aA][gG][eE]|grouped[Bb]y[Ss][tT][aA][gG][eE]|groupInto[Ss][tT][aA][gG][eE]|render[Ss][tT][aA][gG][eE]Register|groupBy[Ss][tT][aA][gG][eE]|[sS][tT][aA][gG][eE]sMap/i.test(p)).join(String.fromCharCode(10))))"`; record output counts, every matching path/line and matching path name in the inventory without copying matched prose. The patterns cover the metadata key, migration-map alias, collector/generator helpers, and generated register names found during discovery.
- [x] **Step 2:** Trace each script/test occurrence to its parser, collector, generator, migration-map, metadata validator, or runtime consumer; inspect tracked schema candidates and document the actual owner paths.
- [x] **Step 3:** Record each path's action, target, owner and verification; only root `README.md` section `Hermes development skills` is an allowed skill-related edit.
- [x] **Step 4:** Reconcile content hits, filename hits, and metadata inventory by exact path/line; document any broad-search false positives and confirm no matching path is omitted. Confirm Task 2–4 owners cover every obsolete planning-grouping reference.

### Task 2: Утвердить Plan-only metadata и обновить parser/collector

**Purpose:** сделать Plan ID и `depends_on` единственной моделью идентичности, порядка и зависимостей планов; исключить поле и API второй плановой группировки.

**Owner:** plan metadata implementer.

**Files:**
- Modify: `docs/architecture/plans/governance/00-01-documentation-governance.md`
- Modify: `docs/development/02-documentation-governance.md`
- Modify: `scripts/plan-parser.ts`
- Modify: `scripts/plan-collector.ts`
- Modify: `scripts/plan-parser.test.ts`
- Modify: `scripts/plan-parser.integration.test.ts`
- Modify: `scripts/plan-collector.test.ts`

**Dependencies:** Task 1.

**Interfaces:**
- Consumes: Task 1 inventory and current plan frontmatter.
- Produces: Plan metadata contract without duplicate grouping property; collection ordered/reconciled by Plan IDs and explicit dependencies only.

**Acceptance for this task:**
- Plan metadata contract is explicit: required fields are `id: string`, `kind: 'plan'`, `status: PlanStatus` (`'proposed' | 'planned' | 'in_progress' | 'blocked' | 'completed' | 'superseded' | 'cancelled'`), `title: string`, `created: string` (ISO `YYYY-MM-DD`), and `updated: string` (ISO `YYYY-MM-DD`). Optional fields are `summary: string`, `depends_on: string[]`, `specs: string[]`, and `evidence: string[]`; when present, each must have the stated type. Retired grouping keys are outside this contract.
- `scripts/plan-parser.ts` exports the `PlanStatus` union and declares `PlanMetadata` with exactly the required/optional fields above, without retired grouping metadata; `parsePlan` validates required field presence/types, `kind === 'plan'`, valid lifecycle enum membership, ISO calendar-date strings, and optional field types, rejecting malformed or invalid enum values rather than coercing them.
- Contract ownership for this task is limited to the two policy documents (`docs/architecture/plans/governance/00-01-documentation-governance.md`, `docs/development/02-documentation-governance.md`), TypeScript `PlanMetadata`/`parsePlan` and `collectPlans` (`scripts/plan-parser.ts`, `scripts/plan-collector.ts`), and their listed TypeScript tests. The CLI and docs-governance implementations/tests are owned exclusively by Task 3.
- TypeScript parser and collector tests verify the required/optional contract, preserve IDs and dependency arrays, and expose no retired grouping metadata or grouping API. Independent runtime workflow concepts in application modules are unaffected.

- [x] **Step 1 — RED:** add/update only TypeScript parser/collector tests for required fields/types, optional fields/types (including absent and present `summary`), valid Plan frontmatter containing only the canonical contract, ID/dependency preservation, rejection of missing required fields, wrong field types, invalid `kind`, invalid `PlanStatus`, and malformed dates, and absence of retired grouping metadata/API.
- [x] **Step 2 — GREEN:** implement the explicit contract only in the policy documents and TypeScript parser/collector and their tests; `PlanMetadata`/`parsePlan` must express and enforce the required/optional typed contract and reject invalid lifecycle/type values. Do not edit either roadmap-generation path or docs-governance parser/collector/model/tests (Task 3 owns those files).
- [x] **Step 3 — Verify:** run `pnpm exec vitest run scripts/plan-parser.test.ts scripts/plan-parser.integration.test.ts` and `pnpm exec tsx --test scripts/plan-collector.test.ts`. Expected: all pass; parser/collector enforce required/optional field types, reject invalid PlanStatus and malformed metadata, and expose no removed grouping metadata/API.

### Task 3: Удалить вторую группировку из roadmap/governance tooling

**Purpose:** привести оба независимых roadmap-generation paths (`scripts/roadmap-generator.ts` и CLI path `scripts/roadmap-generator-cli.mjs`) и documentation-governance model к Plan-only projection без отдельного register/grouping.

**Owner:** roadmap tooling implementer.

**Files (exclusive Task 3 ownership; no Task 2 files):**
- Modify: `scripts/roadmap-generator.ts` (first roadmap path)
- Modify: `scripts/roadmap-generator-cli.mjs` (second, independent roadmap path; add `--plans-root=<path>` argument whose default remains `<repository-root>/docs/architecture/plans`; current source has no plans-root option. Preserve existing `--output=<path>` option and its default `docs/roadmap/generated.md`.)
- Modify: `scripts/docs-governance-lib.mjs` (export a pure, fixture-testable `validatePlanLifecycle(record)` helper that validates only `record.kind === 'plan'` against the Task 2 PlanStatus enum and returns lifecycle issues without mutating input; preserve non-Plan records/status verbatim)
- Modify: `scripts/docs-governance.mjs` (sole owner of the normal `check` pipeline: `scanDocs`/`checkDocs`/`checkCommand`; `checkDocs` adapts scanned file records to `{ kind, status }` and calls the library lifecycle helper; also owns `parsePlanFile`/`collectPlans` and roadmap model/rendering). Do not add a `runDocsCheck(files)` library seam.
- Modify: `scripts/roadmap-generator.test.ts`
- Modify: `scripts/roadmap-generator.integration.test.ts`
- Create: `scripts/roadmap-generator-cli.test.mjs` (node:test subprocess coverage for the independent CLI entry point; no CLI-specific test file currently exists)
- Modify: `scripts/docs-governance.test.mjs` (docs-governance and filename-validation tests)
- Do not modify: Task 2 policy documents or TypeScript metadata parser/collector/tests listed under Task 2.

**Dependencies:** Task 2.

**Interfaces:**
- Consumes: Task 1 inventory and the exact required/optional Plan metadata contract fixed by Task 2; both roadmap paths and docs-governance must conform to that contract rather than redefining it.
- Produces: canonical plan registers and dependency graphs; no extra grouping tables, columns, headings, metadata, or instructions.

**Acceptance for this task:**
- Both independent roadmap paths (`scripts/roadmap-generator.ts` and `scripts/roadmap-generator-cli.mjs`) and docs-governance `parsePlanFile`/`collectPlans` plus roadmap model consume Task 2's exact Plan metadata contract: required `id`, `kind: 'plan'`, `status: PlanStatus`, `title`, `created`, `updated`; optional `summary`, `depends_on`, `specs`, `evidence` with Task 2 types; no retired grouping metadata. For each independent parser, use a parallel table-driven matrix (same cases and expected outcomes as Task 2 TypeScript parser; literal fixture sharing is optional): valid required-only fields; valid optional fields absent; valid optional fields present; each required field missing; each required and optional field wrong-typed; invalid kind; every valid PlanStatus accepted and invalid status rejected; malformed dates rejected. CLI/parser collection cases must run against isolated fixture content. Do not change Task 2's contract.
- CLI accepts `--plans-root=<temporary-directory>` (new; default remains `<repository-root>/docs/architecture/plans`) and existing `--output=<temporary-file>` (default remains `docs/roadmap/generated.md`). Subprocess test creates a temp root containing exactly one valid Plan (`id: plan-91`, `title: CLI Fixture Plan`, `status: planned`, `depends_on: [plan-90]`) and one `kind: ledger, status: draft` record, then invokes `node scripts/roadmap-generator-cli.mjs --plans-root=<root> --output=<temp-output>`. Assert exit code exactly `0`; stdout exactly `Roadmap generated: <temp-output>\nPlans included: 1\n`; stderr empty; output file includes the fixture ID/title/status and dependency edge `plan-90 → plan-91`, excludes ledger ID/title, and contains no obsolete grouping heading or column. The repository's generated roadmap must remain untouched.
- `scripts/docs-governance-lib.mjs` exports pure `validatePlanLifecycle(record)` returning lifecycle issues without mutating input; its input is a minimal normalized `{ kind, status }` record derived by CLI `checkDocs` from each scanned record's raw `metadata`. The normal owner remains CLI `checkDocs`, which maps helper issues into existing `{ file, severity, message }` issues while preserving metadata/id and filename checks. Direct helper tests exercise all seven PlanStatus values, missing/invalid status, and non-Plan `{ kind: 'ledger', status: 'draft' }` no-op plus input immutability; a real check-command subprocess regression proves this helper is integrated in the normal check path. Do not export or add `runDocsCheck(files)` to the library.
- Export the pure `validatePlanMetadata(metadata, source)` helper from `scripts/docs-governance.mjs` and have private `parsePlanFile(path)` parse YAML then call it. The helper accepts parsed frontmatter and optional source label, returns validated metadata on success, and throws a typed `PlanMetadataError` on any missing/invalid required or optional field, wrong type, invalid kind/status, or malformed calendar date. `collectPlans(dir)` remains immediate-directory `.md` scanning; it catches that typed error, warns with the path and reason, skips the invalid file, and continues collecting valid Plans. Tests directly exercise the pure helper with the full contract matrix and use a temp directory to verify collector valid inclusion plus invalid-file warn-and-skip behavior (including exact warning/error class assertions).
- `scripts/docs-governance.test.mjs` independently covers its `parsePlanFile`/collector against the full parallel required/optional/wrong-type/status/date matrix above, plus collection of a valid Plan and exclusion/preservation of non-Plan `kind: ledger, status: draft`.
- All three projections select only documents with `kind: plan`, preserve Plan IDs/statuses/`depends_on` edges, and do not group Plans under a second hierarchy or emit second grouping output.
- RED fixtures prove each roadmap path and docs-governance parser/model exclude a Markdown document with `status` but `kind` other than `plan`, include `kind: plan`, and emit no parallel grouping.
- `roadmap/generated.md` keeps its canonical path and unprefixed unique filename; generators never add a second source of truth.
- Governance tooling and migration-map parser no longer require legacy grouping data.
- Generator tests assert the Task 2 contract is consumed consistently, Plan IDs, statuses and dependency edges survive, generated output contains no second grouping register/column, and empty input remains valid.
- Filename-validation tests prove four cases: (1) repeated document type with numeric prefixes passes; (2) unique `roadmap/generated.md` without prefix passes; (3) root `README.md` without prefix/frontmatter passes; (4) unprefixed member of a repeated-document-type fixture fails. The CLI-owned `checkCommand(repositoryRoot = ROOT)` scans `repositoryRoot/docs`, explicitly adds root `README.md`, then calls its own `checkDocs(files)` pipeline (no parallel library check seam). `checkDocs` receives records `{ path, fullPath, metadata, body }`; `path` is slash-normalized relative to `repositoryRoot` for the explicit root record and relative to `repositoryRoot/docs` for docs scan records only if used for normal docs-relative display—normalize to one repository-relative path before README exemption/comparison, e.g. `docs/...`. Exact `README.md` and `docs/README.md` skip only metadata/frontmatter/required-id checks; filename validation continues to run, but the existing filename rule explicitly allows any basename `README.md`, so no honest negative filename warning can be produced for either README exemption path. Prove the boundary in the real check-command fixture by including frontmatter-free root `README.md` and `docs/README.md` plus a metadata-valid, unprefixed non-README file such as `docs/unprefixed.md`; assert neither README has metadata errors and `docs/unprefixed.md` produces the exact `Filename does not start with numeric prefix` warning. This shows the metadata exemption does not disable filename validation, without claiming README names themselves can fail that rule. Ordinary documents retain existing metadata/id and filename checks. `checkDocs` calls library `validatePlanLifecycle({ kind: file.metadata?.kind, status: file.metadata?.status })` for plan lifecycle and maps results into existing CLI issues.
- Runtime workflow semantics remain unchanged.

- [x] **Step 1 — RED:** add/update only Task 3 tests. For docs-governance, test exported `validatePlanMetadata(metadata, source)` directly with required-only valid metadata, optional fields absent/present, each required field missing, each required/optional field wrong-typed, invalid kind, all seven valid statuses plus invalid status, and malformed calendar dates; assert successful metadata or typed `PlanMetadataError` as appropriate. Add temp-directory collector tests proving immediate-directory valid Plan inclusion, ledger exclusion/preservation, typed invalid-file warning and skip while subsequent valid Plans are collected. Add a real check-command subprocess regression using a temporary repository root and exact invocation `node scripts/docs-governance.mjs check --root=<temp-repository-root>` (add this minimal `--root` option; default is the repository root). Its fixture has frontmatter-free `<root>/README.md` and `<root>/docs/README.md`, plus an ordinary non-README Markdown document under `docs/` with missing/invalid required metadata; assert exit `1`, both README paths have no metadata errors, and the ordinary document is reported. Include a separate metadata-valid, unprefixed `<root>/docs/unprefixed.md` record and assert the exact `Filename does not start with numeric prefix` warning for it. Do not expect either README path to produce a filename warning: the current filename rule explicitly allows every basename `README.md`, so such a negative README filename case is impossible under the actual validator. Also assert a fixture with only the two README indexes exits `0`. This exercises the actual CLI `scanDocs` + `checkDocs` pipeline used by `pnpm docs:check`; verify default `pnpm docs:check` still uses the repository root. Add the CLI subprocess case with exact arguments `node scripts/roadmap-generator-cli.mjs --plans-root=<temp-root> --output=<temp-output>`; assert exit `0`, exact stdout `Roadmap generated: <temp-output>\\nPlans included: 1\\n`, empty stderr, and output file inclusion/exclusion/content specified above. Add equivalent isolated parser matrix for the independent CLI path and the four filename-validation cases. Add lifecycle helper unit cases and assert through the check-command regression that invalid plan lifecycle is reported through the normal path while ledger `draft` is accepted.
- [x] **Step 2 — GREEN:** implement Task 2 contract consumption in both roadmap paths and docs-governance parser/collector/model; add CLI `--plans-root=<path>` (source inspection confirms it does not exist) with default `<repository-root>/docs/architecture/plans`, preserving existing `--output=<path>` and default `docs/roadmap/generated.md`; export only pure `validatePlanLifecycle(record)` from `scripts/docs-governance-lib.mjs`. Keep normal check ownership in `scripts/docs-governance.mjs`: `checkCommand(repositoryRoot = ROOT)` scans `<root>/docs`, explicitly adds `<root>/README.md`, normalizes record paths relative to `<root>` using `/`, and passes records to its existing `checkDocs(files)`. `checkDocs` skips only metadata/frontmatter/required-id checks for exact `README.md` and `docs/README.md`, but applies its existing filename rule unchanged: basename `README.md` is unconditionally allowed, and other unprefixed names produce the existing warning. Support `--root=<path>` for isolated subprocess fixtures; export `validatePlanMetadata` and typed `PlanMetadataError` from `scripts/docs-governance.mjs`, and make `parsePlanFile` use it.
- [x] **Step 3 — Verify:** run `pnpm exec vitest run scripts/roadmap-generator.test.ts scripts/roadmap-generator.integration.test.ts`, `node --test scripts/roadmap-generator-cli.test.mjs`, and `pnpm docs:test` (includes `scripts/docs-governance.test.mjs`). Expected: all pass; independent parser matrices enforce the contract; CLI subprocess proves temporary-root selection, exact exit/stdout, output content and no repository generated-file write; normal check subprocess proves CLI-owned scan/check integration, lifecycle helper reporting, path-specific README exemption, retained metadata/id and filename checks; typed parser errors, collector warning/skip behavior, and all four filename cases pass; roadmap paths preserve IDs/status/dependencies and emit no second grouping.

### Task 4: Нормализовать всю документацию и regenerate roadmaps

**Purpose:** устранить все обнаруженные в Task 1 planning-grouping references из документации, включая policies, plans, specs, README, audits, evidence, manual/generated roadmaps и skill composition indexes.

**Owner:** documentation migration implementer.

**Files:**
- Modify: exact tracked Markdown paths enumerated in `docs/architecture/plans/governance/evidence/06-plan-grouping-removal-inventory.md`.
- Modify: `docs/roadmap/01-roadmap.md` only for manual sections; generated sections remain generator-owned.
- Regenerate: `docs/roadmap/generated.md` through `pnpm docs:roadmap`.
- Modify: `README.md`, update the `Hermes development skills` inventory to the embedded 11-skill catalog and replace its stale partial `Планы реализации` register with a link to the generated Plan roadmap; make no other root README content changes and keep README free of YAML frontmatter.
- Modify: `docs/README.md`, update only obsolete planning-grouping references; keep README index free of YAML frontmatter. The Task 3 CLI-owned normal `pnpm docs:check` path exempts only exact root `README.md` and `docs/README.md` from metadata/frontmatter/required-id checks, while retaining applicable filename checks and all checks for other documents.
- Removed: `docs/architecture/plans/governance/00-03-plan-naming-policy.md` after canonical policy integration and inbound-link audit; its only inbound reference was this plan.
- Renamed the legacy merge-decision evidence file listed in Task 1's inventory to `docs/architecture/plans/governance/merge-decisions.md`; updated its two recorded target paths in `workspace/link_analysis.json` and preserved the evidence metadata and factual content.
- Rename: only document filenames whose Task 1 classification confirms they encode the obsolete Plan grouping; use the naming policy and update inbound links. Preserve runtime/unrelated filenames even when the broad search matches them.
- Do not modify: any skill source file or skill-related path other than the named section in root `README.md`.

**Dependencies:** Tasks 1–3.

**Interfaces:**
- Consumes: canonical policy, parser/generator contract, and exact paths from Task 1 inventory.
- Produces: coherent Plan-only documentation and generated roadmaps with historical facts retained in unambiguous Plan terms.

**Acceptance for this task:**
- Every tracked documentation occurrence classified as the obsolete planning grouping is removed or rewritten; historical evidence retains dates, statuses and outcomes without preserving the confusing label.
- Runtime workflow documentation uses clear terminology for its distinct domain meaning and is never presented as Plan grouping.
- All Plan metadata omits the retired grouping fields and follows Task 2's explicit contract. Non-Plan metadata is preserved unchanged.
- README remains unprefixed and without plan frontmatter.
- `README.md` lists the 11 skills and responsibilities from `Embedded Source Requirements`; no other skill-related file changes.
- Root `README.md` contains no competing partial Plan register; its canonical Plans entry point is `docs/roadmap/generated.md`.
Filename-validation tests demonstrate the four cases: repeated document type with numeric prefixes passes; unique `roadmap/generated.md` without a prefix passes; root `README.md` without prefix/frontmatter passes; arbitrary invalid unprefixed document fails. A regression through the real normal `pnpm docs:check` path verifies only exact root `README.md` and `docs/README.md` bypass metadata/frontmatter/required-id checks, while the unchanged filename rule still warns on a metadata-valid unprefixed non-README fixture such as `docs/unprefixed.md`. The current validator explicitly allows any filename whose basename is `README.md`, so neither README exemption path can honestly serve as a negative filename-warning case; the regression must assert no README metadata errors and the sibling non-README warning instead.
- All `README.md` index files remain unprefixed and have no YAML frontmatter.
- Generated output is changed only by its canonical generator.

- [x] **Step 1:** Update canonical naming/lifecycle policy and governance guide; remove obsolete metadata and duplicate lifecycle/grouping rules.
- [x] **Step 2:** Apply the inventory to all listed documentation paths; preserve facts while replacing only obsolete planning-grouping language with Plan IDs/dependencies or removing redundant prose.
- [x] **Step 3:** Rename only affected document filenames classified as obsolete Plan grouping; update inbound links and verify the unique-vs-repeated type rule. Leave runtime/unrelated names untouched.
- [x] **Step 4:** Regenerate `docs/roadmap/generated.md`; inspect `docs/roadmap/01-roadmap.md` and generated output for duplicate grouping and stale metadata.
- [x] **Step 5:** Update the root README `Hermes development skills` inventory to the embedded 11-skill catalog and replace its stale partial `Планы реализации` register with a link to `docs/roadmap/generated.md`; these are the only root README content changes. Make no changes to skill source files or unrelated skill references. Keep root `README.md` and `docs/README.md` without frontmatter; ensure the CLI-owned normal `pnpm docs:check` pipeline exempts only these exact README paths from metadata/frontmatter/required-id checks while retaining applicable filename rules and validation of every other document.
- [x] **Step 6:** Re-run the Task 1 content and filename searches, then run the content search against this plan separately; Expected: no hits in this plan, no obsolete planning model remains in docs/tool behavior, and all remaining runtime hits match the Task 1 classification.

### Task 5: Полная verification и independent review

**Purpose:** подтвердить целостность Plan metadata, documentation links, generated outputs and repository gates.

**Owner:** verification controller; final review is a fresh read-only reviewer.

**Files:**
- Read: complete Task 1 inventory and all changed documentation/tooling.
- Inspect: full scoped diff for this migration; preserve unrelated worktree changes.

**Dependencies:** Tasks 2–4.

**Acceptance for this task:**
- `pnpm docs:test`, `pnpm docs:check`, `pnpm docs:roadmap`, then a second `pnpm docs:check` pass.
- `pnpm exec vitest run scripts/plan-parser.test.ts scripts/plan-parser.integration.test.ts scripts/roadmap-generator.test.ts scripts/roadmap-generator.integration.test.ts`, `pnpm exec tsx --test scripts/plan-collector.test.ts`, `node --test scripts/roadmap-generator-cli.test.mjs`, and `pnpm docs:test` pass.
- Repository gates `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm hermes:check` pass where applicable; any unavailable/irrelevant gate is documented with evidence.
- `git diff --check` passes and no generated output remains stale.
- `git diff --name-only -- apps packages` is empty; runtime contracts and unrelated app work are untouched.
- Independent `ebb-review-plan`/change review returns `APPROVED`; findings are fixed and re-reviewed.

- [x] **Step 1:** Run `pnpm exec vitest run scripts/plan-parser.test.ts scripts/plan-parser.integration.test.ts scripts/roadmap-generator.test.ts scripts/roadmap-generator.integration.test.ts`, `pnpm exec tsx --test scripts/plan-collector.test.ts`, `node --test scripts/roadmap-generator-cli.test.mjs`, and `pnpm docs:test`; Expected: all suites pass and assert Plan IDs/dependencies, absence of the extra grouping, and all four filename cases.
- [x] **Step 2:** Run repository gates from `package.json`; record commands and results.
- [x] **Step 3:** Perform a final scoped search and inspect the complete diff for unintended edits, missing links or unrelated changes.
- [x] **Step 4:** Obtain fresh independent review; resolve findings and request targeted re-review. **Review result:** the fresh full-diff review returned `CHANGES_REQUESTED`; targeted read-only adjudication returned `PASS`. All three findings were false positives: evidence 06 line 141 explicitly lists the two untracked paths, and the supplemental scan returned exactly two expected CLI-test hits at lines 36 and 62; the JavaScript validator and TypeScript parser enforce the exact required/optional Plan contract in lines 163–164 and 196, while line 239 preserves non-Plan metadata; the pending commit is a separate repository-authorization gate, not a review finding.
- [x] **Step 5:** Commit only approved migration files when they can be isolated safely; never push or merge.
