---
id: plan-08-02
kind: plan
title: Web UI Core Functional — Onboarding, Dashboard, Project
status: completed
created: 2026-09-23
updated: 2026-09-28

depends_on:
  - plan-08-01
specs:
  - docs/architecture/specs/02-web-ui-recovery-design.md
evidence:
  - apps/web/src/features/onboarding/
  - apps/web/src/features/dashboard/
  - apps/web/src/features/projects/
  - apps/web/test/features/onboarding.test.tsx
  - apps/web/test/e2e/v1-ui.spec.ts
  - docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md
---

> Historical legacy UI sequence: A–D labels are retained as archival stage names, not as a current roadmap or plan grouping.

# План реализации Web UI Core Functional (Onboarding + Dashboard + Project)

> **Для агентного исполнителя:** используй `ebb-execute-plan` и `ebb-implement-task`; перед началом подтверди завершение всех Plan ID из `depends_on`.

**Цель:** реализовать три утверждённых экрана V1 с реальными backend-подключениями, без декоративных контролов и post-v1 scope.

**Scope:**
- Project Onboarding (`/projects/new`)
- Dashboard (`/`)
- Project View (`/projects/:id`)

**Architecture invariants:**
- Backend read models — единственный источник данных.
- API adapters через `packages/contracts`.
- Query/cache layer через `apps/web/src/state`.
- Shared primitives (`PageState`, `StatusBadge`, `AsyncBoundary`) обязательны.
- Русские комментарии и JSDoc для публичных API.
- Никаких новых frontend frameworks.
- Concurrency ≤ 2 субагента.
- Nested delegation запрещён.

**Исходные материалы:**
- `docs/architecture/specs/02-web-ui-recovery-design.md`
- `docs/architecture/plans/2026-09-22-web-ui-recovery-stage-a.md`
- `docs/architecture/plans/2026-09-16-foundation-persistence.md`
- `apps/web/src/features/` текущая структура

**Backend контракты (из read models):**
- `GET /api/v1/onboarding/discover` — discovery результата
- `GET /api/v1/projects/:id` — проектный projection
- `GET /api/v1/dashboard` — dashboard projection
- `POST /api/v1/onboarding/discover` — initiate discovery

---

## Задача 1 — Проект Onboarding: базовый flow

**Файлы:**
- `apps/web/src/features/onboarding/` (создать/обновить)
- `apps/web/test/features/onboarding.test.tsx` (создать)

**Шаги:**
1. [ ] Создать компоненты:
   - `OnboardingPage.tsx` — контейнер страницы
   - `RepositoryForm.tsx` — форма ввода URL
   - `DiscoverStatus.tsx` — отображение состояния discovery

2. [ ] Создать adapter:
   - `apps/web/src/features/onboarding/api.ts` — обёртки для `/onboarding/discover`

3. [ ] Реализовать состояния:
   - initial: форма ввода
   - loading: процесс discovery
   - success: отображение результатов
   - error: сообщение с retry

4. [ ] Добавить test:
   - форма submit с валидацией
   - адаптер вызывает `/api/v1/onboarding/discover`
   - состояния loading/success/error корректно рендерятся

5. [ ] Запустить:
   - `pnpm test -- test/features/onboarding.test.tsx`
   - `pnpm build` (web)

---

## Задача 2 — Dashboard: подключение projection

**Файлы:**
- `apps/web/src/features/dashboard/DashboardPage.tsx` (обновить)
- `apps/web/src/features/dashboard/api.ts` (обновить)

**Шаги:**
1. [ ] Создать/обновить adapter:
   - `GET /api/v1/dashboard`
   - `GET /api/v1/execution`

2. [ ] Реализовать секции:
   - Running agents (с линками на runs)
   - Active work (с линками на tasks)
   - Need approval (количество)
   - AI spend (токены, стоимость)
   - Active projects
   - Execution queue

3. [ ] Состояния для каждого projection:
   - loading: skeleton или индикатор
   - empty: корректное сообщение
   - error: безопасное сообщение с retry

4. [ ] Добавить test:
   - mock-ответы от API
   - все секции рендерятся с данными
   - ошибки проецируются изолированно

5. [ ] Запустить:
   - `pnpm test -- test/core-views.test.tsx`

---

## Задача 3 — Project View: полный projection

**Файлы:**
- `apps/web/src/features/projects/ProjectPage.tsx` (обновить)
- `apps/web/src/features/projects/api.ts` (обновить)

**Шаги:**
1. [ ] Создать/обновить adapter:
   - `GET /api/v1/projects/:id`

2. [ ] Реализовать секции:
   - Repository/GitHub info
   - Overview (статус, метаданные)
   - Epics list (с линками)
   - Tasks list (с линками)
   - Activity / Events
   - Usage

