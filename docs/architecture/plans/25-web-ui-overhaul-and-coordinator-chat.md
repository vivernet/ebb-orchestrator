---
id: plan-25
kind: plan
status: proposed
title: Переработка web UI Ebb Orchestrator и полноценный чат с координатором
summary: 'Полная переработка веб-интерфейса по макетам reference-ui (Dashboard с чатом координатора, Task/Epic/Project, Approval Center, Execution Queue, Usage & Budget, Settings, Onboarding) и добавление полноценного чата с координатором: история сообщений, SSE-стриминг статусов, интеграция с планированием и одобрениями.'
created: 2026-10-24
updated: 2026-10-24
depends_on:
  - plan-20
  - plan-23
  - plan-24
specs:
  - ../specs/01-system-design.md
  - ../specs/02-web-ui-recovery-design.md
---

# Переработка web UI Ebb Orchestrator и полноценный чат с координатором — Implementation Plan

**Goal:** Сделать веб-интерфейс Ebb Orchestrator удобным и функциональным: нативная панель с чатом координатора (история сообщений, живые статусы планирования, одобрения) и переработка всех ключевых экранов по макетам `docs/architecture/reference-ui/*`.

**Architecture:** Приложение остаётся modular monolith: React 19 + Vite на `apps/web`, Fastify API на `apps/server`. Чат добавляется как отдельный модуль `chat/` с постоянной моделью `Conversation`+`Message` (таблицы `chat_conversations`/`chat_messages`), SSE-каналом `.../conversations/:id/events` по образцу существующего `routes/events.ts` и интеграцией с планированием через listener на `EventBus`; `planning_requests` остаётся источником правды статуса. Переработка UI — это постепенное замещение read-only skeleton-экранов полнофункциональными компонентами по макетам reference-ui, на единой дизайн-системе (тёмная тема, палитра из макетов), с закрытием гэпов аудита `09-web-ui-gap-analysis.md`.

**Authority:** утверждённый дизайн-контракт чата (LobeHub doc `d82f1d7e-fdc9-45dc-97e8-4996ab6087d3`); макеты `docs/architecture/reference-ui/01-dashboard-concept.html`…`10-agent-run-detail-concept.html`; спецификация `docs/architecture/specs/02-web-ui-recovery-design.md`; аудит `docs/audit/09-web-ui-gap-analysis.md`.

**Global Constraints:**
- Все новые/изменённые production-комментарии/JSDoc и UI-текст — по-русски; UI-названия русские; бренд `Ebb Orchestrator`.
- **Политика хранения ключей (IN-002):** хранилище ключей/секретов — **только внешнее хранилище и `.env`**. Никаких секретов, учётных данных, токенов и паролей в коде, UI, планах, комментариях, коммитах или любых файлах репозитория (включая захардкоженные значения, seed-файлы и тестовые фикстуры). Настройки провайдеров — через существующий `SecretStore`/`.env` (внешние от кода); не логировать и не выводить credential-значения. Разрешение на коммит любого конфига с возможными секретами — только после проверки на отсутствие реальных значений.
- Sim deterministic-first, modular monolith: никаких push/merge/force без явного разрешения; максимум 2 параллельных субагента.
- Миграции БД — только аддитивные, forward-only, номера продолжают существующий каталог (следующий свободный — `052`); исторические миграции не менять.
- Планы создаются через `ebb-write-plan`, ревьюятся через `ebb-review-plan`, исполняемый статус только после `APPROVED`.
- Не начинать implementation во время authoring плана; план — набор решений, которые implementer не должен угадывать.

**Specialist Constraints:** Database — `ebb-database-engineering` для новых миграций (052+), fresh/populated upgrade. Web — `ebb-web-e2e` с реальной локальной сессией для UI-переработки и чата. Security — review по границе SSE/websocket аутентификации и отсутствию утечки секретов. Design — hi-fi прототип в Canva/HTML до UI-реализации, сохранённый в evidence плана.

