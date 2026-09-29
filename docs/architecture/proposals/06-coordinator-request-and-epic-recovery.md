---
id: proposal-06
status: proposed
title: Публичный Coordinator request flow и восстановление Epic после рестарта
date: 2026-09-29
type: proposal
tags: [planning, epic, recovery, v1]
---

# Proposal: Coordinator request flow и восстановление Epic

**Статус:** proposed; перечисленные решения блокируют implementation plan и закрытие `plan-05`.

## 1. Цель и границы

Закрыть acceptance gap `plan-05`: пользователь передаёт natural-language запрос через application flow, Coordinator создаёт validated Epic plan, человек одобряет план, Epic исполняется детерминированным orchestrator и продолжает с последнего durable checkpoint после аварийного рестарта.

Proposal ограничивает изменения существующими `PlanningService`, `EpicOrchestrator`, authenticated project routes, approvals, Scheduler и SQLite. Hermes не получает authority создавать persistent IDs, изменять lifecycle или обходить approvals. Final merge остаётся отдельным human gate.

Не входят: изменение approval policy, автоматическое одобрение планов или merge, новая система хранения, multi-user collaboration, vector search и новая роль Coordinator.

## 2. Текущее состояние

- `POST /api/v1/projects/:projectId/epics/plans` принимает уже структурированный план, а `POST .../approve-run` одобряет его и начинает Epic. Natural-language запроса эти routes не принимают.
- `PlanningService.createRequest` сохраняет request, но не связывает его с Coordinator `AgentRun` и созданным plan.
- `EpicOrchestrator` сохраняет `stage`, `sequence_json` и валидированные `orchestration_phase_runs`; повторный вызов для существующего Epic умеет продолжить execution.
- На старте `EpicOrchestrator` reconciles stale Runs и Scheduler reservations, но composition root не вызывает resume для всех durable незавершённых Epic.
- Tests на `FakeAgentRuntime` подтверждают детерминированную state machine, но не доказывают user-visible request flow или поведение после kill/start.

## 3. Рассмотренные варианты

### A. Project-scoped request API, UI и startup resume — рекомендуется

Добавить минимальный request view к Project UI, durable request/plan relation, authenticated routes, Coordinator dispatch и startup recovery для Epic. Это даёт acceptance реального product path и соответствует system design, где пользователь отправляет natural-language request через Coordinator Chat.

Цена: изменение API/UI, lifecycle записи request и bounded startup recovery до объявления сервера `READY`.

### B. Только test harness поверх существующих application services

E2E напрямую создаёт `PlanningRequest`, вызывает Coordinator и `EpicOrchestrator`, а после рестарта вручную вызывает resume.

Цена: проще и уже, но не проверяет public request flow и не подтверждает, что production startup сам возобновляет Epic. Такой вариант не закрывает текущий load-bearing finding.

### C. Структурированный API оставить публичной границей

Оставить текущий route, добавить только restart recovery, а NL → plan acceptance считать отдельным UI/Coordinator deliverable.

Цена: не соответствует задаче `request-to-epic` и оставляет Plan 05 неполным до отдельного scope decision.

## 4. Рекомендуемый контракт

### Request flow

- `POST /api/v1/projects/{projectId}/requests` принимает `{ request: string }`; проект должен быть ACTIVE и иметь одобренный onboarding. Сервер устанавливает `requestedBy` из local session, а не из body.
- Route создаёт durable `PlanningRequest`, ставит Coordinator работу через существующие Jobs/Outbox/Scheduler boundaries и возвращает `202 { requestId, status }`. HTTP не удерживается на длительности Hermes Run.
- `GET /api/v1/projects/{projectId}/requests/{requestId}` возвращает status, безопасную ошибку, связанный pending plan и его версию. Ни prompt secrets, ни непроверенный raw output в status DTO не входят.
- Вывод Coordinator проходит `validateRoleOutput`, `validatePlan` и deterministic policy до записи `PlanningPlan`. Для Epic действует существующая обязательная approval policy. До одобрения materialization не создаёт Epic/Task IDs и Scheduler не запускает дочернюю работу.
- Существующие `POST /api/v1/projects/{projectId}/epics/plans/{planId}/approve-run` остаются human gate и запускают только тот plan, который связан с этим request и принадлежит тому же Project. Повтор approval/run идемпотентен по сохранённой связи.
- Ответ классификации `NEEDS_INPUT`, `TASK` либо `EPIC` хранится на PlanningRequest. В рамках этого acceptance запрос выбирается так, чтобы Coordinator классифицировал его как Epic с 2–3 зависимыми Tasks; изменение standalone Task UX не входит в acceptance.

