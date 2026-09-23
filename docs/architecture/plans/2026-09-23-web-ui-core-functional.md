# План реализации Web UI Core Functional (Onboarding + Dashboard + Project)

> **Для агентного исполнителя:** используй `ebb-execute-plan` и `ebb-implement-task` для последовательного выполнения. Не начинай до подтверждения Stage A/B завершённости.

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
- `docs/architecture/specs/2026-09-18-web-ui-recovery-design.md`
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

## Completion criteria

- [ ] Все 3 экрана рендерятся без ошибок
- [ ] API adapter вызывают реальные backend endpoints
- [ ] States (loading/empty/error/not-found) корректны
- [ ] Russian JSDoc добавлен для новых публичных API
- [ ] Все тесты проходят
- [ ] E2E покрывает базовую навигацию
- [ ] Independent review = PASS
- [ ] Gates пройдены

---

## Ограничения

- Не добавлять пост-v1 scope (Coordinator Chat, Project List API, etc.)
- Не менять backend contracts
- Не создавать optimistic state без backend подтверждения
- Не редактировать Stage A/B файлы без явной необходимости
- Сохранять существующие pre-existing изменения

---

## Статус выполнения

[ ] Task 1: Onboarding
[ ] Task 2: Dashboard
[ ] Task 3: Project View
[ ] Task 4: Integration & accessibility
[ ] Task 5: Gates & review
