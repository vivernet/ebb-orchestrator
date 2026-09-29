---
id: plan-12
kind: plan
status: completed
title: Web 401 и завершение проекта
created: 2026-09-23
updated: 2026-09-29
depends_on:
  - plan-08-01
specs:
  - ../specs/01-system-design.md
evidence:
  - apps/server/src/platform/process/startup-boundary.ts
  - apps/server/src/platform/security/local-user-wizard.ts
  - apps/server/test/platform/process/startup.test.ts
  - apps/server/test/platform/security/local-user-wizard.test.ts
  - docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md
---

# Web 401 и завершение проекта — Implementation Plan

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`. План выполняется по задачам; для отслеживания шагов используется синтаксис флажков (`- [ ]`). Этот документ является планом реализации; сам по себе он ничего не реализует.

**Goal:** Устранить доказанный дефект restore-flow Web/401 и довести связанные серверные контракты, жизненный цикл, миграции, безопасность команд, фоновые задачи, редактирование ошибок и доказательства качества до состояния, проверяемого реальным HTTP/browser transport и полным набором quality gates.

**Architecture:** Сначала восстановить воспроизводимый baseline запуска и зафиксировать HTTP-контракт сессии, затем последовательно исправить transport/origin, startup cleanup, целостность миграций, typed command policy, переходы run, обработку jobs и redaction. Каждый этап начинается с RED-регрессии, содержит минимальную реализацию, focused verification и только после этого related/full gates. Security boundary сохраняется: session restore не обходится регистрацией нового заголовка, а разрешается явным контрактом маршрута и браузерным flow.

**Tech Stack:** Node.js, TypeScript, Fastify, React/Vite, pnpm, существующие server/web/contract тесты, реальный HTTP client/browser transport, SQLite/runtime schema, JSON-RPC MCP.

**Spec:** Фактологический audit artifact из переданных результатов аудита Web/401 и общего состояния проекта; отдельный design-spec не создаётся. Текущий план фиксирует решения, зависимости и проверяемые критерии реализации.

## Global Constraints

- Production-код не изменяется этим документом; реализация выполняется отдельными задачами после согласования плана.
- Не регистрировать заголовок как исправление 401: HTTP header names case-insensitive, а изменение `X-EBB-Bootstrap-Token` на lowercase не является доказанным исправлением.
- Сохранять утверждённую local password/cookie session boundary: password вводится только на login UI/одноразовом stdin setup, session token хранится в HttpOnly cookie, Origin/CSRF защищают mutations; legacy bootstrap endpoint, bearer token и URL-fragment credential не восстанавливать.
- Комментарии и JSDoc, добавленные при реализации, писать на русском языке.
- Не принимать runtime trace stale token за доказательство первоначальной причины: доказана только причина 401 в restore-flow без launch fragment и без cookie.
- Не перезаписывать несвязанные dirty-файлы и не считать baseline чистым: HEAD `9a3dc7c`, ветка `develop`, tracked dirty `apps/server/src/main.ts`, `package.json`, untracked `docs/issues/`, `get-link.html`, `scripts/run-server.js`, `start.bat`.
- Не заявлять runtime-доказательства, пока запуск и browser transport фактически не пройдены.
- В ходе реализации каждый task заканчивается focused verification; commit, push и merge выполняются вне этого плана и не являются частью требуемой работы.

## Зафиксированное состояние и границы

### Revision, dirty state и уверенность

- Зафиксированная ревизия: `9a3dc7c`, ветка `develop`; upstream `origin/develop` отсутствует как доступная tracking-ветка.
- Рабочее дерево не чистое: изменены `apps/server/src/main.ts` и `package.json`; неотслеживаемы `docs/issues/`, `get-link.html`, `scripts/run-server.js`, `start.bat`. Реализация должна изолировать свои изменения и не затирать их.
- Высокая уверенность: статический маршрут preHandler, frontend restore вызов, bootstrap token lifecycle, launcher SyntaxError, origin/proxy mismatch, отсутствие фактического CORS plugin, несвязанные runtime DDL и перечисленные security/lifecycle дефекты подтверждены указанными исходными строками.
- Средняя уверенность до runtime E2E: фактическое поведение браузерного cookie/proxy/hostname transport, stale token при первоначальном пользовательском запуске и cleanup при конкретном сигнале требуют воспроизведения.
- Runtime launch verification не получен: первоначальный запуск сорван shell/job-control, а `scripts/run-server.js` имеет SyntaxError из-за отсутствующей запятой перед `detached`.

### Что доказано, а что не доказано

- Доказанная первопричина 401 restore-flow: `apps/server/src/app/create-app.ts:132-165` пропускает preHandler только для `/api/v1/health` и `/api/v1/session/bootstrap`; `GET /api/v1/session` на `185` защищён. При отсутствии launch fragment `apps/web/src/main.tsx:17-29` вызывает `restoreSession`, а `apps/web/src/api/client.ts:132-143` делает `GET /api/v1/session`; без cookie запрос получает 401 до handler.
- Не доказана конкретная первоначальная runtime-причина пользовательского 401: stale/reused/wrong-run bootstrap token только перечислены как корректные причины 401 для bootstrap, но runtime trace такого token не получен.
- Текущий auth contract подтверждён в system design §13.2 и production-коде: local session auth, Origin validation, CSRF, closed CORS. Browser login выдаёт HttpOnly cookie; legacy bootstrap/query routes и credential fragments проверяются на отсутствие.
- Подтверждено, что header case change в commit `9a3dc7c` не объясняет исправление: HTTP headers case-insensitive и Fastify нормализует их.

### Уже выполненные проверки и ограничения

- Прошли: `pnpm typecheck`; `pnpm test` (contracts 3/3, server 687 pass/2 skipped, web 148 pass); `pnpm build`.
- Не прошёл `pnpm lint` из-за parse failure launcher; `node --check` для `scripts/run-server.js` также не проходит.
- `packages/testing` использует `passWithNoTests` и не содержит тестов; это не считать доказательством transport behavior.
- Существующие web/security tests в основном mocks; Set-Cookie, Vite proxy, hostname, stale token и no-fragment flow не покрыты реальным browser transport.
- `docs/audit/07-project-state.md` устарел и не должен служить источником текущего HEAD/dirty-state.

## Краткая карта изменяемых поверхностей

| Область | Основные файлы реализации | Тестовые/доказательные файлы |
|---|---|---|
| Launcher и baseline | `scripts/run-server.js`, `package.json` | `scripts/*.test.*` или существующий launcher test location |
| Session contract | `apps/server/src/app/create-app.ts`, `apps/server/src/local-session.ts`, `apps/web/src/main.tsx`, `apps/web/src/api/client.ts` | server route tests, web integration, browser transport E2E |
| Origin/proxy | `vite.config.ts`, `get-link.html`, server origin/CSRF setup | HTTP/proxy/origin E2E |
| Lifecycle | `apps/server/src/main.ts`, `apps/server/src/system-lifecycle.ts` | startup failure/signal tests |
| Migrations | `migrator.ts`, `run-service.ts`, `scheduler-service.ts`, versioned migration directory | migrator integrity and schema tests |
| Command security | `action-gateway.ts`, `command-tools.ts`, `mcp/tool-registry.ts` | policy/path/timeout tests |
| Run transitions | `run-service.ts` | transition matrix tests |
| Jobs | `main.ts`, `job-worker.ts`, job registry/queue modules | worker/registry integration tests |
| Error redaction | `mcp-server.ts` | JSON-RPC error disclosure tests |
| Docs/evidence | `docs/issues/01-server-exits-immediately.md`, `docs/audit/07-project-state.md`, new evidence report | reproducible command transcript |

## Зависимый порядок реализации

### Task 1: Восстановить baseline launcher и воспроизводимый запуск

**Files:**
- Modify: `scripts/run-server.js:10-15` — добавить отсутствующую запятую перед `detached` и сохранить текущую семантику запуска.
- Inspect/Modify only if required by existing launcher contract: `package.json:26` (`pnpm start`).
- Test: существующий launcher test location; если теста нет, создать узкий `scripts/run-server.test.js` без изменения production API.

**Root cause / impact:** SyntaxError останавливает `pnpm start`, поэтому все runtime claims и E2E до исправления недостоверны; это независимый blocker.

**Interfaces:** `pnpm start` должен запускать тот же server entrypoint, что и до исправления, с корректными `detached` options; новые публичные env-параметры не вводить.

- [x] Launcher regression/contract coverage сохранён в `scripts/run-server.test.mjs`; полный `pnpm test` подтвердил suite (scripts 19/19).
- [x] `node --check scripts/run-server.js` и `pnpm lint` завершились с exit 0.
- [x] Исправленный launcher проверен статически; новые публичные env-параметры не добавлялись.
- [x] Controlled production entrypoint smoke `node scripts/local-user-stdin-smoke.mjs` запустил `apps/server/dist/main.js` до READY и штатно завершил процесс.
- [x] `pnpm lint` подтвердил, что launcher parse blocker устранён.

**Зависит от:** нет. **Разблокирует:** все runtime tasks и E2E.

### Task 2: Зафиксировать безопасный password/cookie session contract

**Files:**
- Modify: `apps/server/src/app/create-app.ts` — явно оформить защищённый контракт `/api/v1/session` и public local-password login.
- Modify: `apps/web/src/main.tsx:17-29`, `apps/web/src/api/client.ts:132-143` — согласовать restore flow, status handling и UI state.
- Inspect: `apps/server/src/platform/security/auth-service.ts`, local-session auth routes and cookies.
- Test: server route/integration tests; web integration tests; новая transport E2E fixture.

**Решение, подтверждённое пользователем 2026-09-29:** текущий v1 contract использует локальный password login и durable cookie session. `GET /api/v1/session` остаётся auth-protected и при отсутствии/недействительности cookie возвращает `401`; frontend показывает login state. Успешный login выдаёт HttpOnly/SameSite cookie и CSRF token для последующих mutations. Legacy `/api/v1/session/bootstrap`, bearer bootstrap token и URL fragment не являются частью текущего v1 и не должны восстанавливаться.

**Interfaces:**
- `POST /api/v1/session/login`: проверяет password и выдаёт HttpOnly/SameSite cookie; секрет не сохраняется в browser storage.
- `GET /api/v1/session`: `200` для активной cookie; `401` для отсутствующей, malformed, expired, revoked или неизвестной session; защищённый handler не выполняется до auth.
- Mutations требуют same-origin `Origin` и актуальный CSRF token; invalid Origin/CSRF возвращают `403`.
- Frontend: initial `401` переводит UI в unauthenticated login state; после login restore работает через cookie, без bearer/fragment bootstrap flow.

- [x] Server/UI tests проверяют initial no-cookie `401`, valid cookie `200`, login state и отсутствие legacy bootstrap routes/artifacts.
- [x] Real HTTP/browser tests проверяют login, HttpOnly/SameSite cookie, reload/restart restore, revoked/expired/malformed sessions, logout и отсутствие auth bypass.
- [x] Текущая реализация сохраняет preHandler boundary и не регистрирует bearer/bootstrap header; frontend не помещает credentials в local/session storage.
- [x] Focused server auth/transport suites прошли (12 tests), focused web auth/session-state suites — 13 tests; browser E2E 6/6 и full gate приведены в Task 11 evidence.
- [x] Одноразовый run-bound token acceptance исключён по решению пользователя 2026-09-29; security tests подтверждают отсутствие legacy endpoints/fragments.

**Зависит от:** Task 1 для runtime harness; **разблокирует:** Task 3 и browser evidence.

### Task 3: Проверить same-origin proxy transport и Origin/CSRF boundary

**Files:**
- Inspect/Modify: `apps/server/src/app/create-app.ts` — согласовать Origin/CSRF policy с loopback server и same-origin development proxy.
- Inspect: `vite.config.ts` — сохранить проксирование `/api` без широкого CORS allow-all.
- Test: real HTTP/browser E2E fixture; origin/CSRF tests.

**Root cause / impact:** API mutations зависят от согласованного same-origin proxy и точной проверки `Origin`/CSRF. Документированный CORS не должен подразумевать открытый cross-origin доступ.

**Interfaces:** browser traffic проходит через same-origin `/api` proxy; валидная session+CSRF mutation succeeds; untrusted Origin или неверный CSRF получает `403`; credentials не передаются в URL.

- [x] Real HTTP transport tests проверяют `Set-Cookie` flags, restore после restart, successful same-origin logout, hostile Origin `403`, invalid CSRF `403` и revoked/expired sessions.
- [x] Chromium E2E через динамический frontend `/api` proxy проверяет unauthenticated `401`, password login, browser cookie session, reload/restart и logout; UI URL/storage не содержит credentials.
- [x] `pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/transport-origin.test.ts test/platform/database/migrator.test.ts` прошёл (18 tests); browser E2E прошёл 6/6.
- [x] Архитектурная граница из system design §13.2 подтверждена: local auth, Origin validation, CSRF и closed CORS; legacy bootstrap fragment не используется.

**Зависит от:** Task 1–2. **Разблокирует:** доказательную runtime проверку.

### Task 4: Централизовать startup lifecycle и cleanup

**Files:**
- Modify: `apps/server/src/main.ts:59-79, 182-188, 190-201, 211-246` — coordinator с фазами acquire/start/READY/failure/shutdown.
- Modify: `apps/server/src/system-lifecycle.ts:93-136` — идемпотентный cleanup lock/DB/resources.
- Modify: `docs/issues/01-server-exits-immediately.md` — отделить наблюдаемый SIGINT/SIGTERM от недоказанного источника сигнала.
- Test: startup coordinator tests, signal-before-READY and startup-error cleanup tests.

**Root cause / impact:** lock/DB/resources приобретаются до readiness; ошибки после acquire не гарантируют cleanup; pre-ready signals игнорируются из-за `serverReady` guard; JobWorker/JobRunner wiring также пока отсутствует.

**Interfaces:** `startServer()` должен либо вернуть READY с зарегистрированным shutdown handler, либо выполнить cleanup всех уже acquired resources и вернуть исходную ошибку; сигналы до READY должны инициировать cleanup и не оставлять lock; cleanup повторяемый.

- [x] `test/platform/process/startup.test.ts` покрывает ошибки startup, сигнал до READY и после READY, прерывание worker startup и cleanup; assertions проверяют порядок фаз и освобождение ресурсов.
- [x] Координатор startup/shutdown и cleanup присутствуют в production `main.ts`; startup lifecycle и worker ownership проверены composition tests.
- [x] Focused lifecycle/composition suites прошли; disposable production-main smoke подтвердил READY, migrations, health и controlled shutdown без оставшегося lock/home.

**Зависит от:** Task 1. **Разблокирует:** jobs и full runtime evidence.

### Task 5: Сделать migration integrity единственным источником schema truth

**Files:**
- Modify: `migrator.ts:52-77` — проверять весь applied set по name/version/checksum, continuity/gaps и запрещать изменённую applied migration.
- Create/Modify: versioned migration files — перенести DDL из `run-service.ts:26-34` и `scheduler-service.ts:50-80` в append-only migrations.
- Modify: `run-service.ts`, `scheduler-service.ts` — убрать runtime schema create/alter и оставить работу с мигрированной схемой.
- Test: migrator integrity and schema bootstrap tests.

**Root cause / impact:** проверяется только `MAX(version)`; изменение applied migration, duplicate/name mismatch и gaps проходят молча. Runtime DDL разделяет source of truth и делает startup зависимым от скрытых schema mutations.

**Interfaces:** migrator принимает ordered migration set и applied metadata, возвращает success только при точном соответствии name/version/checksum и непрерывной истории; runtime services не выполняют `CREATE/ALTER`.

- [x] Написать RED tests: changed checksum, skipped applied version, duplicate version/name, unknown applied migration, fresh DB, already-current DB, and migration containing former runtime DDL.
- [x] Перенести DDL в новые append-only migration versions; существующие applied migration files не редактировать.
- [x] Реализовать полную integrity validation с явным диагностическим сообщением и fail-fast до запуска workers.
- [x] Удалить runtime DDL paths из services.
- [x] Запустить focused migrator/schema tests, затем `pnpm typecheck`; fresh/upgraded databases migrate once, tampered/gapped histories fail before service startup.

**Зависит от:** Task 4 для startup ordering. **Разблокирует:** reliable runtime and jobs.

### Task 6: Ввести typed command policy и containment checks

**Files:**
- Modify: `action-gateway.ts:102-113` — authorise typed command action, а не только capability.
- Modify: `command-tools.ts:45-63` — принимать typed policy input и enforce executable/args/path/timeout/output limits.
- Modify: `mcp/tool-registry.ts:173-196` — регистрировать только declared command schemas/policies.
- Test: command security unit/integration tests.

**Root cause / impact:** `command.exec` проверяет только capability; отсутствуют allowlisted executable, typed arguments, path containment, timeout и output policy, что создаёт command/path escape risk.

**Interfaces:** `CommandPolicy` должен явно содержать `id`, `executable`, аргументную схему, allowed root(s), timeout и stdout/stderr limits; executor принимает только validated policy invocation и возвращает bounded result либо typed rejection. Абсолютные пути вне allowed roots, shell metacharacters и неразрешённые executable запрещаются.

- [x] RED tests зафиксировали обход через произвольный executable без policy; после исправления добавлены проверки unknown command, wrong args, executable substitution, `../`/absolute/symlink escape, timeout, oversized output и missing capability.
- [x] Реализованы registry/schema validation и containment check по canonical path; пользовательская команда проходит как typed argv с `shell: false`.
- [x] Проверены focused security suites (69 tests), полный `pnpm test` (server 881 passed / 2 skipped; web 200; contracts 4; scripts 19), `pnpm lint`, `pnpm typecheck`, `pnpm build`; независимый security review — PASS без findings.

**Зависит от:** Task 5 не обязателен для unit tests, но до production rollout требуется lifecycle baseline. **Разблокирует:** safe action execution.

### Task 7: Запретить незаконное reopen terminal runs

**Files:**
- Modify: `run-service.ts:214-233` — validate status, capability, attempt и result перед `resumeRun`.
- Test: run transition matrix tests.

**Root cause / impact:** `resumeRun` записывает `IN_PROGRESS` для любого status; terminal runs могут быть reopened без capability/attempt/result validation.

**Interfaces:** `resumeRun(runId, resumeInput)` разрешён только из перечисленных resumable states, с валидными capability/attempt/result; terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED` или фактические equivalent enum values) immutable, повторный resume возвращает typed conflict.

- [x] RED/GREEN matrix покрывает разрешённые `STARTED`/`IN_PROGRESS`, `COMPLETING` с принятым result, terminal `COMPLETED`/`FAILED`/`CANCELLED`, invalid attempts, отсутствующую capability, empty session, конкурентный duplicate и idempotent retry.
- [x] Реализован atomic compare-and-set по status/capability/result/attempt; stale или terminal переход возвращает `RunTransitionConflictError` (`RUN_TRANSITION_CONFLICT`, HTTP 409), повтор того же session/attempt не вызывает runtime повторно.
- [x] `run-service.test.ts` прошёл (33 tests); `pnpm lint`, `pnpm typecheck`, elevated полный `pnpm test` (97 files, 886 passed / 2 skipped; scripts 19/19) и `pnpm build` прошли.

**Зависит от:** Task 5 для стабильной schema semantics. **Разблокирует:** jobs/retry correctness.

### Task 8: Выбрать и реализовать typed background-job registry + worker

**Files:**
- Modify: `main.ts:182-188,222-230` — запуск worker после READY и controlled shutdown.
- Modify: `job-worker.ts:11-71` — poll/claim/execute/ack/fail with bounded retry and shutdown.
- Create/Modify: `background_jobs` repository/handler registry modules — typed job names/payloads and handler registration.
- Test: worker/registry integration tests.

**Решение:** реализовать typed registry + worker для существующей `background_jobs` queue. Повторный поиск по `apps/server/src` подтвердил: production `enqueueJob` call sites и зарегистрированных job types пока нет. Поэтому не придумывать product-specific jobs; registry принимает только явно зарегистрированные schemas/handlers, а неизвестный type завершается диагностируемым failure.

**Interfaces:** `JobHandler<TPayload>` получает validated payload и cancellation context; `JobRegistry.register<T>(name, schema, handler)` запрещает duplicate names; `JobWorker.claim()` атомарно резервирует job, `runOnce()` возвращает processed/failed/empty, shutdown прекращает claims и дожидается in-flight handlers.

- [x] RED/GREEN integration tests покрывают typed payload success и rejection, malformed JSON, unknown type, bounded handler retry и expired-lease exhaustion, concurrent claim на двух DB connections, stale lease owner, shutdown до first poll и остановку in-flight handler.
- [x] Реализованы generic typed registry/schema validation и cancellation context; worker подключён в `main.ts`, первый claim отложен до следующего macrotask после возврата lifecycle worker-start, unknown/malformed jobs завершаются safely, expired leases учитываются в retry budget.
- [x] Focused job/lifecycle/composition/diagnostics suites прошли (88 tests); полный gate: 97 files, 896 passed / 2 skipped, scripts 19/19. После security finding raw ошибки handler/schema больше не сохраняются: используются фиксированные коды, а diagnostics нормализует исторические произвольные `last_error`. Независимый security re-review — PASS. Ограничение: production producer/конкретные job handlers пока отсутствуют; инфраструктура проверена зарегистрированными test handlers.

**Зависит от:** Task 4–5 и Task 7. **Разблокирует:** project completion evidence.

### Task 9: Редактировать MCP ошибки и проверить disclosure boundary

**Files:**
- Modify: `mcp-server.ts:223-228` — map internal exceptions to stable public JSON-RPC error code/message; log correlation-safe diagnostics server-side without secrets.
- Test: MCP JSON-RPC error redaction tests.

**Root cause / impact:** raw `error.message` возвращается клиенту и может раскрывать paths, SQL, tokens или infrastructure details.

**Interfaces:** public error payload содержит stable code, safe Russian/English message per existing API convention и request correlation id; raw message никогда не сериализуется в JSON-RPC response.

- [x] RED/GREEN regression проверяет абсолютный path, SQL, token-like value и nested cause: response сохраняет JSON-RPC code/request id и correlation id, секреты отсутствуют как в response, так и в diagnostics log.
- [x] Internal exceptions возвращают фиксированное сообщение и stable `internal_error`; server log содержит correlation id и только класс ошибки, без message/cause.
- [x] Focused MCP suite прошёл; независимый security review — PASS без findings. В совокупности focused Task 8/9 suites прошли 88 tests. Success-path assertions остаются в том же suite.

**Зависит от:** независим от Task 8, но входит в общий security rollout.

### Task 10: Обновить stale documentation и собрать доказательства

**Files:**
- Modify: `docs/issues/01-server-exits-immediately.md` — документировать только наблюдаемые signals и новый coordinator evidence.
- Modify: `docs/audit/07-project-state.md` — обновить revision/dirty-state только после implementation verification, не затирая историю аудита.
- Create: `docs/audit/08-web-401-and-project-completion-evidence.md` — команды, даты/ревизия, pass/fail и ограничения runtime evidence.

**Interfaces:** evidence document обязан различать static, unit, integration и real browser evidence; каждый claim ссылается на command/test и результат.

- [x] Сверен исторический audit snapshot: старый HEAD/clean-tree не перезаписывался; в evidence добавлен датированный current verification addendum с branch/HEAD/dirty-state и точными gate результатами.
- [x] Issue report отражает новый browser E2E и явно указывает, что отдельный `pnpm start` acceptance не запускался; stale-token cause не объявляется доказанным без runtime trace.
- [x] `pnpm docs:check`, `pnpm docs:test`, `git diff --check` прошли; поиск по evidence подтверждает явное разделение historical/current claims и ограничений.

**Зависит от:** Tasks 1–9. **Разблокирует:** final gates.

### Task 11: Выполнить полный набор gates и зафиксировать rollout

**Files:**
- Test/evidence: все test locations из Tasks 1–10; `docs/audit/08-web-401-and-project-completion-evidence.md`.

- [x] Выполнить focused suites по каждой изменённой области: jobs/diagnostics/lifecycle/MCP — 7 файлов, 88 тестов; server auth/transport — 2 файла, 12 тестов; web auth/routing — 2 файла, 13 тестов. Команды и результаты перечислены в `docs/audit/08-web-401-and-project-completion-evidence.md`.
- [x] Реальный HTTP/browser E2E: Chromium login/logout, unauthenticated restore 401, UI states, `Set-Cookie`, cookie session restart и teardown cleanup прошли; real HTTP suite проверяет cookie/CSRF/Origin/logout/restart. Старый bootstrap-token matrix не применим: текущий local auth contract основан на password/cookie sessions, а legacy endpoints/fragments намеренно отсутствуют; их отсутствие проверяют security/credential-handoff tests.
- [x] `pnpm typecheck`: exit 0.
- [x] Elevated `pnpm test`: 97 files, 896 passed / 2 skipped; scripts 19/19.
- [x] `pnpm build`: exit 0.
- [x] `pnpm lint`: exit 0, включает launcher checks.
- [x] Изолированный browser harness подтвердил `READY`, restart с той же DB и controlled shutdown; migrator integrity suite прошёл в полном test suite. `node scripts/local-user-stdin-smoke.mjs` запустил production `dist/main.js` с disposable home, подтвердил `READY`/health, migration/user creation и controlled IPC shutdown, проверил отсутствие raw password в файлах/logs/argv. Job execution покрыт typed test handlers; production producers отсутствуют.
- [x] Точные команды, результаты и ограничения сохранены в `docs/audit/08-web-401-and-project-completion-evidence.md`.
- [x] Auth acceptance сверён с локальной password/cookie session моделью из текущих HTTP/UI tests и legacy bootstrap path absence tests; неподдерживаемые one-shot token cases удалены из применимого gate без изменения auth scope.
- [x] Независимый whole-plan review: PASS, 2026-09-29; предыдущие findings устранены, новых блокирующих замечаний нет.

**Зависит от:** Tasks 1–10. Этот task не создаёт commit.

## Трассировка требований

| Требование аудита/пользователя | Реализационный task | Обязательная проверка |
|---|---:|---|
| Launcher SyntaxError и lint blocker | 1 | `node --check`, `pnpm lint`, controlled `pnpm start` |
| Доказанный no-fragment restore 401 | 2 | no-cookie real HTTP + UI/browser E2E |
| Password/cookie session security | 2–3 | password login and session restore; no-cookie/invalid-session 401; HttpOnly cookie; CSRF/Origin enforcement; logout and restart; absence of legacy bootstrap endpoints/fragments |
| Не исправлять 401 header registration | 2 | code review/assert no new header bypass; contract tests |
| Cookie Path/reload transport | 2–3 | `Set-Cookie`, reload, `/api/v1` request |
| Hostname/proxy/CSRF/origin | 3 | canonical and disallowed-origin mutation E2E |
| CORS docs mismatch | 3 | actual response header/origin tests and documented policy |
| Startup cleanup/signals | 4 | error-at-each-phase, pre-ready signal, idempotent cleanup |
| Migration integrity | 5 | checksum/name/gap/continuity/tamper matrix |
| Runtime DDL removal | 5 | service source test + fresh/upgrade migration run |
| Command security | 6 | typed policy, executable, path, timeout/output negative tests |
| Terminal run reopen | 7 | full transition matrix, concurrent resume transition guard and terminal immutability |
| Background jobs decision | 8 | registry/worker integration and shutdown tests |
| MCP raw error leak | 9 | token/path/SQL redaction assertions |
| Stale audit docs/evidence | 10 | revision/dirty-state and evidence review |
| All quality gates | 11 | typecheck/test/build/lint + runtime/browser commands |

## Риски и меры

| Риск | Последствие | Мера |
|---|---|---|
| Dirty `main.ts`/`package.json` не принадлежат этой работе | Потеря пользовательских изменений | Перед каждым patch проверять diff; изменять только согласованные hunks и не reset/checkout. |
| Нет runtime trace первоначального 401 | Неверная атрибуция stale token | В evidence явно разделять доказанный restore defect и неизвестную initial runtime cause. |
| Изменение cookie/origin contract ломает clients | Regression в launch flow | Сначала contract tests, затем browser E2E через proxy и direct HTTP. |
| Append-only migration не совпадёт с deployed DB | Startup failure | Проверять upgrade fixtures и выдавать actionable checksum/version diagnostics до worker start. |
| Command policy слишком широкая | RCE/path disclosure | Typed allowlist, canonical containment, no shell string execution, bounded resources. |
| Worker начнёт работать до READY | Partial processing/lock leaks | Запускать только после coordinator READY, shutdown drains in-flight. |
| Redaction скрывает полезную диагностику | Difficult support | Correlation id + bounded server-side structured log без secrets. |
| Existing mocks создают ложный PASS | Непроверенный browser behavior | Final gate требует real HTTP/browser transport и exact evidence transcript. |

## Порядок rollout

1. **Baseline:** Task 1, затем чистый launcher/lint signal.
2. **Auth contract:** Task 2; rollout с обратимо проверяемым `401` unauthenticated UI behavior.
3. **Transport:** Task 3; canonical host/proxy/origin прежде production browser verification.
4. **Lifecycle/schema:** Tasks 4–5; migration validation до запуска workers.
5. **Security/state:** Tasks 6–7; command policy и run transitions до включения новых handlers.
6. **Async/error surfaces:** Tasks 8–9; worker feature flag/controlled enablement, redacted errors by default.
7. **Evidence/final gates:** Tasks 10–11; only after all focused and full gates pass считать scope завершённым.

Каждая реализационная задача должна быть отдельным reviewable change set с RED → minimal implementation → focused verification → related/full gates. Этот файл не выполняет ни один из этих изменений, не изменяет production-код и не создаёт commit.