**Review Focus:** (1) Чат отображает полный контракт статусов планирования (RECEIVED→…→MATERIALIZED/FAILED/REJECTED) и корректно стримит статусную прогрессию через SSE; (2) история сообщений постоянна и cursor-пагинируется; (3) одобрения (approve/reject) делегируют в `EpicOrchestrator` и не расходятся с источником правды; (4) UI-переработка закрывает все гэпы аудита 09 без потери функциональности; (5) ни один секрет не попадает в UI/логи/коммиты.

## Сверка открытых записей roadmap notes

- **IN-001** (open) — проверка ожидающих правок в скиллах: не относится к scope этого плана; перенесено в отдельную работу, план не затрагивает.
- **IN-002** (принято в реализацию) — хранилище ключей: **только внешнее хранилище и `.env`**. Пользователь явно распорядился включить IN-002 в scope этого плана. Статус записи меняется `open` → `promoted` (linked_plan plan-25). Хранилище секретов/ключей в коде проекта категорически запрещено; все ключи и секреты — через `SecretStore`/`.env` (внешние от кода).
- **IN-004** (open) — статусы планов 19/20 не менять: этот план зависит от plan-20 только как от фона, статусы не трогаем (учтено).
- **IN-003** (open) — macOS CI отложена: не в scope, не блокирует (перенесено).
- **IN-005** (done) — plan-23 completed: учтено как базовое состояние провайдеров, не переоткрываем.
- **IN-006** (done) — исключение plan-22→plan-20: закрыто.

## File / interface map

| Owner | Files | Responsibility |
|---|---|---|
| Task 0 — дизайн и прототип | New `docs/architecture/plans/evidence/25-web-ui-prototype.html`, `25-chat-prototype-canva.md`; макеты reference-ui как вход | Единый hi-fi прототип переработанного UI (Dashboard с чатом, Task/Epic/Project, Approval, Execution, Usage, Settings, Onboarding) и референс чата; фиксация Canva-дизайна (ID/ссылка) при наличии. |
| Task 1 — контракты | Modify `packages/contracts/src/api.ts`; new `packages/contracts/src/chat.ts` (если уместно); тесты контрактов | Zod-схемы `chatConversationSchema`, `chatMessageSchema`, `sendMessageRequestSchema`, `sendMessageResponseSchema`, `messagesPageSchema`, enum ролей/видов; пути в `apiPaths` (conversations, conversationMessages, conversationEvents, planApprove/Reject). |
| Task 2 — миграции и хранилище | New `apps/server/src/platform/database/migrations/052_chat.sql`; new `apps/server/src/modules/chat/chat-repository.ts`; тесты миграции/репозитория | Таблицы `chat_conversations`/`chat_messages` (индекс по `(conversation_id, created_at)`), FK на `planning_requests(id)`/`planning_plans(id)`; CRUD с cursor-пагинацией. |
| Task 3 — модуль чата и интеграция с планированием | New `apps/server/src/modules/chat/chat-service.ts`, `chat-events.ts`; listener на `EventBus`; modify `apps/server/src/platform/home/production-composition.ts` | Сервис сообщений/бесед; зеркалирование статусов планирования в сообщения по карте переходов; вставка событий `message.created/planning.status/message.delta/message.complete`. |
| Task 4 — API-роуты чата | New `apps/server/src/app/routes/chat.ts`; modify `apps/server/src/app/create-app.ts`; тесты роутов | `GET/POST .../projects/:projectId/conversations`, `GET .../conversations/:id`, `GET/POST .../conversations/:id/messages` (cursor), `GET .../conversations/:id/events` (SSE), `POST .../conversations/:id/plans/:planId/approve|reject`. |
| Task 5 — UI-компонент чата | New `apps/web/src/features/chat/` (ChatPanel, ThreadView, Composer, ApprovalInline); modify `apps/web/src/features/dashboard/DashboardPage.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/i18n/ru.ts` | Встраивание чата координатора (история, статусы, одобрения, SSE-подписка) в Dashboard и на страницы Task/Epic/Project. |
| Task 6 — переработка экранов UI | Modify `apps/web/src/features/{projects,epics,tasks,approvals,execution,usage,settings,onboarding}/`; `apps/web/src/components/AppShell.tsx`; `apps/web/src/app/router.tsx` | Реализация макетов reference-ui и закрытие гэпов аудита 09 (project index, reject/request-changes, редактирование settings, run panels и т.д.). |
| Task 7 — тесты Vitest + Playwright E2E | New `apps/web/test/` и `apps/server/test/e2e/` для чата и UI; modify существующие e2e | Юнит-тесты компонентов/роутов; E2E сценарии: отправка сообщения, статусная прогрессия, одобрение, cursor-пагинация, SSE-реконнект, ключевые экраны. |
| Task 8 — интеграционная приёмка и docs | README, docs/roadmap/02-current-state.md, evidence | Полная приёмка всех задач, обновление current-state/roadmap после фактической приёмки; финальный whole-plan review. |

