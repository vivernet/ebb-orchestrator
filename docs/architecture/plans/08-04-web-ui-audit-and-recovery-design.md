---
id: plan-08-04
title: Plan Document
status: completed
created: 2026-09-23
---

# План аудита и проектирования восстановления Web UI Ebb Orchestrator

> **Для агентного исполнителя:** этот этап является audit/design stage. Не начинай широкое переписывание frontend до завершения аудита и утверждения recovery design.
>
> **Цель:** установить реальное текущее состояние `apps/web`, проверить каждый утверждённый экран V1 относительно реальных backend capabilities и поведения в браузере, определить что необходимо сохранить, исправить или переписать, а затем создать точный recovery design для последующих implementation plans.
>
> **Архитектура:** утверждённая information architecture V1 остаётся базой, пока текущая реализация не докажет необходимость конкретной корректировки. Проверка должна идти по цепочке:
>
> `design → backend/read models → frontend route/component → browser behavior`.
>
> **Технологии:** использовать фактический frontend stack проекта. На этапе аудита нельзя вводить новый framework.
>
> **Спецификация:** `docs/architecture/specs/01-system-design.md`
>
> **Результаты этапа:**
> - `docs/audit/web-ui-gap-analysis.md`;
> - `docs/audit/web-ui-code-map.md`;
> - `docs/architecture/specs/02-web-ui-recovery-design.md`.
>
> **Жёсткий лимит:** одновременно не более 2 субагентов.

---

# Глобальные ограничения

- Сначала прочитать `.hermes.md`.
- Не более 2 субагентов одновременно.
- Nested delegation запрещён.
- Этап преимущественно read-only.
- Нельзя сразу переписывать frontend «по ощущениям».
- Небольшие test probes допустимы только для доказательства finding.
- Все новые/изменяемые production comments — на русском, JSDoc по правилам проекта.
- Нельзя менять backend contracts только ради удобства плохого UI.
- Нельзя придумывать endpoints/actions.
- Обязательна browser verification запущенного приложения.
- Наличие JSX не является доказательством работоспособности feature.
- Нельзя добавлять post-v1 scope.

---

# Задача 1 — Зафиксировать frontend/backend baseline

**Файлы:**
- Читать: root/package manifests.
- Читать: `apps/web/**`.
- Читать: backend API/read-model routes, используемые Web UI.
- Создать: `docs/audit/web-ui-code-map.md`.

- [ ] Зафиксировать branch/HEAD/status.
- [ ] Определить реальный frontend framework.
- [ ] Определить router.
- [ ] Определить state/query layer.
- [ ] Определить test runner.
- [ ] Определить browser/E2E tooling.
- [ ] Найти реальные web dev/build/test scripts.
- [ ] Сопоставить routes и source files.
- [ ] Найти shared UI primitives.
- [ ] Найти application shell/layout.
- [ ] Найти API client.
- [ ] Найти query/state code.
- [ ] Сопоставить backend endpoints/read models и frontend consumers.
- [ ] Найти доказанный dead/unreferenced code.

Создать `docs/audit/web-ui-code-map.md`:

```markdown
# Карта кода Web UI

## Baseline
## Frontend Stack
## Routes
## Application Shell / Layout
## Shared UI Primitives
## API Client
## Query / State Layer
## Feature Modules
## Tests
## Backend Routes and Read Models
## Подтверждённый dead/unused code
```

---

# Задача 2 — Построить contract matrix всех утверждённых экранов V1

Использовать Appendix A утверждённого design.

Обязательно проверить:

```text
Dashboard
Project View
Epic View
Task View
Approval Inbox
Execution Queue / Agents Monitor
Agent Run Detail / Live Logs
Usage & Budget
Settings / Project Configuration
Project Onboarding
```

Для каждого экрана зафиксировать:

```text
утверждённое назначение
required data
required actions
frontend route
frontend components
backend read model / endpoint
backend mutations
реализован?
виден в браузере?
функционален?
есть tests?
решение
```

Допустимые решения:

```text
KEEP
FIX
REWRITE
MISSING_UI
MISSING_BACKEND
CONTRACT_MISMATCH
REMOVE_DEAD_CODE
```

`KEEP` разрешён только если реальное browser behavior и tests подтверждают работоспособность.

---

# Задача 3 — Запустить приложение и проверить каждый route в браузере

Использовать только реальные repository scripts.

Запустить backend и Web UI контролируемым способом.

Для каждого route:

- открыть через нормальную навигацию;
- открыть напрямую;
- перезагрузить страницу на route;
- проверить loading state;
- проверить empty state;
- проверить error state, где это практически возможно;
- проверить реальное связывание данных;
- нажать все primary actions;
- проверить network/API result;
- проверить обновление состояния;
- проверить persistence;
- проверить console errors;
- найти disabled/dead controls.

Каждый defect должен содержать:

```text
route
action
expected
actual
evidence
severity
```

Скриншот сам по себе не является достаточным evidence.

---

# Задача 4 — Проверить основные end-to-end product flows

Проверить через текущий UI, насколько это возможно.

## Project Onboarding

```text
Repository
→ Discovery
→ Review Findings
→ Approve Config
→ Activate
```

## Standalone Task

```text
создание/request
→ development
→ review
→ QA
→ integration
→ approval
```

## Epic

