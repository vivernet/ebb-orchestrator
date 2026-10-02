---
id: plan-13
kind: plan
status: completed
title: Автоматическая генерация роадмапа
created: 2026-09-23
updated: 2026-10-02
depends_on:
  - plan-09
specs:
  - ../specs/01-system-design.md
evidence:
  - scripts/docs-governance.mjs
  - scripts/docs-governance-lib.mjs
  - scripts/docs-governance.test.mjs
  - scripts/roadmap-generator-cli.mjs
  - scripts/roadmap-generator-cli.test.mjs
  - docs/roadmap/generated.md
  - docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md
---

# Автоматическая генерация роадмапа — Implementation Plan

> **Историческая запись (superseded):** этот план сохраняет исходный замысел реализации. Упоминания `stage`, Stage Register и группировки планов не являются действующим metadata contract или нормативными требованиями.

> **Актуальная сверка (2026-10-02):** действующая команда `pnpm docs:roadmap` проверяет дубли Plan ID и циклические зависимости до записи, а `--dry-run` не создаёт и не перезаписывает output. `node --test scripts/roadmap-generator-cli.test.mjs` — 8/8 PASS; независимый review CLI-правки — PASS; `pnpm docs:roadmap --dry-run` — 34 Plans. Generated register пересобран на эту дату. Более ранние подсчёты относятся к предыдущим snapshots и не описывают текущий inventory.

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`. План выполняется по задачам; каждый шаг оформляется как checkbox (`- [ ]`).

## Goal

Историческая цель: реализовать генерацию roadmap-документа из метаданных планов, снизив ручную синхронизацию.

## Architecture

Скрипт будет:

1. Сканировать `docs/architecture/plans/` на наличие `.md` файлов
2. Парсить YAML frontmatter плана (id, status, title, depends_on и т.д.)
3. Генерировать canonical roadmap document с:
   - Plan Register
   - Dependency Graph
   - Blockers and Evidence
   - Proposals
4. Поддерживать режим предпросмотра (dry-run) перед записью
5. Интегрироваться в существующую команду `pnpm docs:roadmap`

## Tech Stack

- Node.js, TypeScript
- Существующая инфраструктура: `scripts/docs-governance.mjs`
- Vitest для тестов
- Стандартные filesystem и YAML parsing инструменты

## Global Constraints

- Production-код не изменён до согласования плана
- Комменты и JSDoc на русском
- Скрипт не может изменять другие файлы кроме roadmap
- Поддержка Windows/Linux/macOS
- Валидация перед записью: проверять уникальность планов, корректность зависимостей

## Зафиксированное состояние

| Аспект | Статус |
|--------|--------|
| Скрипт генерации | Не реализован, плейсхолдер |
| Текущий roadmap | Ручное редактирование, есть риск рассинхронизации |
| Планов | 12+ (планируется расширение) |
| Валидация | Отсутствует |

## Зависимый порядок реализации

### Task 1: Создать YAML парсер планов

**Files:**
- Create: `scripts/plan-parser.ts`
- Create: `scripts/plan-parser.test.ts`

**Interfaces:**
- `parsePlan(path: string): PlanMetadata`
- `PlanMetadata`: id, kind, status, title, created, updated, depends_on, specs, evidence

**Steps:**
- [ ] RED test для parsing frontmatter из sample plan
- [ ] Implement parser с помощью yaml или yaml parsing библиотеки
- [ ] Test на edge cases: missing fields, invalid yaml, nested arrays

### Task 2: Создать коллектор планов

**Files:**
- Create: `scripts/plan-collector.ts`
- Create: `scripts/plan-collector.test.ts`

**Interfaces:**
- `collectPlans(dir: string): PlanMetadata[]`

**Steps:**
- [ ] RED test для scanning директории и парсинга всех планов
- [ ] Implement коллектор с фильтрацией non-plan файлов
- [ ] Test обработки ошибок чтения

### Task 3: Создать генератор roadmap

**Files:**
- Create: `scripts/roadmap-generator.ts`
- Create: `scripts/roadmap-generator.test.ts`

**Interfaces:**
- `generateRoadmap(plans: PlanMetadata[]): string`
- `renderPlanRegister(plans: PlanMetadata[]): string`
- `renderDependencyGraph(plans: PlanMetadata[]): string`

**Steps:**
- [ ] RED test для генерации markdown из test data
- [ ] Implement renderers для каждого секции
- [ ] Test корректности markdown formatting
- [ ] Test dependency graph generation

### Task 4: Интегрировать в governance скрипт

**Files:**
- Modify: `scripts/docs-governance.mjs`

**Steps:**
- [ ] Добавить импорт новых модулей
- [ ] Добавить команду `roadmap` с опциями: `--dry-run`, `--output`
- [ ] Валидация перед записью: проверять уникальность, циклические зависимости
- [ ] Test команды на real plan files

### Task 5: Создать тесты интеграции

**Files:**
- Create: `scripts/plan-parser.integration.test.ts`
- Create: `scripts/roadmap-generator.integration.test.ts`

**Steps:**
- [ ] RED тест: полная генерация из реальных планов
- [ ] Проверить что output matches current roadmap structure
- [ ] Test обновления при добавлении нового плана
- [ ] Test валидации ошибок

### Task 6: Добавить документацию

**Files:**
- Modify: `docs/architecture/plans/governance/00-01-documentation-governance.md`

**Steps:**
- [ ] Добавить раздел о генерации роадмапа
- [ ] Документировать CLI опции
- [ ] Добавить примеры использования
- [ ] Обновить governance guide

### Task 7: Final verification

**Steps:**
- [ ] `pnpm test` для новых тестов
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] Dry-run генерации текущего состояния
- [ ] Сравнить с существующим roadmap
- [ ] Commit с `feat: add roadmap generator`

## Риски и меры

| Риск | Мера |
|------|------|
| Разрушение текущего roadmap | Dry-run по умолчанию, сравнение diff перед записью |
| Несовместимость с существующей структурой | Валидация перед записью, обратная совместимость |
| Производительность при большом количестве планов | Кэширование parsed metadata, инкрементальная генерация |
| Ошибки в парсинге frontmatter | Строгая валидация, информативные сообщения об ошибках |

## Порядок rollout

1. **Task 1-2:** Базовая парсинг-инфраструктура
2. **Task 3-4:** Генерация и интеграция в CLI
3. **Task 5:** Тесты интеграции
4. **Task 6:** Документация
5. **Task 7:** Verification и commit

---

*Этот план не реализует код сам по себе; каждый task должен выполняться отдельно с RED test-first подходом.*
