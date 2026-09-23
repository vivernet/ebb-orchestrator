---
id: plan-00
kind: plan
roadmap: 01
stage: 00
status: completed
title: Documentation Governance Refactoring
summary: Рефакторинг документации и единого roadmap
created: 2026-09-16
updated: 2026-09-23
---
# Рефакторинг документации и единого roadmap — план реализации

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: используйте `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans` для реализации этого плана по задачам. Шаги используют синтаксис флажков (`- [ ]`) для отслеживания.

**Цель:** полностью привести `docs/` к единой модели нумерации, именования, типов документов, ссылок и статусов, объединить конкурирующие roadmap/plan-документы и сделать единый автоматически проверяемый roadmap проекта.

**Архитектура:** документация остаётся Git-tracked source of truth. Каждый управляемый документ получает строгий metadata-блок с глобальным `id`, типом, принадлежностью к roadmap/stage, статусом и зависимостями. `docs/roadmap/01-roadmap.md` становится единственным каноническим roadmap; его сводные таблицы и графы генерируются из metadata планов/specs/proposals, а ручной текст ограничивается целями, решениями и правилами. Скрипт документационного каталога работает детерминированно, не читает Git history для определения статуса и не угадывает состояние по датам или checkbox.

**Технологический стек:** Markdown, YAML front matter, Node.js ESM, `node:fs`, `node:path`, `node:url`, `node:test`, существующие команды pnpm/Hermes development workflow.

**Spec:** `docs/architecture/specs/01-system-design.md` после миграции; исходный архитектурный документ до миграции — `docs/architecture/specs/01-system-design.md`.

## Глобальные ограничения

- Нумерация filename всегда находится в начале и использует фиксированную ширину (`00`, `01`, `02`, ...).
- Даты не используются в filename; исходные даты сохраняются в metadata и историческом тексте документов.
- `docs/roadmap/01-roadmap.md` — единственный канонический roadmap; конкурирующие roadmap не сохраняются как параллельные источники истины.
- Номер `roadmap` и номер `stage` не сбрасываются при переходе к следующему циклу планирования.
- В актуальной документации используется единый термин `Stage`; `Phase` заменяется на `Stage`, если это описание исполняемой последовательности.
- `Plan` означает исполняемый документ, `Spec` — утверждённый design/contract, `Audit` — evidence snapshot, `Proposal` — неутверждённое направление, `Reference` — справочный или визуальный материал, `Guideline` — правило процесса.
- `00` зарезервирован для governance/служебных планов и не является продуктовым Stage.
- Новые и изменяемые комментарии production-кода должны быть на русском языке; документация также ведётся на русском, кроме технических identifiers и названий внешних протоколов.
- Не изменять product runtime scope, domain semantics, approval policy или security model.
- Не удалять исторические audit evidence; при объединении сохранять provenance, дату и исходный источник.
- Не выполнять `git push`, merge в `master`, rebase, reset, clean, tag или release.
- Сохранять unrelated changes в рабочем дереве без редактирования и не включать их в этот рефакторинг.
- После каждого миграционного блока проверять ссылки, уникальность ID и отсутствие старых filenames.
- План исполняется в текущем worktree/branch с ограничением не более двух параллельных субагентов и без nested delegation.

---

## 0. Правила исполнения и начальная фиксация контекста

### Task 0: Зафиксировать baseline документации

**Files:**
- Modify: `docs/architecture/plans/governance/00-01-documentation-governance.md` — только checkbox-статус выполнения.
- Read: `.hermes.md`, `AGENTS.md`, `README.md`, `docs/README.md`.
- Read: `docs/architecture/specs/01-system-design.md`, `docs/architecture/plans/2026-09-16-v1-roadmap.md`, `docs/roadmap/post-v1.md`.

**Interfaces:**
- Produces: зафиксированные branch, HEAD, status, полный список файлов `docs/`, список ссылок и список исходных имён для миграционной карты.

- [ ] **Step 1: Проверить ветку, HEAD и рабочее дерево**

Run:

```bash
git branch --show-current
git status --short
git log -1 --oneline
```

Expected: команда завершается успешно; unrelated changes перечислены отдельно и не изменяются.

- [ ] **Step 2: Построить полный список файлов `docs/`**

До появления собственного генератора использовать read-only inventory средствами окружения или редактора, не записывающий файлы. После Task 1 повторить inventory командой:

```bash
node scripts/docs-governance.mjs inventory --root docs
```

Результат должен включать Markdown, HTML и любые другие файлы, а не только `*.md`; расхождения между baseline и повторным inventory зафиксировать.

- [ ] **Step 3: Зафиксировать явные конфликты и отсутствующие ссылки**

В baseline внести список минимум следующих проблем:

