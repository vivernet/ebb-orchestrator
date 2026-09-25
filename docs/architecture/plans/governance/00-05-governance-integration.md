---
id: plan-00-05
kind: plan
roadmap: 01
status: planned
title: Интеграция политик документации и governance
summary: Упрощение naming/lifecycle policy и удаление дублирующей модели группировки планов из документации и governance tooling
created: 2026-09-24
updated: 2026-09-25
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
- Lifecycle enum: `proposed`, `planned`, `in_progress`, `blocked`, `completed`, `superseded`, `cancelled`.
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
- `README.md` явно исключён из numeric-prefix/frontmatter requirements
- Валидатор `pnpm docs:check` проверяет lifecycle enum и naming rules
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

- [ ] **Step 1:** Run `pnpm docs:inventory`, `git grep -inE '[sS][tT][aA][gG][eE]|roadmap[Ss][tT][aA][gG][eE]|grouped[Bb]y[Ss][tT][aA][gG][eE]|groupInto[Ss][tT][aA][gG][eE]|render[Ss][tT][aA][gG][eE]Register|groupBy[Ss][tT][aA][gG][eE]|[sS][tT][aA][gG][eE]sMap' -- . ':(exclude)docs/architecture/plans/governance/00-05-governance-integration.md'`, and `git ls-files | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s.split(String.fromCharCode(10)).filter(p=>/[sS][tT][aA][gG][eE]|roadmap[sS][tT][aA][gG][eE]|grouped[Bb]y[Ss][tT][aA][gG][eE]|groupInto[Ss][tT][aA][gG][eE]|render[Ss][tT][aA][gG][eE]Register|groupBy[Ss][tT][aA][gG][eE]|[sS][tT][aA][gG][eE]sMap/i.test(p)).join(String.fromCharCode(10))))"`; record output counts, every matching path/line and matching path name in the inventory without copying matched prose. The patterns cover the metadata key, migration-map alias, collector/generator helpers, and generated register names found during discovery.
- [ ] **Step 2:** Trace each script/test occurrence to its parser, collector, generator, migration-map, metadata validator, or runtime consumer; inspect tracked schema candidates and document the actual owner paths.
- [ ] **Step 3:** Record each path's action, target, owner and verification; only root `README.md` section `Hermes development skills` is an allowed skill-related edit.
- [ ] **Step 4:** Reconcile content hits, filename hits, and metadata inventory by exact path/line; document any broad-search false positives and confirm no matching path is omitted. Confirm Task 2–4 owners cover every obsolete planning-grouping reference.

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
- Parser type and validation no longer require/return the obsolete grouping field.
- Collector no longer exports a grouping helper for that field.
- New plan frontmatter is valid without the legacy grouping metadata; the two policy documents and parser agree on the required fields: filenames, IDs, status, `depends_on`, `specs`, and `evidence`.
- Independent runtime workflow concepts in application modules are unaffected.
- Focused tests assert the collected plans preserve each ID and `depends_on` list and return no grouping property.

- [ ] **Step 1 — RED:** add/update parser and collector tests proving plans without legacy grouping metadata parse and collect, `Plan ID` and `depends_on` are retained, and no grouping property is returned.
- [ ] **Step 2 — GREEN:** remove legacy field and grouping API from parser/collector; update focused tests.
- [ ] **Step 3 — Verify:** run `pnpm exec vitest run scripts/plan-parser.test.ts scripts/plan-parser.integration.test.ts` and `pnpm exec tsx --test scripts/plan-collector.test.ts`; Expected: both parser tests and all collector tests pass with assertions for Plan IDs/dependencies and no legacy grouping field/API.

### Task 3: Удалить вторую группировку из roadmap/governance tooling

**Purpose:** привести оба существующих roadmap-generation paths и documentation-governance model к Plan-only projection без отдельного register/grouping.

**Owner:** roadmap tooling implementer.

