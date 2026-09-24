# Ebb implementation plan format

План должен быть самодостаточен для свежего task-controller.

## Frontmatter

```yaml
---
id: plan-XX
kind: plan
roadmap: 01
stage: XX
status: planned
title: Название
summary: Краткий результат
created: YYYY-MM-DD
updated: YYYY-MM-DD
depends_on: []
specs: []
evidence: []
---
```

Для части: `id: plan-XX-YY`, filename `XX-YY-name.md`.

## Header

```markdown
# <Название> — план реализации

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`.

**Goal:** одно точное предложение.
**Architecture:** 2–4 предложения.
**Tech Stack:** фактические технологии.
**Source of Truth:** exact paths.
**Baseline:** branch + HEAD.

## Acceptance Criteria
- ...

## Global Constraints
- точные project-wide ограничения

## Review Focus
1. конкретный input/failure mode → ожидаемое поведение
...

## Task Dependency Map
| Task | Depends on | Produces | Consumed by |
```

## Каждая task

```markdown
### Task N: <проверяемый deliverable>

**Purpose:** ...
**Depends on:** ...
**Files:**
- Create/Modify/Test: `exact/path` — exact symbol/section

**Interfaces:**
- Consumes: exact signature/value/none
- Produces: exact signature/value/none

**Acceptance for this task:**
- ...

- [ ] Step 1: RED — конкретный regression/behavior test
- [ ] Step 2: Run RED
  Run: `<exact command>`
  Expected: exact exit/status/failure reason
- [ ] Step 3: minimal implementation
  - exact symbols/invariants
  - explicit non-goals
- [ ] Step 4: Run GREEN
  Run: `<exact command>`
  Expected: exit 0 / exact PASS
- [ ] Step 5: neighboring checks
  Run: `<exact command>`
  Expected: exit 0
- [ ] Step 6: `git diff --check`
  Expected: exit 0, empty output
- [ ] Step 7: local commit when required
```

Не использовать `TBD`, `TODO`, «добавить валидацию», «написать тесты», «как Task N», выдуманные paths/symbols или commands без `Expected`.

Если TDD технически неприменим, укажи наблюдаемый RED baseline и конкретный GREEN verification вместо молчаливого удаления RED.