- два v1 roadmap в `architecture/specs/` и `architecture/plans/`;
- `next-stages-roadmap`, `post-v1` и ecosystem roadmap как конкурирующие представления будущих работ;
- Web UI design, task ledger и несколько Stage plans с пересекающимися статусами;
- ручной и неполный список в `docs/README.md`;
- ссылки на отсутствующие `2026-09-16-ebb-orchestrator-*` filenames;
- смешение `Phase`, `Plan`, буквенных `Stage A–F` и числовых Stage.

- [ ] **Step 4: Провести независимую проверку baseline**

Проверить, что baseline не содержит секретов, не утверждает статус по одному filename и не включает unrelated `apps/web/test/features/RunPage.test.tsx`.

---

## 1. Каноническая модель идентификаторов и metadata

### Task 1: Создать schema и parser документационного metadata

**Files:**
- Create: `scripts/docs-governance.mjs` — CLI для inventory, metadata validation, link validation, roadmap generation и rename preview.
- Create: `scripts/docs-governance-lib.mjs` — чистые функции parsing/normalization/validation, экспортируемые для тестов.
- Create: `scripts/docs-governance.test.mjs` — unit tests для parser и validator.
- Create: `docs/development/02-documentation-governance.md` — правила metadata и lifecycle после миграции.
- Modify: `package.json` — добавить `docs:inventory`, `docs:check`, `docs:roadmap`, `docs:rename:check` и `docs:test`.

**Interfaces:**
- `parseFrontMatter(text: string): { data: Record<string, unknown>, body: string }`.
- `parseDocument(filePath: string, text: string): DocumentRecord`.
- `validateDocument(record: DocumentRecord, catalog: Catalog): ValidationIssue[]`.
- `scanDocs(rootDir: string): Catalog`.
- `renderRoadmap(catalog: Catalog): string`.
- `validateLinks(catalog: Catalog): ValidationIssue[]`.
- CLI commands: `inventory`, `check`, `roadmap`, `rename:check`.

Metadata schema:

```yaml
---
id: plan-01
kind: plan
roadmap: 01
stage: 01
status: completed
title: Foundation и Persistence
summary: Краткое описание результата документа
created: 2026-09-16
updated: 2026-09-23
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - docs/audit/01-full-audit.md
---
```

Допустимые `kind`:

```text
roadmap
spec
plan
audit
proposal
guideline
ledger
reference
index
```

Допустимые `status` для lifecycle-документов:

```text
proposed
planned
in_progress
blocked
completed
superseded
cancelled
```

- [ ] **Step 1: Написать failing tests для front matter**

Проверить:

- обязательные поля `id`, `kind`, `title`, `status`, `created`, `updated`;
- `id` соответствует `^(roadmap|spec|plan|audit|proposal|guideline|ledger|reference|index)-[0-9]{2}(-[0-9]{2})?$` там, где тип использует числовую идентификацию;
- `roadmap` и `stage` имеют две цифры;
- `status` принадлежит enum;
- `depends_on`, `specs`, `evidence` являются массивами строк;
- даты имеют ISO-формат `YYYY-MM-DD`;
- неизвестные поля не игнорируются молча, а выдаются как validation issue.

- [ ] **Step 2: Запустить тесты и подтвердить RED**

Run:

```bash
pnpm docs:test
```

Expected: новые тесты FAIL до реализации parser.

- [ ] **Step 3: Реализовать parser и validator**

Использовать только стандартные Node.js API и существующий ESM style проекта. Parser не должен исполнять YAML, читать `.env`, обращаться к сети или интерпретировать произвольный front matter как код.

- [ ] **Step 4: Реализовать детерминированное сканирование**

`scanDocs` должен:

- обходить только разрешённый `docs/` root;
- исключать временные/служебные директории по явному allowlist;
- учитывать `.md` и `.html`;
- сортировать пути лексикографически;
- возвращать относительные POSIX paths;
- не менять файлы.

- [ ] **Step 5: Запустить тесты и подтвердить GREEN**

Run:

```bash
pnpm docs:test
```

Expected: PASS.

- [ ] **Step 6: Добавить package scripts**

Добавить команды без удаления существующих:

```json
"docs:inventory": "node scripts/docs-governance.mjs inventory",
"docs:check": "node scripts/docs-governance.mjs check",
"docs:roadmap": "node scripts/docs-governance.mjs roadmap",
"docs:rename:check": "node scripts/docs-governance.mjs rename:check",
"docs:test": "node --test scripts/docs-governance.test.mjs"
```

- [ ] **Step 7: Зафиксировать первый логический commit**

Commit message:

```text
chore: добавить валидатор документационной metadata
```

Коммит выполняется только после focused tests и `git diff --check`.

---

## 2. Единый словарь и numbering policy

### Task 2: Утвердить и описать правила нумерации

