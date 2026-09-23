---
id: plan-11
kind: plan
roadmap: 01
stage: 11
status: in_progress
title: Plan Document
created: 2026-09-23
updated: 2026-09-23
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence: []
---
# Hermes Development Capabilities Implementation Plan

> **Для агентов:** Используйте суперсилы superpowers:subagent-driven-development или superpowers:executing-plans для пошагового выполнения. Шаги используют чекбоксы (`- [ ]`).

**Goal:** Добавить в репозиторий регистр канонических skills и capabilities, скрипты setup/check, и документацию.

**Архитектура:** `tools/hermes` остаётся source of truth. Script синхронизирует skills в `HERMES_HOME`. Production runtime не меняется.

**Spec:** `docs/architecture/specs/04-hermes-development-capabilities.md`

## Глобальные ограничения

- Не коммитить и не печатать API keys, tokens или secret значения.
- Делегирование Hermes: максимум 2 параллельных ребёнка, глубина 1.
- Все новые документ и комментарии на русском.
- Сохранять несвязанные изменения в рабочем дереве.

## Фокус ревизии

- Изменённый установленный skill должен падать на hash verification; покрыть в тестах setup/check.
- Путь вне worktree должен fail closed; покрыть в setup/execute path handling.
- Документация должна перечислять все канонические skills и capabilities.

---

### Task 1: Добавить регистры capabilities и skills

**Файлы:**
- Создать: `tools/hermes/capabilities.yaml`
- Создать: `tools/hermes/skills/ebb-security-review/SKILL.md`
- Создать: `tools/hermes/skills/ebb-web-e2e/SKILL.md`
- Создать: `tools/hermes/skills/ebb-repository-context/SKILL.md`
- Создать: `tools/hermes/skills/ebb-quality-gates/SKILL.md`
- Тесты: `scripts/hermes-dev.test.mjs`

**Интерфейсы:**
- `capabilities.yaml` объявляет именованные project capabilities и их scope.
- Каждый новый `SKILL.md` использует валидный frontmatter.

- [ ] **Step 1:** Написать тесты валидации для registry names, skill frontmatter, secret absence.
- [ ] **Step 2:** Запустить `node --test scripts/hermes-dev.test.mjs` и подтвердить провал.
- [ ] **Step 3:** Добавить registries и skills.
- [ ] **Step 4:** Запустить тесты и убедиться в успехе.
- [ ] **Step 5:** Запустить `git diff --check` и проверить файлы Task 1.

### Task 2: Расширить скрипты setup/check

**Файлы:**
- Изменить: `scripts/hermes-dev.mjs`
- Изменить: `package.json`
- Изменить: `tools/hermes/README.md`
- Изменить: `docs/development/hermes.md`
- Тесты: `scripts/hermes-dev.test.mjs`

**Интерфейсы:**
- `pnpm hermes:setup` синхронизирует все каталоги skills.
- `pnpm hermes:check` валидирует source/target hashes и registries.

- [ ] **Step 1:** Добавить тесты для provider command parsing (реjection) и redacted output.
- [ ] **Step 2:** Запустить фокусные тесты и подтвердить провал.
- [ ] **Step 3:** Реализовать детерминированные setup/check helpers.
- [ ] **Step 4:** Запустить `pnpm hermes:setup` и `pnpm hermes:check` в temp HERMES_HOME.
- [ ] **Step 5:** Проверить legacy `pnpm hermes:execute -- <plan>` validation.

### Task 3: Документировать skills и capabilities

**Файлы:**
- Изменить: `README.md`
- Изменить: `tools/hermes/README.md`
- Изменить: `docs/development/hermes.md`

- [ ] **Step 1:** Добавить проверку coverage документации.
- [ ] **Step 2:** Запустить против текущего README и подтвердить отсутствие записей.
- [ ] **Step 3:** Добавить документацию с путями и командами.
- [ ] **Step 4:** Запустить coverage check и проверить структуру Markdown.

### Task 4: Валидировать все изменения

**Файлы:**
- Изменить: `docs/audit/PROJECT_STATE.md`

- [ ] **Step 1:** Запустить `pnpm lint`.
- [ ] **Step 2:** Запустить `pnpm typecheck`.
- [ ] **Step 3:** Запустить `pnpm test`.
- [ ] **Step 4:** Запустить `pnpm server:build` и `pnpm web:build`.
- [ ] **Step 5:** Запустить `git diff --check` и `git status --short`; подтвердить отсутствие артефактов и секретов.
