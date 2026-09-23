# Stage C: Onboarding + Dashboard + Project Implementation

**Цель:** Реализовать три утверждённых экрана V1 с реальными backend-подключениями и полным onboarding flow.

## Задачи

### C1. Onboarding: Полный flow (discover → review → approve → activate)

**Текущее состояние:** OnboardingPage реализует только discovery. Нет шагов approval и activate.

**Что нужно сделать:**
1. Добавить отображение статуса onboarding project
2. Добавить кнопку "Request Approval" после discovery
3. Добавить кнопку "Approve" при статусе PENDING
4. Добавить кнопку "Activate" после утверждения

**Backend endpoints (из contracts):**
- `POST /api/v1/onboarding/discover` — initiate discovery
- `GET /api/v1/onboarding/:id` — получить onboarding project
- `POST /api/v1/onboarding/:id/approval` — запросить approval
- `POST /api/v1/onboarding/:id/approve` — утвердить
- `POST /api/v1/onboarding/:id/activate` — активировать

### C2. Dashboard: Подключение projection

**Текущее состояние:** DashboardPage уже подключён к `/api/v1/dashboard` и `/api/v1/execution`.

**Что нужно сделать:**
- Проверить что все projection fields отображаются
- Добавить retry для каждого projection независимо

### C3. Project View: Полный projection

**Текущее состояние:** ProjectPage подключён к `/api/v1/projects/:id`.

**Что нужно сделать:**
- Проверить что все projection fields отображаются
- Добавить navigation на epics/tasks

## Acceptance Criteria

- Onboarding: discovery → review → approve → activate flow работает с backend
- Dashboard: все секции рендерятся с данными
- Project: все секции рендерятся с данными
- Все тесты проходят
- Russian JSDoc добавлен для новых публичных API