**Files:**
- Create: `docs/development/02-documentation-governance.md`.
- Modify: `docs/README.md` после миграции.
- Modify: `docs/architecture/specs/01-system-design.md` после rename.
- Modify: `AGENTS.md`.
- Modify: `.hermes.md`.
- Modify: `tools/hermes/skills/ebb-repository-context/SKILL.md`.
- Modify: `tools/hermes/skills/ebb-execute-plan/SKILL.md`.
- Modify: `docs/development/hermes.md`.

**Interfaces:**
- Produces: единый glossary и machine-checkable naming policy.
- Consumes: metadata validator из Task 1.

Правила, которые должны быть буквально зафиксированы:

1. `Stage` — глобальный исполняемый этап; номер не сбрасывается.
2. `Plan` — конкретный исполняемый документ; план может быть основным или дочерним (`06-01`, `06-02`).
3. `Roadmap` — единый агрегатор циклов; filename остаётся `01-roadmap.md`, а поколения (`Roadmap 01`, `Roadmap 02`) являются секциями документа.
4. `Phase` не используется как альтернативная рабочая шкала. В architecture/design prose его заменить на `Stage`, если речь идёт о delivery sequence.
5. `v1`, `post-v1`, `next`, `current` не используются в filenames как номер или замена номера.
6. Дата хранится в metadata и историческом тексте.
7. Historical audit identity сохраняет дату в metadata, но filename получает номер каталога.
8. `00` используется только для governance/meta plans.
9. Все ссылки используют repository-relative POSIX paths.
10. Один тип документа — один canonical source; derived index не является вторым source of truth.

- [ ] **Step 1: Зафиксировать терминологию в governance guide**

Добавить таблицу `Term / Meaning / Allowed location / Forbidden usage` и примеры правильных/неправильных filenames.

- [ ] **Step 2: Добавить validator rules**

`docs:check` должен находить:

- filename без числового prefix;
- prefix не фиксированной ширины;
- date prefix в управляемом документе;
- `v1`, `post-v1`, `next-stages` в filename;
- актуальные `Phase` и буквенные `Stage A–F` в delivery headings;
- дублирующие `roadmap` документы.

- [ ] **Step 3: Проверить policy на текущем inventory**

Run:

```bash
pnpm docs:check
```

Expected: FAIL с полным перечнем legacy violations; ошибки не скрывать до миграции.

- [ ] **Step 4: Запустить `git diff --check` и сохранить policy review**

---

## 3. Миграционная карта и канонизация документов

### Task 3: Создать явную карту old path → new path

**Files:**
- Create: `docs/architecture/plans/governance/evidence/document-migration-map.md`.
- Modify: `scripts/docs-governance-lib.mjs` — проверка, что карта полна и не содержит two-to-one конфликтов без merge decision.
- Test: `scripts/docs-governance.test.mjs`.

**Interfaces:**
- `loadMigrationMap(path: string): MigrationMap`.
- `validateMigrationMap(map: MigrationMap, inventory: Catalog): ValidationIssue[]`.
- `resolveCanonicalDocument(oldPath: string): { action: 'rename' | 'merge' | 'archive', target: string }`.

Карта должна содержать для каждого текущего документа:

- old path;
- new path;
- action: `rename`, `merge`, `archive`, `keep`;
- document kind;
- roadmap/stage;
- source date;
- canonical target;
- conflict decision;
- dependent links to update;
- evidence preservation rule.

Карта должна явно закрыть текущие конфликты:

- specs/plans v1 roadmap merge into `docs/roadmap/01-roadmap.md`;
- `next-stages-roadmap` and `post-v1` merge into roadmap sections/proposals;
- ecosystem document become either a roadmap proposal source or a standalone spec with one canonical path;
- Web UI task ledger/status duplication resolve into one plan plus generated status;
- old missing `ebb-orchestrator` paths update to actual canonical paths.

- [ ] **Step 1: Выписать полный mapping для всех 49 files under docs**

Не ограничиваться Markdown; reference HTML должны получить category mapping, даже если их content не объединяется.

- [ ] **Step 2: Определить canonical content для каждой merge-группы**

Для merge-группы перечислить, какие разделы переносятся, какие удаляются как дубликаты и какие противоречия разрешены решением roadmap governance.

- [ ] **Step 3: Добавить тесты полноты карты**

Тесты должны падать, если:

- новый inventory file отсутствует в карте;
- target path повторяется в разных merge groups без explicit merge;
- source path не существует;
- target extension не соответствует исходному типу;
- mapping оставляет старое имя как active source.

- [ ] **Step 4: Проверить migration map до переименований**

Run:

```bash
pnpm docs:rename:check
```

Expected: PASS только после того, как все текущие файлы имеют однозначное решение.

---

## 4. Единый roadmap и lifecycle