## Tasks

### Task 0 — Дизайн-система и hi-fi прототип (Canva/HTML)

**Depends on:** —

**Create:** `docs/architecture/plans/evidence/25-web-ui-prototype.html`; `docs/architecture/plans/evidence/25-chat-prototype-canva.md`.

**Interfaces:** Прототип фиксирует экраны: Dashboard (метрики, активные проекты, центр согласований, очередь выполнения, чат координатора), Project/Epic/Task (вкладки Обзор/Контракт/Запуски/Review/QA/Git/Использование), Approval Center (approve/reject/request-changes), Execution Queue (capacity/locks/причины), Usage & Budget, Settings (роли/модели, scheduler, recovery, Git), Onboarding (5 шагов). Единая дизайн-система: палитра из reference-ui (bg `#0b0d10`, panel `#12161b`, accent `#8ab4ff`, good `#77d19a`, warn `#e8c66a`, bad `#ef8e8e`, violet `#b79cff`), типографика Inter, сетка sidebar 230px. Чат — компонент первого класса, отображающий сообщения/статусы/одобрения.
Документ `25-chat-prototype-canva.md` фиксирует Canva-дизайн (идентификатор, ссылку, экспорт PDF) по образцу `24-provider-web-prototype-canva.md`, если Canva доступна; HTML-прототип — обязательный и самодостаточный референс.

**RED:** Открыть `25-web-ui-prototype.html` — до создания он отсутствует (404). Прототип обязан содержать экран Dashboard с чатом и вкладки Task; проверка на отсутствие секретов в HTML (grep по известным credential-паттернам) должна падать, если найден реальный секрет.

**GREEN:** Создан HTML-прототип со всеми указанными экранами и состояниями; документ Canva фиксирует ID/ссылку или явно сообщает о недоступности Canva; grep на секреты не даёт совпадений.

**Run:** Открыть файл в браузере; проверка отсутствия секретов — `Select-String -Path 25-web-ui-prototype.html -Pattern 'api_key|apiKey|password=|secret|token='` (ожидается пусто). Никакие реальные учётные значения не фигурируют.

**Expected:** Визуальный референс полной переработки UI, согласованный с макетами reference-ui; ноль секретов в артефактах.

**Review Focus:** Прототип отражает макеты reference-ui и чат; не содержит секретов.

### Task 1 — Контракты чата в `packages/contracts`

**Depends on:** Task 0.

**Modify:** `packages/contracts/src/api.ts`; **Create:** `packages/contracts/src/chat.ts` (при необходимости отдельный модуль); тесты.

**Interfaces:** `ChatConversationSchema`, `ChatMessageSchema`, `SendMessageRequestSchema` (`{content, asPlanningRequest?}`), `SendMessageResponseSchema` (`{message, planning?}`), `MessagesPageSchema` (cursor-пагинация, base64url от `createdAt|id`); enum `ChatRole = 'user'|'coordinator'|'system'`, `ChatKind = 'text'|'status_update'|'need_input'|'approval_request'|'approval_result'|'error'`. Добавить пути в `apiPaths`: `conversations`, `conversationMessages`, `conversationEvents`, `planApprove`, `planReject`.

**RED:** Тест контракта падает: схемы/пути отсутствуют или не проходят валидацию типов (typecheck + юнит).

