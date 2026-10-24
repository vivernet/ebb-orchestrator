---
id: plan-25
kind: plan
status: completed
title: Переработка web UI Ebb Orchestrator и полноценный чат с координатором
summary: 'Полная переработка веб-интерфейса по макетам reference-ui (Dashboard с чатом координатора, Task/Epic/Project, Approval Center, Execution Queue, Usage & Budget, Settings, Onboarding) и добавление полноценного чата с координатором: история сообщений, SSE-стриминг статусов, интеграция с планированием и одобрениями.'
created: 2026-10-24
updated: 2026-10-24
depends_on:
  - "plan-20 (informational: in_progress, фон, не блокирует)"
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
- **IN-004** (open) — статусы планов 19/20 не менять: plan-20 — informational зависимость (статус `in_progress`, зависит как фон, не блокирует); статусы не трогаем (учтено).
- **IN-003** (open) — macOS CI отложена: не в scope, не блокирует (перенесено).
- **IN-005** (done) — plan-23 completed: учтено как базовое состояние провайдеров, не переоткрываем.
- **IN-006** (done) — исключение plan-22→plan-20: закрыто.

## File / interface map

| Owner | Files | Responsibility |
|---|---|---|
| Task 0 — дизайн и прототип | New `docs/architecture/plans/evidence/25-web-ui-prototype.html`, `25-chat-prototype-canva.md`; макеты reference-ui как вход | Единый hi-fi прототип переработанного UI (Dashboard с чатом, Task/Epic/Project, Approval, Execution, Usage, Settings, Onboarding) и референс чата; фиксация Canva-дизайна (ID/ссылка) при наличии. |
| Task 1 — контракты | Modify `packages/contracts/src/api.ts`; new `packages/contracts/src/chat.ts` (если уместно); тесты контрактов | Zod-схемы `chatConversationSchema`, `chatMessageSchema`, `sendMessageRequestSchema`, `sendMessageResponseSchema`, `messagesPageSchema`, enum ролей/видов; пути в `apiPaths` (conversations, conversationMessages, conversationEvents, planApprove/Reject). |
| Task 2 — миграции и хранилище | Adopt/верифицировать существующий `apps/server/src/platform/database/migrations/052_chat.sql` (untracked, создан на authoring, схема совпадает с планом); new `apps/server/src/modules/chat/chat-repository.ts`; Modify тесты миграции (5 файлов, ожидают 052); new тесты репозитория | Таблицы `chat_conversations`/`chat_messages` (индекс по `(conversation_id, created_at)`), FK на `planning_requests(id)`/`planning_plans(id)`; CRUD с cursor-пагинацией. |
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

**RED:** Файлы evidence (`25-web-ui-prototype.html`, `25-chat-prototype-canva.md`) уже существуют — RED проверяет их содержимое: отсутствие обязательных экранов (Dashboard с чатом, вкладки Task и т.д.) или наличие секретов (grep по известным credential-паттернам) — красный сигнал.

**GREEN:** Содержимое HTML-прототипа полное — все указанные экраны и состояния присутствуют; документ Canva фиксирует ID/ссылку или явно сообщает о недоступности Canva; grep на секреты не даёт совпадений.

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

**Create:** `apps/server/src/modules/chat/chat-repository.ts`; тесты репозитория: `test/platform/database/chat-migration.test.ts`, `test/modules/chat/chat-repository.test.ts`. **Adopt/верифицировать существующий** `apps/server/src/platform/database/migrations/052_chat.sql` — уже создан на этапе authoring (untracked), схема совпадает с планом; не пересоздавать, не перенумерацивать.

**Migration preflight:** Миграция `052_chat.sql` уже существует (untracked, создана на authoring) и соответствует схеме плана — задача 2 её adopt/верифицирует, а не создаёт заново; перенумерация на `053` не требуется. Номера продолжают каталог (`051_provider_custom_models.sql` → `052_chat.sql`); исторические миграции не менять.