**Files:**
- Modify: `scripts/roadmap-generator.ts`
- Modify: `scripts/roadmap-generator-cli.mjs`
- Modify: `scripts/docs-governance-lib.mjs`
- Modify: `scripts/docs-governance.mjs`
- Modify: `scripts/roadmap-generator.test.ts`
- Modify: `scripts/roadmap-generator.integration.test.ts`
- Modify: `scripts/docs-governance.test.mjs`

**Dependencies:** Task 2.

**Interfaces:**
- Consumes: Plan-only metadata from Task 2 and the reference inventory.
- Produces: canonical plan registers and dependency graphs; no extra grouping tables, columns, headings, metadata, or instructions.

**Acceptance for this task:**
- Generated roadmap lists Plans by stable ID and exposes `depends_on` relationships without grouping Plans under a second hierarchy.
- `roadmap/generated.md` keeps its canonical path and unprefixed unique filename; generators never add a second source of truth.
- Governance tooling and migration-map parser no longer require legacy grouping data.
- Generator tests assert that Plan IDs, statuses and dependency edges survive; generated output contains no second grouping register/column; empty input remains valid.
- Filename-validation tests prove all four cases: a repeated document type with numeric prefixes passes; a unique `roadmap/generated.md` without prefix passes; `README.md` without prefix/frontmatter passes; an unprefixed member of a repeated-document-type fixture fails.
- Runtime workflow semantics remain unchanged.

- [ ] **Step 1 — RED:** add/update parser/generator tests asserting Plan ID/dependency preservation and absence of a second grouping register/column; add the four filename-validation cases in `scripts/docs-governance.test.mjs`.
- [ ] **Step 2 — GREEN:** update both generators and governance model; remove obsolete grouping transforms and migration-map data columns.
- [ ] **Step 3 — Verify:** run `pnpm exec vitest run scripts/roadmap-generator.test.ts scripts/roadmap-generator.integration.test.ts` and `pnpm docs:test`; Expected: focused tests pass, generated model preserves Plan IDs/dependency edges, and filename validator tests cover all four cases.

### Task 4: Нормализовать всю документацию и regenerate roadmaps

**Purpose:** устранить все обнаруженные в Task 1 planning-grouping references из документации, включая policies, plans, specs, README, audits, evidence, manual/generated roadmaps и skill composition indexes.

**Owner:** documentation migration implementer.

**Files:**
- Modify: exact tracked Markdown paths enumerated in `docs/architecture/plans/governance/evidence/06-plan-grouping-removal-inventory.md`.
- Modify: `docs/roadmap/01-roadmap.md` only for manual sections; generated sections remain generator-owned.
- Regenerate: `docs/roadmap/generated.md` through `pnpm docs:roadmap`.
- Modify: `README.md`, only the `Hermes development skills` inventory section, replacing the stale 8-skill list with the embedded 11-skill catalog and removing README YAML frontmatter.
- Modify: `docs/README.md`, remove README YAML frontmatter and update only obsolete planning-grouping references.
- Remove/move: `docs/architecture/plans/governance/00-03-plan-naming-policy.md` only after canonical policy integration and inbound-link audit.
- Rename: the unique superseded governance-evidence file identified by Task 1 whose current path starts with `docs/architecture/plans/governance/08-` and ends with `-01-merge-decisions.md` to `docs/architecture/plans/governance/merge-decisions.md`; update inbound source links and preserve its ID, kind, status, dates, and factual evidence.
- Rename: only document filenames whose Task 1 classification confirms they encode the obsolete Plan grouping; use the naming policy and update inbound links. Preserve runtime/unrelated filenames even when the broad search matches them.
- Do not modify: any skill source file or skill-related path other than the named section in root `README.md`.

**Dependencies:** Tasks 1–3.

**Interfaces:**
- Consumes: canonical policy, parser/generator contract, and exact paths from Task 1 inventory.
- Produces: coherent Plan-only documentation and generated roadmaps with historical facts retained in unambiguous Plan terms.

