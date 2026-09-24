---
id: plan-00-05
kind: plan
roadmap: 01
stage: 00
status: planned
title: Интеграция политик управления навыками и планированием
summary: Синхронизация governance policy, naming/lifecycle rules и skill suite по приложенным файлам
created: 2026-09-24
updated: 2026-09-24
depends_on:
  - plan-00-01
  - plan-00-04
specs:
  - ../specs/01-system-design.md
evidence: []
---

# Интеграция политик управления навыками и планированием — план реализации

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`.

**Goal:** интегрировать обновлённые политики именования, lifecycle и governance из приложенных файлов в каноническую документацию Ebb Orchestrator, обеспечить machine-checkable валидацию и согласовать skill suite.

**Architecture:** 
- `docs/development/02-documentation-governance.md` — канонический guide по naming/lifecycle/README
- `docs/architecture/plans/governance/00-04-skills-and-plan-governance-migration.md` — существующий миграционный план
- Приложенные файлы из `hermes/attachments/` служат источником истины для политик

**Tech Stack:** Markdown/YAML frontmatter, Hermes skills, Node.js governance tooling, pnpm, Git.

**Source of Truth:** `.hermes.md`, `AGENTS.md`, приложенные policy-файлы, current governance rules.

## Acceptance Criteria

- Приложенные политики `plan-naming-and-lifecycle-policy.md` и `00-04-skills-and-plan-governance-migration.md` интегрированы в canonical docs
- `README.md` явно исключён из numeric-prefix/frontmatter requirements
- Валидатор `pnpm docs:check` проверяет lifecycle enum и naming rules
- Skill suite согласована с delegation invariant (max 2 subagents, plan-controller → task-controller → leaf)
- Generated roadmap регенерируется через `pnpm docs:roadmap`
- Все repository gates проходят

## Global Constraints

- Основная ветка — `master`; не merge/push/rebase/reset/clean/tag/release
- Работать в текущем worktree
- Максимум два одновременно работающих субагента
- Production comments — русский; technical identifiers не переводить
- Preserve unrelated changes

## Review Focus

1. README exception не должен отключить validation для других unnumbered docs
2. Child-plan `id/filename/stage` должны оставаться согласованными
3. `completed` нельзя выставить только из-за успешного Hermes exit code
4. Generated roadmap не должен становиться вторым writable source of truth
5. Existing superseded/evidence docs не должны ошибочно превратиться в active implementation plans

## Task Dependency Map

| Task | Depends on | Produces | Consumed by |
|---|---|---|---|
| 1 | — | updated canonical governance guide | 2, 3 |
| 2 | 1 | validator/roadmap support | 3, 4 |
| 3 | 1, 2 | normalized existing governance docs | 4 |
| 4 | 1, 2 | synchronized Ebb skill suite | 5 |
| 5 | 3, 4 | full verification + final review | — |

### Task 1: Интегрировать политики в canonical governance guide

**Purpose:** перенести правила из приложенных файлов в `docs/development/02-documentation-governance.md`

**Files:**
- Modify: `docs/development/02-documentation-governance.md`
- Read: `plan-naming-and-lifecycle-policy.md` (из attachments)
- Read: `00-04-skills-and-plan-governance-migration.md` (из attachments)

**Interfaces:**
- Produces: единый policy для filename/id/status/README/roadmap registration
- Consumes: current documentation-governance schema

**Acceptance for this task:**
- Naming pattern `XX-name.md` и `XX-YY-name.md` зафиксированы
- Lifecycle enum: `proposed|planned|in_progress|blocked|completed|superseded|cancelled`
- `00` зарезервирован для governance/meta
- README.md исключён из правил frontmatter/prefix
- 00-03-plan-naming-policy.md переименован/объединён как dup

- [ ] **Step 1:** Добавить section по README exception в governance guide
- [ ] **Step 2:** Обновить lifecycle enum в документации
- [ ] **Step 3:** Зафиксировать правила naming в YAML frontmatter schema
- [ ] **Step 4:** Удалить дубликаты policy из `docs/architecture/plans/governance/00-03-plan-naming-policy.md`

### Task 2: Обновить валидатор и генератор roadmap

**Purpose:** сделать policy machine-checkable

**Files:**
- Modify: `scripts/docs-governance-lib.mjs`
- Modify: `scripts/docs-governance.mjs`
- Modify: `scripts/docs-governance.test.mjs`

**Interfaces:**
- Consumes: canonical policy из Task 1
- Produces: README exception, full lifecycle enum, generated registration

**Acceptance for this task:**
- Validator исключает только designated `README.md`
- Plan filename/id/stage согласованы
- Full lifecycle enum accepted
- Unknown kinds rejected

- [ ] **Step 1:** Обновить regex для filename validation
- [ ] **Step 2:** Добавить проверки status enum
- [ ] **Step 3:** Обновить тесты
- [ ] **Step 4:** Проверить `pnpm docs:test`

### Task 3: Нормализовать существующие governance docs

**Purpose:** применить policy к реальным документам

**Files:**
- Modify: `docs/architecture/plans/governance/00-01-documentation-governance.md`
- Modify: `docs/architecture/plans/governance/00-02-agents-policy-review.md`
- Remove/move: `docs/architecture/plans/governance/00-03-plan-naming-policy.md`

**Interfaces:**
- Produces: canonical IDs/kinds/metadata
- Consumes: validator из Task 2

**Acceptance for this task:**
- completed/superseded statuses подтверждены evidence
- historical claims не переписываются
- no duplicate active plan IDs

- [ ] **Step 1:** Пересмотреть 00-01 и подтвердить id
- [ ] **Step 2:** Пересмотреть 00-02 и подтвердить status
- [ ] **Step 3:** Переместить 00-03 в evidence или удалить
- [ ] **Step 4:** Regenerate roadmap

### Task 4: Синхронизировать skill suite

**Purpose:** согласовать skills с delegation invariant

**Files:**
- Modify: `tools/hermes/skills/*/SKILL.md` при необходимости
- Modify: `.hermes.md`, `AGENTS.md`

**Interfaces:**
- Produces: consistent delegation rules
- Consumes: canonical plan governance

**Acceptance for this task:**
- No skill tells plan/task controller to edit implementation directly
- Max 2 concurrently running subagents enforced
- Specialist skills are reusable and read-only where appropriate

- [ ] **Step 1:** Проверить `ebb-write-plan` и `ebb-execute-plan`
- [ ] **Step 2:** Проверить `ebb-review-plan` и `ebb-final-review`
- [ ] **Step 3:** Запустить `pnpm hermes:setup`

### Task 5: Полная верификация и review

**Purpose:** доказать отсутствие конфликтов

**Files:**
- Read: complete changed governance docs
- Inspect: full BASE..HEAD diff

**Acceptance for this task:**
- `pnpm docs:test && pnpm docs:check && pnpm docs:roadmap` pass
- `pnpm hermes:check` pass
- `git diff --check` passes
- Independent review via `ebb-review-plan` shows no unresolved findings

- [ ] **Step 1:** Run focused governance checks
- [ ] **Step 2:** Run repository gates
- [ ] **Step 3:** Independent final review
- [ ] **Step 4:** Local commit (without push)