3. [ ] Состояния:
   - loading
   - empty (проект найден, но работы нет)
   - not-found (проект отсутствует)
   - error

4. [ ] Добавить test:
   - mock-ответы API
   - обработка not-found
   - кодирование ID в ссылках

5. [ ] Запустить:
   - `pnpm test -- test/core-views.test.tsx`

---

## Задача 4 — Интеграция и accessibility

**Файлы:**
- `apps/web/src/app/router.tsx` (проверить)
- `apps/web/src/styles/base.css` (обновить при необходимости)

**Шаги:**
1. [ ] Проверить маршруты:
   - `/projects/new` → Onboarding
   - `/` → Dashboard
   - `/projects/:id` → Project

2. [ ] Добавить breadcrumb metadata:
   - `handle.breadcrumbLabel` для всех маршрутов

3. [ ] Проверить keyboard navigation:
   - фокус на формах
   - фокус на навигации

4. [ ] E2E тесты:
   - `apps/web/test/e2e/v1-ui.spec.ts` добавить:
     - прямая навигация на `/projects/new`
     - прямая навигация на `/projects/test-id`
     - reload на Dashboard

---

## Задача 5 — Проверка и gates

**Шаги:**
1. [ ] Запустить:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test` (web + server)
   - `pnpm test:e2e`

2. [ ] Проверить:
   - `git diff --check`
   - `pnpm web:build`

3. [ ] Independent review:
   - `ebb-review-task` для каждой задачи
   - `ebb-final-review` для всего diff

---

## Файлы изменений (expected)

| Путь | Тип | Описание |
|------|-----|----------|
| `apps/web/src/features/onboarding/` | создать | Onboarding компоненты |
| `apps/web/src/features/onboarding/api.ts` | создать | Onboarding adapter |
| `apps/web/src/features/dashboard/api.ts` | обновить | Dashboard API calls |
| `apps/web/src/features/projects/api.ts` | обновить | Project API calls |
| `apps/web/test/features/onboarding.test.tsx` | создать | Onboarding tests |
| `apps/web/test/e2e/v1-ui.spec.ts` | обновить | E2E для новых routes |

---

## Implementation record (reconciled 2026-09-28)

The old completion note incorrectly claimed `completed` while this plan's metadata and acceptance checklist remained open. This reconciliation closes that mismatch with fresh evidence. Onboarding (/projects/new), Dashboard (/), and Project View (/projects/:id) have real API adapters, projection rendering, and loading/empty/error/not-found states. Plan 08-03 subsequently expanded onboarding to persisted discovery/approval/activation; that implementation is accepted as replacement evidence for the onboarding work here.

The independent review found and the current tree fixes a stale route-ID closure in Project View. The regression changes the same mounted page from project A to project B, checks the B request and rendered projection. The review also found missing Activity/Events content; Project View now renders each event's type and localized time in an accessible `<time>` element and deliberately omits its untrusted payload. A populated-projection test checks both rendering and payload exclusion. Final whole-plan review: PASS; no load-bearing findings remain. One minor onboarding `aria-describedby` target mismatch is non-blocking because the error alert remains announced.

Verification on 2026-09-28: focused Project suite 58/58; `pnpm lint` PASS; `pnpm typecheck` PASS; full `pnpm test` PASS (Server 870/872, 2 skipped; Web 200/200; contracts 4/4; launcher 19/19); `pnpm build` PASS; browser E2E 6/6 PASS with clean teardown.

---

## Completion criteria

- [x] Все 3 экрана рендерятся без ошибок (component tests in `apps/web/test/core-views.test.tsx`)
- [x] API adapter вызывают реальные backend endpoints (`apps/web/src/features/{onboarding,dashboard,projects}/`)
- [x] States (loading/empty/error/not-found) корректны (screen component tests)
- [x] Russian JSDoc добавлен для новых публичных API (onboarding API and public feature modules reviewed)
- [x] Все тесты проходят (fresh full workspace gate 2026-09-28)
- [x] E2E покрывает базовую навигацию and persisted onboarding/project flow (`apps/web/test/e2e/v1-ui.spec.ts`)
- [x] Independent review = PASS (2026-09-28)
- [x] Gates пройдены (2026-09-28)

---

## Ограничения

- Не добавлять пост-v1 scope (Coordinator Chat, Project List API, etc.)
- Не менять backend contracts
- Не создавать optimistic state без backend подтверждения
- Не редактировать файлы других Plan вне их собственного scope; `plan-08-01` поддерживается независимо
- Сохранять существующие pre-existing изменения

---

## Статус выполнения

[x] Task 1: Onboarding
[x] Task 2: Dashboard
[x] Task 3: Project View
[x] Task 4: Integration & accessibility
[x] Task 5: Gates & review