**Acceptance for this task:**
- Every tracked documentation occurrence classified as the obsolete planning grouping is removed or rewritten; historical evidence retains dates, statuses and outcomes without preserving the confusing label.
- Runtime workflow documentation uses clear terminology for its distinct domain meaning and is never presented as Plan grouping.
- All plan metadata removes the legacy grouping field; all filenames/links conform to the rule that only repeated document types receive numeric prefixes and unique files remain unprefixed.
- README remains unprefixed and without plan frontmatter.
- `README.md` lists the 11 skills and responsibilities from `Embedded Source Requirements`; no other skill-related file changes.
- Naming validator tests demonstrate: repeated document type with numeric prefixes passes; unique `roadmap/generated.md` without a prefix passes; `README.md` without prefix/frontmatter passes; arbitrary invalid unprefixed document fails.
- All `README.md` index files remain unprefixed and have no YAML frontmatter.
- Generated output is changed only by its canonical generator.

- [ ] **Step 1:** Update canonical naming/lifecycle policy and governance guide; remove obsolete metadata and duplicate lifecycle/grouping rules.
- [ ] **Step 2:** Apply the inventory to all listed documentation paths; preserve facts while replacing only obsolete planning-grouping language with Plan IDs/dependencies or removing redundant prose.
- [ ] **Step 3:** Rename only affected document filenames classified as obsolete Plan grouping; update inbound links and verify the unique-vs-repeated type rule. Leave runtime/unrelated names untouched.
- [ ] **Step 4:** Regenerate `docs/roadmap/generated.md`; inspect `docs/roadmap/01-roadmap.md` and generated output for duplicate grouping and stale metadata.
- [ ] **Step 5:** Update only `README.md`'s skill inventory from `Embedded Source Requirements`; make no changes to skill source files or unrelated skill references. Remove frontmatter from `README.md` and `docs/README.md`.
- [ ] **Step 6:** Re-run the Task 1 content and filename searches, then run the content search against this plan separately; Expected: no hits in this plan, no obsolete planning model remains in docs/tool behavior, and all remaining runtime hits match the Task 1 classification.

### Task 5: Полная verification и independent review

**Purpose:** подтвердить целостность Plan metadata, documentation links, generated outputs and repository gates.

**Owner:** verification controller; final review is a fresh read-only reviewer.

**Files:**
- Read: complete Task 1 inventory and all changed documentation/tooling.
- Inspect: full scoped diff for this migration; preserve unrelated worktree changes.

**Dependencies:** Tasks 2–4.

**Acceptance for this task:**
- `pnpm docs:test`, `pnpm docs:check`, `pnpm docs:roadmap`, then a second `pnpm docs:check` pass.
- `pnpm exec vitest run scripts/plan-parser.test.ts scripts/plan-parser.integration.test.ts scripts/roadmap-generator.test.ts scripts/roadmap-generator.integration.test.ts`, `pnpm exec tsx --test scripts/plan-collector.test.ts`, and `pnpm docs:test` pass.
- Repository gates `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm hermes:check` pass where applicable; any unavailable/irrelevant gate is documented with evidence.
- `git diff --check` passes and no generated output remains stale.
- `git diff --name-only -- apps packages` is empty; runtime contracts and unrelated app work are untouched.
- Independent `ebb-review-plan`/change review returns `APPROVED`; findings are fixed and re-reviewed.

- [ ] **Step 1:** Run `pnpm exec vitest run scripts/plan-parser.test.ts scripts/plan-parser.integration.test.ts scripts/roadmap-generator.test.ts scripts/roadmap-generator.integration.test.ts`, `pnpm exec tsx --test scripts/plan-collector.test.ts`, and `pnpm docs:test`; Expected: all suites pass and assert Plan IDs/dependencies, absence of the extra grouping, and all four filename cases.
- [ ] **Step 2:** Run repository gates from `package.json`; record commands and results.
- [ ] **Step 3:** Perform a final scoped search and inspect the complete diff for unintended edits, missing links or unrelated changes.
- [ ] **Step 4:** Obtain fresh independent review; resolve findings and request targeted re-review.
- [ ] **Step 5:** Commit only approved migration files when they can be isolated safely; never push or merge.