### Durable state и restart

- `planning_requests` хранит конечный status (`RECEIVED`, `PLANNING`, `NEEDS_INPUT`, `PLAN_PENDING_APPROVAL`, `REJECTED`, `MATERIALIZED`, `FAILED`), инициатора, project ID, связанные run/plan ID, created/updated timestamps и безопасный failure code. Request text сохраняется согласно текущей политике project data.
- Связь request → plan и plan status update сохраняются транзакционно. Единственный активный Coordinator planning attempt для request защищён durable claim/idempotency key; process-local lock не является механизмом корректности.
- Перед `READY` startup recovery помечает оборванный AgentRun terminal, освобождает/reconciles Scheduler state, а затем resume-ит одобренные Epic в стадиях до `FINAL_APPROVAL`. Уже подтверждённые `orchestration_phase_runs` повторно не запускаются.
- Recovery повторно использует persisted Epic, Task, dependency и phase IDs. Никакие новые Tasks не создаются из повторного исполнения той же фазы. Ошибка восстановления оставляет Epic видимым как blocked/failed и не переводит server в ложный `READY`.
- `FINAL_APPROVAL` остаётся ожиданием пользователя; startup никогда не вызывает `MergeService` без действующего persisted approval.
- Recovery dispatch применяет обычные Scheduler, budgets, permissions и Git reconciliation. Если зависимый subsystem недоступен, система сообщает bounded blocker и не отправляет незарегистрированный Run.

### API, UI и security

- Routes используют существующие local-session, Origin и CSRF boundary; URL `projectId` проверяется по durable ownership для request/plan.
- Web UI получает project-scoped request composer и read-only progress/plan approval view. Approval summary показывает Epic goal, Tasks, dependencies, acceptance criteria и решения PM/Architect до materialization.
- Request text и весь model output недоверенные. Только deterministic validated plan меняет domain state; repo instructions и model output не являются policy.
- API/logs не раскрывают credentials, raw stack traces или несанитизированный Hermes output. Ошибки возвращают controlled category и correlation ID.

## 5. Проверка

- Unit: Request state transitions, stable request/plan relation, повторный approval, duplicate job delivery, malformed Coordinator output и cross-project IDs.
- Integration: authenticated API создает request; Coordinator result формирует pending plan; до одобрения нет Epic/Tasks/AgentRuns; approval материализует IDs одной транзакцией.
- Recovery: test server выполняет и интегрирует минимум одну child Task, затем принудительно завершается; production `dist/main.js` стартует с той же disposable home/SQLite, восстанавливает оставшиеся Tasks, не повторяет completed phase/Run и доходит до ожидаемого approval gate.
- Real Hermes acceptance запускается только с доступным поддерживаемым CLI/profile/provider и сохраняет redacted evidence отдельно от deterministic CI.
- Полные gates Plan 05 и независимый whole-plan review нужны до `completed`.

## 6. Решения, нужные до implementation plan

1. Принять вариант A (request API + минимальный UI + automatic startup resume), либо выбрать B/C и признать, что текущий Plan 05 acceptance/scope меняется.
2. Подтвердить, что startup должен автоматически resume-ить одобренные Epic до `READY`, а не показывать их как `PAUSED` до ручного resume.
3. Подтвердить минимальный UI request/plan approval view как часть Plan 05; существующий API сейчас не предоставляет пользовательский NL request path.

Real Hermes provider acceptance останется отдельным runtime gate и не заменяется решением по API/UI.

## 7. Решение пользователя

Пока не получено. До принятия решений выше реализация нового request flow или изменения startup/resume semantics не начинается.