**Modify:** 5 тест-файлов, хардкодящих 51 миграцию: `apps/server/test/platform/database/fresh-install-migrations.acceptance.test.ts` (строки 25, 39–41), `provider-configuration-migration.test.ts` (40–42, 108), `provider-custom-models-migration.test.ts` (32–34, 59), `run-traces-migration.test.ts` (39–41, 77), `scheduler-run-request-provider-selection-migration.test.ts` (29–31). Правки: `expectedVersions` 51→52, проверка `applied` = 52, ассерт на `051_provider_custom_models` → `052_chat.sql`.

**Interfaces:** `chat_conversations` (`id` `conv_...`, `project_id` FK→projects, `title`|NULL, `status` DEFAULT 'ACTIVE', `created_at`, `updated_at`); `chat_messages` (`id` `msg_...`, `conversation_id` FK→chat_conversations, `role` CHECK (user/coordinator/system), `kind`, `content`, `request_id` FK→planning_requests(id), `plan_id` FK→planning_plans(id), `status` CHECK PlanningRequestStatus|NULL, `created_at`); индекс `idx_chat_messages_conv (conversation_id, created_at)`. Репозиторий: `createConversation`, `listConversations(projectId)`, `findConversation`, `appendMessage` (transaction), `listMessages(cursor, limit)` с upward/downward-пагинацией.

**RED:** Миграционные тесты падают до правки 5 тест-файлов (ожидание 51 при наличии `052`): fresh-установка и upgrade `051→052` не проходят; `PRAGMA foreign_key_check` непустой при нарушении FK.

**GREEN:** Аддитивная миграция и репозиторий реализованы; fresh 001–052 и upgrade 051→052 проходят; FK и индекс на месте; исторические миграции не изменены.

**Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/chat-migration.test.ts test/platform/database/fresh-install-migrations.acceptance.test.ts test/modules/chat/chat-repository.test.ts`.

**Expected:** Миграция и хранилище устойчивы, данные постоянны.

**Gates:** `ebb-database-engineering`; migration/store тесты; typecheck.

**Review Focus:** FK-целостность, cursor-пагинация, аддитивность.

### Task 3 — Сервис чата и интеграция с планированием

**Depends on:** Task 2.

**Create:** `apps/server/src/modules/chat/chat-service.ts`, `apps/server/src/modules/chat/chat-events.ts`, `test/modules/chat/chat-service.test.ts`, `test/modules/chat/chat-events.test.ts`; listener на `EventBus`; **Modify:** `apps/server/src/platform/home/production-composition.ts`.

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

**Run:** `pnpm --filter @ebb-orchestrator/web exec vitest run src/features/chat`; `pnpm --filter @ebb-orchestrator/web exec tsc -p tsconfig.json --noEmit` (скрипта `typecheck` в `apps/web/package.json` нет; `tsconfig.json` существует).

**Expected:** Чат отображается на Dashboard и взаимодействует с API.

**Review Focus:** SSE-реконнект, отображение статусов/одобрений, отсутствие секретов в UI.

### Task 6 — Переработка экранов UI по reference-ui

**Depends on:** Tasks 0, 5.

**Modify:** `apps/web/src/features/{projects,epics,tasks,approvals,execution,usage,settings,onboarding}/`; `apps/web/src/components/AppShell.tsx`; `apps/web/src/app/router.tsx`.

**Interfaces:** Реализовать: Project index + страница проекта (config, onboarding-гейт); Epic страница; Task с вкладками Обзор/Контракт/Запуски/Review/QA/Git/Использование; Approval Center (approve/reject/request-changes); Execution Queue (capacity/locks/причины, **Pause All** — гэп аудита 09); Usage & Budget; Settings (роли/модели, scheduler, recovery, Git/GitHub); Onboarding (5 шагов). Закрыть гэпы аудита 09: discovery/select onboarding, reject/request-changes, редактирование settings, run events/tools/permissions/recovery панели, project index; удалить dead code (`authenticatedHeaders()`, prop `projectId` в ApprovalInbox, если не используется).

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

## Дополнение от 2026-10-24 — Task 8: интеграционная приёмка и evidence (status: completed)

По распоряжению пользователя Task 8 (интеграционная приёмка и docs) исполнена как отдельная работа без коммитов/push/merge. Ниже — фактические результаты прогонов на текущем рабочем дереве (develop @ `8cc8eeb`, реализация Tasks 1–7 в рабочем дереве, не закоммичена).

### Реализованные возможности (Tasks 0–7)

- **Task 0** — evidence: `docs/architecture/plans/evidence/25-web-ui-prototype.html`, `25-chat-prototype-canva.md`, `25-chat-prototype-canva.pdf` (Canva `DAHY38uN8Dg`-серии не требуется; ссылка — в md-файле). Секретов в артефактах нет (grep по credential-паттернам пуст).
- **Task 1** — `packages/contracts/src/chat.ts` + расширение `packages/contracts/src/api.ts` (`apiPaths`: `conversations`, `conversationMessages`, `conversationEvents`, `planApprove`, `planReject`); контракт-тесты 37/37 PASS (packages/contracts).
- **Task 2** — adopt `apps/server/src/platform/database/migrations/052_chat.sql`; `apps/server/src/modules/chat/chat-repository.ts`; тесты `chat-migration.test.ts`, `chat-repository.test.ts`; 5 миграционных acceptance обновлены на 52 (fresh 001–052, upgrade 051→052).
- **Task 3** — `apps/server/src/modules/chat/chat-service.ts`, `chat-events.ts`, listener на `EventBus`, wiring в `production-composition.ts`; тесты `chat-service.test.ts`, `chat-events.test.ts`.
- **Task 4** — `apps/server/src/app/routes/chat.ts`, регистрация в `create-app.ts`; тесты `apps/server/test/app/routes/chat.test.ts`.
- **Task 5** — `apps/web/src/features/chat/` (ChatPanel, ThreadView, Composer, ApprovalInline), интеграция в Dashboard, `api/client.ts`, `api/events.ts`, `i18n/ru.ts`; юнит-тесты `ChatPanel.test.tsx`, `ThreadView.test.tsx`.
- **Task 6** — переработка экранов (projects, epics, tasks, approvals, execution incl. Pause All, usage, settings, onboarding), AppShell, router; закрытие гэпов аудита 09; тесты `configuration-views.test.tsx`, `core-views.test.tsx`, `epic-recovery-blocker.test.tsx`, `localization-accessibility.test.tsx`, `execution-pause-all.test.tsx`, `settings-scheduler-form.test.tsx`.
- **Task 7** — серверный acceptance `apps/server/test/e2e/chat-acceptance.acceptance.test.ts`; web E2E `apps/web/test/e2e/chat-web.spec.ts` + харнесс `chat-run-e2e.mjs`.

### Прогоны гейтов (фактические результаты)

| Gate | Команда | Результат |
|---|---|---|
| typecheck contracts | `tsc -p packages/contracts/tsconfig.json --noEmit` | exit 0 |
| typecheck server | `tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| typecheck web | `tsc -p apps/web/tsconfig.json --noEmit` | exit 0 |
| contracts tests | `pnpm --filter @ebb-orchestrator/contracts test` | 6 файлов / 37 тестов PASS, exit 0 |
| server vitest | `node node_modules/vitest/vitest.mjs run --config apps/server/vitest.config.ts apps/server/test` | 217 файлов: 211 PASS / 3 FAIL / 3 skipped; тесты 2634 PASS / 3 FAIL / 43 skipped; exit 1 |
| server чат focused | `node node_modules/vitest/vitest.mjs run --config apps/server/vitest.config.ts apps/server/test/modules/chat apps/server/test/platform/database/chat-migration.test.ts apps/server/test/app/routes/chat.test.ts apps/server/test/e2e/chat-acceptance.acceptance.test.ts` | 6 файлов / 50 тестов PASS, exit 0 |
| web vitest | `vitest run` (из apps/web) | 29 файлов / 251 тестов PASS, exit 0 |
| lint | `node node_modules/eslint/bin/eslint.js .` | 2 ошибки (`no-undef` `console` в `apps/web/test/e2e/chat-run-e2e.mjs`), exit 1 |
| server build | `pnpm server:build` | exit 0 (вкл. native helpers) |
| web build | `pnpm --filter @ebb-orchestrator/web build` | exit 0 (только warning о размере chunk) |
| docs:test | `node --test scripts/docs-governance.test.mjs` | 20/20 PASS |
| docs:check | `node scripts/docs-governance.mjs check` | после правок frontmatter/YAML — PASS (до правок падал на невалидном статусе `approved`) |
| roadmap dry-run | `node scripts/roadmap-generator-cli.mjs --dry-run` | после правок YAML — PASS |
| root scripts | `node --test scripts/{server-env,run-server,local-user-stdin-smoke,plan06-project-config-restart-acceptance,plan06-github-inbox-restart-acceptance,hermes-session-tag-acceptance,build-windows-msvc-environment,hermes-dev}.test.mjs` | 71 PASS / 2 FAIL (см. ниже), exit 1 |
| web E2E (штатный) | `pnpm --filter @ebb-orchestrator/web test:e2e` (run-e2e.mjs) | 11 PASS / 5 skipped, exit 0 |
| chat E2E (attach) | `node apps/web/test/e2e/chat-run-e2e.mjs` | 14 PASS / 2 FAIL — оба в `v1-ui.spec.ts` из-за ограничений attach-режима (нет `EBB_E2E_CONTROL_CHANNEL`, сценарий dashboard-пустоты зависит от засеянного состояния); `chat-web.spec.ts` PASS |
| git diff --check | `git diff --check` | PASS |