### Task 4: Спроектировать и реализовать генерацию единого roadmap

**Files:**
- Create: `docs/roadmap/01-roadmap.md`.
- Modify: `scripts/docs-governance.mjs`.
- Modify: `scripts/docs-governance-lib.mjs`.
- Modify: `scripts/docs-governance.test.mjs`.
- Modify: `docs/architecture/plans/governance/evidence/document-migration-map.md`.

**Interfaces:**
- `buildRoadmapModel(catalog: Catalog): RoadmapModel`.
- `renderRoadmap(model: RoadmapModel): string`.
- `writeGeneratedRoadmap(path: string, content: string): void`.
- `isGeneratedRoadmapUpToDate(path: string, expected: string): boolean`.

`01-roadmap.md` должен содержать:

1. назначение и правила документа;
2. текущий generated timestamp/commit-independent update date из metadata, но не runtime guess;
3. `Roadmap 01` и следующие roadmap generations как секции;
4. глобальный Stage register;
5. Plan register;
6. dependency graph;
7. status summary;
8. blockers and evidence;
9. proposals;
10. completed work summary;
11. rules for adding a new Stage/Plan;
12. link to `docs/README.md` and governance guide.

Roadmap generator должен:

- сортировать roadmap/stage/plan numerically;
- не считать `superseded` активным;
- не считать наличие file или checkbox доказательством completion;
- показывать `blocked` с причиной из metadata/evidence;
- падать на duplicate IDs;
- падать на stage без roadmap;
- падать на dependency cycle;
- сохранять ручные policy sections по explicit markers;
- обновлять только generated sections;
- быть идемпотентным.

- [ ] **Step 1: Написать failing tests модели roadmap**

Проверить generated output для:

- двух roadmap generations;
- Stage с несколькими plans;
- completed/in_progress/blocked/superseded;
- proposal без stage;
- dependency cycle;
- missing evidence для completed plan;
- stable output при повторном запуске.

- [ ] **Step 2: Запустить тесты и подтвердить RED**

```bash
pnpm docs:test
```

- [ ] **Step 3: Реализовать model builder и renderer**

Generated regions пометить явно:

```markdown
<!-- BEGIN GENERATED: roadmap-summary -->
...
<!-- END GENERATED: roadmap-summary -->
```

Ручные explanatory sections нельзя удалять при генерации.

- [ ] **Step 4: Создать initial unified roadmap**

Временно использовать миграционные metadata records из Task 3; после rename их paths должны быть автоматически разрешены на canonical paths.

- [ ] **Step 5: Проверить idempotency**

Run:

```bash
pnpm docs:roadmap
pnpm docs:roadmap
git diff --exit-code -- docs/roadmap/01-roadmap.md
```

Expected: второй запуск не создаёт diff.

---

## 5. Переименование и merge архитектурных документов

### Task 5: Мигрировать `architecture/specs/`

**Files:**
- Rename: `docs/architecture/specs/01-system-design.md` → `docs/architecture/specs/01-system-design.md`.
- Rename: `docs/architecture/specs/02-web-ui-recovery-design.md` → `docs/architecture/specs/02-web-ui-recovery-design.md`.
- Rename: `docs/architecture/specs/03-production-readiness-design.md` → `docs/architecture/specs/03-production-readiness-design.md`.
- Rename: `docs/architecture/specs/04-hermes-development-capabilities.md` → `docs/architecture/specs/04-hermes-development-capabilities.md`.
- Modify: all renamed specs — add metadata and replace `Phase` delivery headings with `Stage` where applicable.
- Modify: `docs/architecture/plans/governance/evidence/document-migration-map.md`.

**Interfaces:**
- Produces: canonical specs with stable `spec-01`... IDs and no date-prefixed paths.
- Consumes: migration map and metadata validator.

- [ ] **Step 1: Add metadata before rename or use atomic rename+edit**

Metadata must preserve original `created` date and set `updated` to migration date.

- [ ] **Step 2: Replace internal links and terminology**

Update links to actual current canonical paths. Do not create compatibility duplicate files.

- [ ] **Step 3: Reconcile architecture Phase sections**

Use `Stage 01`... numbering for implementation sequence. Preserve the design’s architectural intent but remove the competing `Phase` vocabulary.

- [ ] **Step 4: Verify no old spec paths remain**

```bash
pnpm docs:check
pnpm docs:rename:check
```

- [ ] **Step 5: Review architectural scope**

Confirm that this task changes only documentation terminology/paths and does not alter runtime architecture, v1 boundaries or post-v1 extension points.

### Task 6: Переименовать и объединить `architecture/plans/`

**Files:**
- Rename/merge all 20 current plan documents according to `document-migration-map.md`.
- Create: `docs/architecture/plans/governance/00-01-documentation-governance.md` — this plan.
- Modify: all canonical plans — metadata, links, headings, Stage/Plan references.
- Modify: `docs/roadmap/01-roadmap.md`.