**GREEN:** Схемы и пути добавлены; typecheck и тесты контрактов проходят; enum'ы покрывают все роли/виды из дизайн-контракта.

**Run:** `pnpm --filter @ebb-orchestrator/contracts typecheck`; `pnpm --filter @ebb-orchestrator/contracts test`.

**Expected:** Контракт валиден, все поля из утверждённого дизайна представлены.

**Review Focus:** Полнота схем, корректность cursor-формата, отсутствие секретов в контракте.

### Task 2 — Миграция 052 и репозиторий чата

**Depends on:** Task 1.

**Create:** `apps/server/src/platform/database/migrations/052_chat.sql`; `apps/server/src/modules/chat/chat-repository.ts`; тесты миграции/репозитория.

**Migration preflight:** Подтвердить, что `052` свободен (текущий каталог заканчивается на `051_provider_custom_models.sql`); если появилась новая миграция — пересчитать номер до реализации.

**Interfaces:** `chat_conversations` (`id` `conv_...`, `project_id` FK→projects, `title`|NULL, `status` DEFAULT 'ACTIVE', `created_at`, `updated_at`); `chat_messages` (`id` `msg_...`, `conversation_id` FK→chat_conversations, `role` CHECK (user/coordinator/system), `kind`, `content`, `request_id` FK→planning_requests(id), `plan_id` FK→planning_plans(id), `status` CHECK PlanningRequestStatus|NULL, `created_at`); индекс `idx_chat_messages_conv (conversation_id, created_at)`. Репозиторий: `createConversation`, `listConversations(projectId)`, `findConversation`, `appendMessage` (transaction), `listMessages(cursor, limit)` с upward/downward-пагинацией.

**RED:** Миграционные тесты падают до создания `052`: fresh-установка и upgrade `051→052` не проходят; `PRAGMA foreign_key_check` непустой при нарушении FK.

**GREEN:** Аддитивная миграция и репозиторий реализованы; fresh 001–052 и upgrade 051→052 проходят; FK и индекс на месте; исторические миграции не изменены.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/chat-migration.test.ts test/platform/database/fresh-install-migrations.acceptance.test.ts test/modules/chat/chat-repository.test.ts`.

**Expected:** Миграция и хранилище устойчивы, данные постоянны.

**Gates:** `ebb-database-engineering`; migration/store тесты; typecheck.

**Review Focus:** FK-целостность, cursor-пагинация, аддитивность.

### Task 3 — Сервис чата и интеграция с планированием

**Depends on:** Task 2.

**Create:** `apps/server/src/modules/chat/chat-service.ts`, `apps/server/src/modules/chat/chat-events.ts`; listener на `EventBus`; **Modify:** `apps/server/src/platform/home/production-composition.ts`.

**Interfaces:** `ChatService.sendMessage(conversationId, {content, asPlanningRequest?, requestId?})` — при `asPlanningRequest` создаёт `planning_request` (валидация проекта ACTIVE + активный onboarding, как `POST /requests`), ставит job `coordinator.planning` (`dedupeKey: planning:${id}`) и возвращает `{message, planning?: {requestId, status: 'RECEIVED'}}`; продолжение `NEEDS_INPUT` связывается с существующим `requestId`. Listener на `EventBus` зеркалирует переходы статусов в сообщения по карте: RECEIVED→text (с requestId), PLANNING→status_update, NEEDS_INPUT→need_input, PLAN_PENDING_APPROVAL→approval_request (с planId), MATERIALIZED→status_update, REJECTED→approval_result, FAILED→error (с failureCode). События: `message.created`, `planning.status`, `message.delta` (стриминг статусной прогрессии), `message.complete`, `conversation.updated`.

**RED:** Тест зеркалирования падает: переход статуса (например PLAN_PENDING_APPROVAL) не порождает `approval_request`-сообщение в тестовом EventBus-цикле.

**GREEN:** Сервис и listener реализованы; карта переходов покрыта тестами; событие `message.delta` отправляется для прогрессии статусов, токен-уровневый стриминг исключён (deterministic-first).

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/chat/chat-service.test.ts test/modules/chat/chat-events.test.ts`.