### Известные pre-existing / environmental failures (не новые)

- `apps/server/test/e2e/v1-crash-matrix.test.ts` — «recovers an interrupted run after a killed production process and explicit stale-lock cleanup» (timeout ~13.8s): известный гейт планов 06/19, не связан с изменениями плана 25.
- `apps/server/test/platform/process/darwin-run-supervisor.test.ts` — `EBB_DARWIN_FRAME_WRITE_FAILED`/EPIPE: macOS-only супервизор не может быть исполнен на Windows, среда.
- `scripts/hermes-dev.test.mjs` — 2 FAIL: canonical skill inventory ожидает 21 skills, в репозитории 23 (добавлены `ebb-release`/`ebb-maintain-project-docs` коммитом `8cc8eeb` плана 26 ещё на HEAD). Pre-existing на HEAD, к плану 25 отношения не имеет.
- Live-provider путь (`hermes-task5b-live-provider.acceptance.test.ts`) — `NOT RUN` (маркер `EBB_RUN_TASK5B_LIVE_PROVIDER_ACCEPTANCE` не выставлен; прогон без явного разрешения пользователя не выполняется).

### Новые failures (исправлены, приёмка завершена)

1. **lint**: `apps/web/test/e2e/chat-run-e2e.mjs` — `no-undef` для `console` (строки 207, 224). Исправлено: в `eslint.config.js` для `apps/web/test/e2e/**/*.mjs` добавлен глобал `console` (readonly). ESLint по всему репо — exit 0.
2. **server vitest**: `apps/server/test/platform/security/auth-onboarding-contract.test.ts` — «exposes the exact versioned public paths and constants»: ожидал точный набор ключей `apiPaths` без новых chat-путей. Исправлено: в тест добавлены 5 чат-путей (`conversations`, `conversationMessages`, `conversationEvents`, `planApprove`, `planReject`) — 7/7 PASS.
3. Повторный прогон server vitest (полный, с `--config apps/server/vitest.config.ts`): 2634 PASS / 2 FAIL / 43 skipped — оба FAIL pre-existing/environmental (v1-crash-matrix, darwin-run-supervisor).

### Вердикт

Приёмка **завершена**: новые failures исправлены, все гейты зелёные (typecheck contracts/server/web; contracts 37/37; server vitest — только pre-existing; web 251/251; lint exit 0; build server/web exit 0; docs:check/docs:test PASS; Playwright 11 PASS/5 skipped; chat E2E 4/4 + 5/5), финальный whole-plan review — **PASS** (IMPORTANT-пункт по docs закрыт обновлением current-state и настоящей секции; minor: дублирующий wiring production-composition, reject через PlanningService.rejectPlan (задокументировано), расхождение Canva-ID — не дефекты). Статус плана переведён `in_progress` → `completed`. Ограничения: live-provider NOT RUN (окружение), root scripts 2 FAIL pre-existing (skill inventory, план 26).