Canonical initial plan numbering must cover current v1 implementation and later approved work without using dates. The exact final mapping is the mapping in the migration map; examples are:

```text
01-foundation-persistence.md
02-domain-workflow-scheduler.md
03-git-execution-security.md
04-hermes-autonomous-task.md
05-planning-epics-context-knowledge.md
06-web-github-release.md
07-hermes-development-workflow.md
08-web-ui-recovery.md
09-production-readiness.md
```

Web UI child plans use composed IDs where needed:

```text
08-01-web-ui-foundation.md
08-02-web-ui-core-functional.md
08-03-web-ui-operational-and-e2e.md
```

The old v1 roadmap plan is not copied as another file; its unique content is merged into `docs/roadmap/01-roadmap.md` and/or `01-system-design.md` according to the migration map.

- [ ] **Step 1: Apply only the approved mapping**

Do not invent new Stage order during the rename. If a current plan does not map cleanly to a product Stage, classify it as governance, audit support, proposal, or superseded and document the decision.

- [ ] **Step 2: Merge duplicated v1 roadmap content**

Preserve dependencies, acceptance gates, scope constraints and plan results. Remove repeated target structures and contradictory version/tool values by recording one selected current value in the canonical document.

- [ ] **Step 3: Normalize plan headings and references**

Replace `Plan 1`, `Plan 2`, `Stage A`, `Stage B`, etc. with canonical IDs such as `Stage 01`, `Plan 01` or composed child IDs. Keep task checkbox semantics for execution, but status authority comes from metadata.

- [ ] **Step 4: Update Hermes path examples**

All examples must use:

```bash
pnpm hermes:execute -- docs/architecture/plans/01-foundation-persistence.md
```

or the actual canonical path from the mapping. No date-prefixed examples may remain.

- [ ] **Step 5: Verify plan references**

```bash
pnpm docs:check
pnpm docs:rename:check
```

- [ ] **Step 6: Review the full plan catalog**

Confirm there is exactly one active source for each executable plan, no duplicate ledger status, and no plan points to a deleted path.

---

## 6. Merge roadmap and post-v1 content

### Task 7: Consolidate `docs/roadmap/`

**Files:**
- Rename: `docs/roadmap/2026-09-21-ecosystem-skills-and-plugins.md` → temporary migration target only; final content merged into `docs/roadmap/01-roadmap.md` or canonical proposal/spec.
- Rename/archive: `docs/roadmap/post-v1.md` → no parallel final roadmap file; preserve unique content in `docs/roadmap/01-roadmap.md` under proposals/next roadmap sections.
- Modify: `docs/roadmap/01-roadmap.md`.
- Modify: `docs/architecture/plans/2026-09-18-next-stages-roadmap.md` during merge, then remove obsolete duplicate path after evidence is transferred.
- Modify: `docs/architecture/plans/governance/evidence/document-migration-map.md`.

**Interfaces:**
- Produces: one roadmap source and one generated status representation.
- Preserves: every unique post-v1 proposal, its constraints and approval rule.

- [ ] **Step 1: Group content by semantic status**

Classify every section as:

- committed current Stage;
- candidate next Stage;
- unapproved proposal;
- policy/rule;
- duplicate or superseded text.

- [ ] **Step 2: Resolve conflicts explicitly**

Where current v1 roadmap and post-v1 roadmap disagree, current approved design and implemented scope win for current status; post-v1 text cannot expand current v1 scope. Record each resolution in the migration map.

- [ ] **Step 3: Move all unique future directions**

Keep additional runtimes, isolation, distributed execution, team mode, hosting providers, issue systems, OpenSpec, observability, deployment and routing as proposals unless an approved Stage exists.

- [ ] **Step 4: Delete competing active files only after content verification**

Before deleting/archiving old roadmap files:

```bash
pnpm docs:roadmap
pnpm docs:check
```

Then compare the generated roadmap against the source migration map and confirm no unique section disappeared.

- [ ] **Step 5: Validate roadmap generation**

Expected: exactly one canonical roadmap path and no `v1-roadmap`, `post-v1`, `next-stages-roadmap` active source filenames.

---

## 7. Audit, development and reference-ui normalization

### Task 8: Normalize `docs/audit/`

**Files:**
- Rename all audit files according to the migration map, e.g. `01-full-audit.md`, `02-audit-report.md`.
- Modify: each audit document — add `kind: audit`, source date, branch/HEAD evidence and historical snapshot marker where applicable.
- Modify: `docs/README.md`.
- Modify: `scripts/docs-governance-lib.mjs`.

**Rules:**