**Expected:** Интеграция с планированием работает end-to-end на уровне сервиса.

**Review Focus:** Карта переходов, отсутствие гонок с job, корректная связка requestId/planId.

### Task 4 — API-роуты чата (включая SSE)

**Depends on:** Task 3.

**Create:** `apps/server/src/app/routes/chat.ts`; **Modify:** `apps/server/src/app/create-app.ts`; тесты роутов.

**Interfaces:** Роуты (все под `/api/v1`, auth/CSRF как у остальных): `GET/POST .../projects/:projectId/conversations`; `GET .../conversations/:conversationId`; `GET/POST .../conversations/:conversationId/messages` (POST: body `{content, asPlanningRequest?, requestId?}`, ответ 202 `{message, planning?}`; GET: cursor-пагинация); `GET .../conversations/:conversationId/events` — SSE по образцу `routes/events.ts` (`writeHead(200, text/event-stream)`, `:ok`, heartbeat 15с, `reply.hijack()`, `preClose` destroy); `POST .../conversations/:conversationId/plans/:planId/approve` и `/reject` — делегируют `EpicOrchestrator`. Валидация — вручную (isPlainObject/isNonEmptyString), ошибки — `{contractVersion, error: {code, message}}`.

**RED:** Тесты роутов падают до реализации: `POST /conversations` возвращает 404; SSE-роут не отдаёт `text/event-stream` + стартовый `:ok`.

**GREEN:** Все роуты реализованы и покрыты тестами; approve/reject корректно делегируют; SSE отдаёт события и heartbeat; ошибки валидации возвращают 4xx с контрактной структурой.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/routes/chat.test.ts`; `pnpm --filter @ebb-orchestrator/server typecheck`.

**Expected:** API-контракт чата полностью работает и согласован с `apiPaths`.

**Gates:** Security review (SSE-аутентификация, отсутствие утечки секретов).

**Review Focus:** SSE-паттерн, approve/reject-делегирование, 4xx-контракт ошибок.

### Task 5 — UI-компонент чата

**Depends on:** Tasks 0, 4.

**Create:** `apps/web/src/features/chat/` (`ChatPanel.tsx`, `ThreadView.tsx`, `Composer.tsx`, `ApprovalInline.tsx`); **Modify:** `apps/web/src/features/dashboard/DashboardPage.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/api/events.ts`, `apps/web/src/i18n/ru.ts`.

**Interfaces:** Компонент подписывается на SSE `conversationEvents`, отображает историю (cursor-пагинация «загрузить раньше»), сообщения по ролям/видам, инлайн-одобрения (approve/reject) для `approval_request`, статусную прогрессию через `message.delta`, состояние `NEEDS_INPUT` с продолжением беседы. Все строки — из `ru.ts`. Клиент API имеет типизированные методы conversations/messages/events/approve/reject по `apiPaths`.

**RED:** Юнит-тест компонента падает: без SSE-подписки новые сообщения не появляются в ThreadView; кнопка одобрения не вызывает `planApprove`.

**GREEN:** Компонент реализован, SSE-подписка работает, одобрения отправляются, строки русские, стили следуют дизайн-системе из Task 0.

**Run:** `pnpm --filter @ebb-orchestrator/web exec vitest run src/features/chat`; `pnpm --filter @ebb-orchestrator/web typecheck`.

**Expected:** Чат отображается на Dashboard и взаимодействует с API.

**Review Focus:** SSE-реконнект, отображение статусов/одобрений, отсутствие секретов в UI.

### Task 6 — Переработка экранов UI по reference-ui

**Depends on:** Tasks 0, 5.

**Modify:** `apps/web/src/features/{projects,epics,tasks,approvals,execution,usage,settings,onboarding}/`; `apps/web/src/components/AppShell.tsx`; `apps/web/src/app/router.tsx`.

**Interfaces:** Реализовать: Project index + страница проекта (config, onboarding-гейт); Epic страница; Task с вкладками Обзор/Контракт/Запуски/Review/QA/Git/Использование; Approval Center (approve/reject/request-changes); Execution Queue (capacity/locks/причины); Usage & Budget; Settings (роли/модели, scheduler, recovery, Git/GitHub); Onboarding (5 шагов). Закрыть гэпы аудита 09: discovery/select onboarding, reject/request-changes, редактирование settings, run events/tools/permissions/recovery панели, project index; удалить dead code (`authenticatedHeaders()`, prop `projectId` в ApprovalInbox, если не используется).

**RED:** Проверка аудита 09: гэп-пункты отсутствуют в текущем UI; Playwright-тест экрана Approval (reject/request-changes) падает до реализации.

**GREEN:** Все экраны реализованы по макетам; гэпы аудита закрыты; e2e-сценарии ключевых экранов проходят.

**Run:** `pnpm --filter @ebb-orchestrator/web exec vitest run`; `pnpm --filter @ebb-orchestrator/web exec playwright test` (ключевые экраны).

**Expected:** Полнофункциональный UI, согласованный с макетами reference-ui.

**Gates:** `ebb-web-e2e`; security review.

**Review Focus:** Закрытие всех гэпов аудита 09, сохранение функциональности, отсутствие секретов.

### Task 7 — Тесты Vitest + Playwright E2E для чата и UI

**Depends on:** Tasks 5, 6.

**Create:** `apps/server/test/e2e/chat-*.acceptance.test.ts`, `apps/web/test/e2e/chat-*.spec.ts`.

**Interfaces:** E2E-сценарии: отправка сообщения → 202 + `{message, planning?}`; статусная прогрессия через SSE (RECEIVED→PLANNING→PLAN_PENDING_APPROVAL→MATERIALIZED); одобрение плана и отображение результата; cursor-пагинация истории; SSE-реконнект; ключевые экраны UI (Dashboard, Task вкладки, Approval reject/request-changes, Settings редактирование).

**RED:** Каждый сценарий падает до реализации соответствующей фичи (не найдены селекторы/ответы).

**GREEN:** Все сценарии проходят зелёным в локальной сессии; teardown чистый.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/chat-*.acceptance.test.ts`; `pnpm --filter @ebb-orchestrator/web exec playwright test`.