```text
project
→ epic
→ child tasks
→ review
→ QA
→ integration
→ final merge approval
```

## Approval

```text
request
→ detail/evidence
→ approve/reject/request changes
→ persisted result
```

## Operations

```text
queue
→ running/blocked/waiting reason
→ pause/cancel, если поддерживается
```

## Agent Run

```text
run
→ events
→ tool calls
→ logs
→ permission decisions
→ usage
→ recovery
```

## Settings

```text
read effective config
→ edit supported values
→ validation
→ persistence
```

Если flow нельзя выполнить через UI, отдельно установить:

- backend уже поддерживает это;
- backend не поддерживает;
- backend поддерживает частично;
- contract mismatch;
- state не exposed;
- mutation существует, но UI не подключён.

---

# Задача 5 — Провести параллельный frontend architecture + UX review

Разрешено одновременно запустить максимум двух read-only субагентов.

## Subagent A — Frontend Architecture Reviewer

Проверяет:

- route boundaries;
- component boundaries;
- data ownership;
- duplicated API/state logic;
- giant components;
- broken abstractions;
- loading/error duplication;
- testability;
- unnecessary coupling.

## Subagent B — Product/UX Reviewer

Проверяет:

- navigation;
- information hierarchy;
- discoverability;
- actionable statuses;
- dead/non-functional controls;
- терминологическую согласованность;
- возможность завершить approved flows;
- понятность ошибок;
- понятность пустых состояний.

Оба возвращают evidence.

Код не редактируют.

---

# Задача 6 — Создать factual gap analysis

Создать:

```text
docs/audit/web-ui-gap-analysis.md
```

Структура:

```markdown
# Ebb Orchestrator — Gap Analysis Web UI

## Verdict

## Baseline
## Approved V1 Screens
## Route Matrix
## Functional Flow Matrix
## Browser Findings

## KEEP
## FIX
## REWRITE
## MISSING UI
## MISSING BACKEND
## CONTRACT MISMATCH
## DEAD CODE

## Cross-Cutting Problems
- application shell/navigation
- data fetching/cache
- mutations
- loading/error/empty states
- forms/validation
- notifications
- tables/lists
- status visualization
- accessibility
- responsiveness
- testability

## Backend Gaps
Только доказанные.

## Recommended Rewrite Boundary
Точные директории/modules, которые сохранить или заменить.

## Required Implementation Stages
Dependency-ordered список этапов.
```

Фразы вроде «UI плохой» запрещены без конкретного evidence.

---

# Задача 7 — Создать recovery design

Создать:

```text
docs/architecture/specs/02-web-ui-recovery-design.md
```

Design должен точно определить:

```text
application shell
routing/navigation
frontend module boundaries
shared UI primitives / design system
API client
query/cache/state strategy
mutation/error strategy
loading/error/empty states
forms/validation
notifications
status presentation
page composition
browser/E2E testing
accessibility baseline
responsive behavior
```

Для каждого утверждённого экрана V1 описать:

- route;
- purpose;
- primary data;
- primary actions;
- loading state;
- empty state;
- error state;
- backend contract;
- reusable components;
- acceptance criteria.

Также design должен явно перечислить существующие файлы/modules как:

```text
RETAIN
REFACTOR
REWRITE
DELETE
```

Нельзя выбирать новый major frontend framework, пока audit не докажет, что текущий stack не способен разумно реализовать recovery design.

---

# Задача 8 — Разбить будущую реализацию на точные этапы

В recovery design сформировать independently testable stages.

Предпочтительная декомпозиция, если audit её подтверждает:

```text
A. Application shell + shared primitives
B. API/query/mutation foundation
C. Onboarding + Dashboard + Project
D. Task + Epic + Approval
E. Queue + Agent Run + Usage + Settings
F. Browser E2E + cleanup
```

Для каждого stage указать:

- точные modules/files из `web-ui-code-map.md`;
- acceptance criteria;
- tests;
- зависимости;
- что нельзя менять.

На этом этапе implementation code не писать.

---

# Задача 9 — Проверить audit/design artifacts

Выполнить реальные frontend checks:

```text
frontend lint
frontend typecheck
frontend tests
frontend build
git diff --check
```

Если для аудита создавались временные probes:

- удалить их;
- либо оставить только если они представляют ценность как постоянные tests.

Финальный diff этого этапа должен состоять преимущественно из audit/design документов.

---

# Задача 10 — Commit и остановка перед implementation

Commit:

```bash
git commit -m "docs: define Web UI recovery design"
```

После commit не начинать реальную переделку Web UI.

Финальный отчёт должен содержать:

- audit verdict;
- крупнейшие функциональные gaps;
- recommended rewrite boundary;
- recovery design path;
- предлагаемые implementation stages;
- явное указание, что implementation ждёт подтверждения пользователя.

Approval gate обязателен, потому что следующий этап меняет frontend architecture.

---

## Completion Note

Status updated to **completed**. Audit/design phase concluded with full Web UI baseline capture, contract matrix, browser verification, gap analysis (`docs/audit/web-ui-gap-analysis.md`), and recovery design (`docs/architecture/specs/02-web-ui-recovery-design.md`). Implementation stages A-F defined.

See artifacts: `docs/audit/web-ui-code-map.md`, `docs/audit/web-ui-gap-analysis.md`, `docs/architecture/specs/02-web-ui-recovery-design.md`.