- audit filenames use numeric prefixes but do not imply current Stage status;
- original audit date remains in metadata/body;
- historical findings are not rewritten as current facts;
- stale `PROJECT_STATE` data is marked snapshot and linked to the current roadmap only as evidence, never as authoritative status.

- [ ] **Step 1: Add metadata preserving provenance**
- [ ] **Step 2: Update links and historical disclaimers**
- [ ] **Step 3: Validate audit references to old plans**
- [ ] **Step 4: Run `pnpm docs:check` and inspect every audit diff**

### Task 9: Normalize `docs/development/`

**Files:**
- Rename: `docs/development/architecture-review-2026-09-18.md` → mapped numeric name.
- Rename: `docs/development/hermes.md` → mapped numeric name or retain only if governance policy explicitly designates it as the category index.
- Rename: `docs/development/jsdoc-execution-ledger.md` → mapped numeric name.
- Rename: `docs/development/jsdoc-style-guide.md` → mapped numeric name.
- Modify: all development documents — metadata and links.
- Modify: `AGENTS.md`, `.hermes.md`, `docs/development/hermes` references and skills.

- [ ] **Step 1: Separate guidelines from historical ledger/review**
- [ ] **Step 2: Preserve dates in metadata, not filenames**
- [ ] **Step 3: Update every command/path example**
- [ ] **Step 4: Validate no old development paths remain**

### Task 10: Normalize `docs/architecture/reference-ui/`

**Files:**
- Rename all ten concept files to numeric names according to a stable catalog order.
- Modify: `docs/README.md` and any architecture references.
- Modify: metadata/comments only where the HTML format supports them without changing visual behavior.

- [ ] **Step 1: Create a stable concept catalog**

Use one numeric sequence for dashboard, project, onboarding, epic, task, approval, execution, run detail, usage and settings.

- [ ] **Step 2: Update all links**
- [ ] **Step 3: Verify HTML files still open as standalone references**

Do not change UI design content as part of filename normalization.

---

## 8. README and repository policy integration

### Task 11: Rewrite `docs/README.md` as the documentation handbook

**Files:**
- Modify: `docs/README.md`.
- Modify: `README.md` only where its docs links or workflow instructions are stale.
- Modify: `AGENTS.md`.
- Modify: `.hermes.md`.
- Modify: `docs/development/<canonical-hermes-guide>.md`.
- Modify: `tools/hermes/skills/ebb-repository-context/SKILL.md`.
- Modify: `tools/hermes/skills/ebb-execute-plan/SKILL.md`.

`docs/README.md` must explain:

1. source-of-truth hierarchy;
2. directory tree;
3. filename grammar;
4. numbering rules;
5. Stage/Roadmap/Plan/Spec/Audit/Proposal terminology;
6. metadata schema;
7. status lifecycle;
8. how to create a new plan;
9. how to create a proposal;
10. how to update a completed plan;
11. how roadmap generation works;
12. required `pnpm docs:check`/`pnpm docs:roadmap` commands;
13. handling historical documents;
14. rules for merging competing documents;
15. examples of valid and invalid filenames;
16. links to the architecture source of truth and current roadmap;
17. explicit statement that roadmap does not authorize post-v1 implementation.

- [ ] **Step 1: Remove manually maintained incomplete file lists**

Replace them with generated catalog markers or a complete generated index.

- [ ] **Step 2: Add contributor workflow**

Document the exact sequence:

```text
inspect → classify → add metadata → update canonical source → generate roadmap → docs:check → review → commit
```

- [ ] **Step 3: Correct stale references in root policies**

Use actual canonical paths, not guessed `ebb-orchestrator` filenames.

- [ ] **Step 4: Check language and identifiers**

Russian prose, unchanged technical identifiers, consistent capitalization of `Stage`, `Plan`, `Spec`, `Audit`, `Roadmap`.

---

## 9. Hermes lifecycle integration

### Task 12: Make Hermes tooling understand canonical plan paths and status transitions

**Files:**
- Modify: `scripts/hermes-dev.mjs`.
- Modify: `scripts/hermes-dev-paths.mjs`.
- Modify: `scripts/hermes-dev.test.mjs`.
- Modify: `tools/hermes/skills/ebb-execute-plan/SKILL.md`.
- Modify: `tools/hermes/skills/ebb-implement-task/SKILL.md`.
- Modify: `tools/hermes/skills/ebb-review-task/SKILL.md`.
- Modify: `tools/hermes/skills/ebb-final-review/SKILL.md`.
- Modify: every other repository-local `tools/hermes/skills/*/SKILL.md` that contains a documentation path, plan-path rule or roadmap/status instruction; skills without such references are still included in the scan report and remain unchanged.
- Modify: `docs/development/<canonical-hermes-guide>.md`.
- Modify: `package.json`.