**Expected:** Полное покрытие чата и ключевых экранов UI сквозными тестами.

**Review Focus:** Сквозное поведение, стабильность, отсутствие флакей.

### Task 8 — Интеграционная приёмка, docs и whole-plan review

**Depends on:** Tasks 1–7.

**Modify:** `docs/roadmap/02-current-state.md`, релевантные README/доки, evidence.

**Interfaces:** Прогнать полный набор гейтов (`pnpm test`, typecheck, lint, docs-гейты); обновить current-state/roadmap только после фактической приёмки; зафиксировать evidence всех задач; финальный whole-plan review.

**RED:** Любой гейт падает — приёмка не завершена.

**GREEN:** Все гейты зелёные, docs обновлены, evidence собрано, whole-plan review PASS.

**Run:** `pnpm test`; `pnpm docs:check`; `pnpm docs:test`; `pnpm lint`.

**Expected:** План полностьстью реализован и принят; roadmap отражает новое состояние.

**Review Focus:** Полнота гейтов, отсутствие секретов во всех артефактах.

## Self-review

1. Каждое требование пользователя (чат + переработка UI + Canva-прототип) имеет owner: Task 0 (дизайн), Tasks 1–5 (чат), Task 6 (UI), Task 7 (тесты), Task 8 (приёмка).
2. Зависимости ацикличны: 0→1→2→3→4→5→6→7→8; producer существует до consumer; Task 0 предшествует UI-задачам как визуальный референс.
3. Имена/интерфейсы согласованы между задачами (схемы контрактов ↔ API ↔ UI-клиент).
4. RED действительно падает до изменения; GREEN проверяет production-путь.
5. Commands существуют и Expected конкретен; номера миграций пересчитываются на preflight.
6. High-risk режимы (SSE, approve/reject, секреты) тестируются или явно отданы specialist/final review.
7. План не является транскриптом кода; тела — только там, где без них есть неоднозначность.