Установленные копии skills в активном Hermes profile не редактировать напрямую: после изменения `tools/hermes/skills/**` синхронизировать их только через `pnpm hermes:setup`, затем проверить `pnpm hermes:check`.

**Interfaces:**
- `resolvePlanPath(worktreeRoot: string, inputPath: string): string | null` must accept canonical `docs/architecture/plans/**` paths, including `governance/**`.
- `readPlanMetadata(planPath: string): PlanMetadata` validates `kind: plan` and returns lifecycle fields.
- `updatePlanStatus(planPath: string, status: PlanStatus, updated: string): void` performs atomic temp-file + rename and preserves body/content.
- `runRoadmapGeneration(worktreeRoot: string): { ok: boolean, changed: boolean }` invokes the deterministic documentation generator without shell interpolation.

Lifecycle rules:

- `execute` validates plan metadata before spawning Hermes;
- successful validated start changes `planned` to `in_progress`;
- spawn/timeout failure changes status to `blocked` only when a structured failure reason is recorded;
- Hermes process success alone does not set `completed`;
- `completed` requires plan acceptance evidence and passing applicable gates;
- human can set `blocked`, `cancelled` or `superseded` explicitly;
- roadmap generation runs after status changes;
- status writes never touch secrets or unrelated files.

- [ ] **Step 1: Add failing tests for canonical path resolution**

Cover nested governance plans, traversal rejection, old date path rejection, non-plan document rejection and Windows/MSYS path normalization.

- [ ] **Step 2: Add failing tests for metadata-preserving status updates**

Verify body remains byte-equivalent except front matter, unknown metadata is rejected, and interrupted write cannot leave a truncated target.

- [ ] **Step 3: Implement path and metadata integration**

Reuse existing canonical path containment logic; do not replace it with string-prefix checks.

- [ ] **Step 4: Integrate status transitions with `doExecute`**

Do not mark completion based solely on child exit code. Preserve existing redacted markers and cleanup verification.

- [ ] **Step 5: Update skills**

Change all path examples from date-prefixed plans to canonical numeric paths. Require reading metadata and running docs checks.

- [ ] **Step 6: Run focused Hermes tests**

```bash
pnpm hermes:test
pnpm docs:test
```

- [ ] **Step 7: Run `pnpm hermes:check`**

Expected: source and installed skills remain synchronized and all documentation workflow checks pass.

---

## 10. Full link and terminology migration

### Task 13: Replace all old paths, names and competing terminology

**Files:**
- Modify: every file under `docs/` containing old paths/terms.
- Modify: `README.md`, `AGENTS.md`, `.hermes.md`.
- Modify: `tools/hermes/skills/**` where canonical plan paths are mentioned.
- Modify: scripts/tests containing plan paths.

**Interfaces:**
- Produces: zero stale active references to old filenames.
- Consumes: migration map, catalog and canonical paths.

- [ ] **Step 1: Generate a replacement report before editing**

```bash
pnpm docs:rename:check -- --report
```

Report every old path, old heading form and old command example with file and line. Отдельно просканировать все `tools/hermes/skills/**/SKILL.md`, `tools/hermes/providers/`, `scripts/`, root policy files и CI configuration; report должен явно показать, какие файлы проверены и какие ссылки найдены.

- [ ] **Step 2: Apply replacements from the migration map only**

Do not perform broad unreviewed text replacement of words such as `stage` in unrelated prose. Replace exact paths and delivery headings; preserve domain statuses and technical identifiers.

- [ ] **Step 3: Resolve orphan links**

Every relative link must resolve to an existing file or an explicit anchor in an existing canonical document. No link may point to a deleted duplicate.

- [ ] **Step 4: Check forbidden legacy patterns**

`docs:check` must fail on active references to:

```text
2026-09-
2026-09-16-ebb-orchestrator
v1-roadmap
post-v1.md
next-stages-roadmap
Stage A
Stage B
Stage C
Stage D
Stage E
Stage F
Phase 1
Plan 1
```

Exceptions must be explicit historical migration evidence, not active instructions.

- [ ] **Step 5: Review all changed links manually**

Automated link checks cannot prove semantic correctness of merged content; inspect every merge-group diff.

---

## 11. Generation, CI and quality gates

### Task 14: Add documentation checks to the normal workflow

**Files:**
- Modify: `package.json`.
- Modify: CI workflow file if present after discovery; do not invent a workflow path before inspecting repository configuration.
- Modify: `scripts/docs-governance.mjs`.
- Modify: `scripts/docs-governance.test.mjs`.
- Modify: `docs/README.md`.

**Interfaces:**
- `pnpm docs:test` — unit tests for documentation tooling.
- `pnpm docs:check` — metadata, naming, links, IDs, dependencies, stale paths and roadmap uniqueness.
- `pnpm docs:roadmap` — deterministic regeneration.
- `pnpm docs:rename:check` — migration map and old-path audit.

- [ ] **Step 1: Discover existing CI scripts/workflows**

Use repository inspection; preserve existing gates and add documentation validation at the appropriate existing job rather than creating a parallel CI system.

- [ ] **Step 2: Add deterministic check order**

Recommended local sequence:

```bash
pnpm docs:test
pnpm docs:roadmap
pnpm docs:check
pnpm docs:rename:check
pnpm hermes:test
pnpm hermes:check
git diff --check
```

- [ ] **Step 3: Make generated roadmap drift fail**

CI/check must either regenerate in a temporary buffer and compare or regenerate and verify clean diff. It must never silently modify the working tree in CI.

- [ ] **Step 4: Add a fixture catalog**

Test fixtures must cover valid docs, malformed metadata, duplicate IDs, broken links, cycles, duplicate roadmap sources and historical audit exceptions.

- [ ] **Step 5: Run repository gates**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Documentation tooling must not weaken existing lint/typecheck/test/build rules.

---

## 12. Final migration review and acceptance

### Task 15: Perform independent final review

**Files:**
- Read: complete `docs/roadmap/01-roadmap.md`.
- Read: complete `docs/README.md`.
- Read: complete governance guide and migration map.
- Read: all changed specs/plans in full.
- Inspect: full Git diff and status.

- [ ] **Step 1: Verify structural acceptance criteria**

Confirm:

- exactly one canonical roadmap exists;
- every managed filename follows numeric-prefix policy;
- no active managed filename begins with a date;
- no active filename uses `v1`, `post-v1` or `next` as its numbering scheme;
- every managed lifecycle document has valid metadata;
- every plan has one canonical ID;
- Stage numbers are unique and globally ordered;
- roadmap generations are explicit sections, not competing files;
- `00` contains only governance/meta plans;
- all unique content from merged documents is preserved or explicitly classified as superseded.

- [ ] **Step 2: Verify link and semantic acceptance criteria**

Confirm:

- every docs link resolves;
- every plan points to canonical specs;
- every audit preserves date/branch/HEAD provenance;
- current status is not taken from historical audit snapshots;
- post-v1 proposals do not appear as implemented Stage;
- README examples execute against real paths;
- Hermes commands accept canonical plan paths;
- generated roadmap is idempotent.

- [ ] **Step 3: Run all focused checks**

```bash
pnpm docs:test
pnpm docs:roadmap
pnpm docs:check
pnpm docs:rename:check
pnpm hermes:test
pnpm hermes:check
git diff --check
```

- [ ] **Step 4: Run all repository gates**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If a gate fails, record the real failure, fix the documentation/tooling root cause, rerun the affected focused gate, then rerun the full gate.

- [ ] **Step 5: Inspect final diff and working tree**

```bash
git diff --stat
git diff -- docs/README.md docs/roadmap/01-roadmap.md
git status --short
```

Confirm unrelated changes remain untouched and no generated temporary files, secrets or obsolete duplicate documents remain.

- [ ] **Step 6: Invoke independent review**

Use `ebb-review-task` or an equivalent read-only review for:

- completeness of migration map;
- lost-content risk in merges;
- correctness of Stage/Plan numbering;
- status automation safety;
- broken links and stale instructions;
- absence of hidden v1 scope changes.

- [ ] **Step 7: Finalize with local commit only if requested by repository workflow**

No push, merge into `master`, tag or release. Report exact commit/working-tree state and any limitations.

---

## Acceptance checklist

- [ ] `docs/architecture/plans/governance/00-01-documentation-governance.md` is the canonical implementation plan for this refactor.
- [ ] All current docs files are present in the migration map.
- [ ] All competing roadmap sources are merged and no competing active roadmap remains.
- [ ] `docs/roadmap/01-roadmap.md` is the only canonical roadmap.
- [ ] All managed filenames begin with a fixed-width number.
- [ ] Dates moved from filenames to metadata/content.
- [ ] `Stage` is the only active delivery-stage term.
- [ ] Roadmap generations and global Stage numbering are documented.
- [ ] Specs, plans, audits, proposals, guidelines, ledgers and references have distinct semantics.
- [ ] `docs/README.md` fully documents the system and contains no stale manual inventory.
- [ ] Metadata parser, validator, link checker and roadmap generator have tests.
- [ ] Hermes plan execution accepts canonical nested plan paths and validates metadata.
- [ ] Status transitions do not falsely mark a plan completed from process exit alone.
- [ ] Historical audit evidence and dates are preserved.
- [ ] `pnpm docs:test`, `pnpm docs:check`, `pnpm docs:rename:check`, `pnpm hermes:test`, `pnpm hermes:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `git diff --check` pass.
- [ ] Independent review passes with no unresolved load-bearing finding.
