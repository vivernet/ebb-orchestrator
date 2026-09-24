---
id: plan-12
kind: plan
roadmap: 01
stage: 08
status: completed
title: Web 401 и завершение проекта
created: 2026-09-23
updated: 2026-09-24
depends_on:
  - plan-08-01
specs:
  - ../specs/01-system-design.md
evidence: []
---

# Web 401 и завершение проекта — Implementation Plan

> **Для agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (рекомендуется) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Этот документ является планом реализации; сам по себе он ничего не реализует.

**Goal:** Устранить доказанный дефект restore-flow Web/401 и довести связанные серверные контракты, жизненный цикл, миграции, безопасность команд, фоновые задачи, редактирование ошибок и доказательства качества до состояния, проверяемого реальным HTTP/browser transport и полным набором quality gates.

**Architecture:** Сначала восстановить воспроизводимый baseline запуска и зафиксировать HTTP-контракт сессии, затем последовательно исправить transport/origin, startup cleanup, целостность миграций, typed command policy, переходы run, обработку jobs и redaction. Каждый этап начинается с RED-регрессии, содержит минимальную реализацию, focused verification и только после этого related/full gates. Security boundary сохраняется: session restore не обходится регистрацией нового заголовка, а разрешается явным контрактом маршрута и браузерным flow.

**Tech Stack:** Node.js, TypeScript, Fastify, React/Vite, pnpm, существующие server/web/contract тесты, реальный HTTP client/browser transport, SQLite/runtime schema, JSON-RPC MCP.

**Spec:** Фактологический audit artifact из переданных результатов аудита Web/401 и общего состояния проекта; отдельный design-spec не создаётся. Текущий план фиксирует решения, зависимости и проверяемые критерии реализации.

## Global Constraints

- Production-код не изменяется этим документом; реализация выполняется отдельными задачами после согласования плана.
- Не регистрировать заголовок как исправление 401: HTTP header names case-insensitive, а изменение `X-EBB-Bootstrap-Token` на lowercase не является доказанным исправлением.
- Сохранять security boundary bootstrap: одноразовый token привязан к запуску, сравнивается через `safeEquals`, обнуляется после успеха; missing/stale/reused/wrong-run token остаётся недействительным.
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
- Подтверждено, что bootstrap token одноразовый и run-bound: `create-app.ts:170-183`, `local-session.ts:38-43`; fragment удаляется frontend после получения.
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

- [ ] Написать RED test/проверку, которая импортирует или запускает launcher в безопасном child-process режиме и подтверждает отсутствие parse error.
- [ ] Выполнить `node --check scripts/run-server.js`; до исправления ожидается SyntaxError с указанием отсутствующей запятой.
- [ ] Выполнить минимальную правку только синтаксиса и добавить тест, если существующего launcher coverage нет.
- [ ] Проверить `node --check scripts/run-server.js` (ожидание: exit 0) и `pnpm start` в controlled runtime harness (ожидание: server reaches READY без немедленного parse failure).
- [ ] Запустить `pnpm lint` и сохранить результат как baseline для следующих задач; parse-error launcher больше не должен быть причиной падения.

**Зависит от:** нет. **Разблокирует:** все runtime tasks и E2E.

### Task 2: Зафиксировать безопасный session/401 contract сначала RED-тестами

**Files:**
- Modify: `apps/server/src/app/create-app.ts:132-183` — явно оформить выбранный контракт `/api/v1/session` и bootstrap boundary.
- Modify: `apps/web/src/main.tsx:17-29`, `apps/web/src/api/client.ts:132-143` — согласовать restore flow, status handling и UI state.
- Inspect/Modify: `apps/server/src/local-session.ts:38-43` — сохранить one-shot run-bound token.
- Test: server route/integration tests; web integration tests; новая transport E2E fixture.

**Решение:** рекомендуемый контракт — `GET /api/v1/session` остаётся auth-protected и при отсутствии валидной cookie возвращает предсказуемый `401` (не anonymous success и не обход preHandler); frontend трактует его как unauthenticated state и показывает контролируемый launch/bootstrap entrypoint. `/api/v1/session/bootstrap` остаётся единственным публичным bootstrap endpoint, принимает только token из URL fragment, устанавливает HttpOnly cookie и не превращается в общий bearer login. Это сохраняет границу безопасности и не требует регистрации нового заголовка.

**Interfaces:**
- `GET /api/v1/session`: `200` для валидной cookie; `401` для отсутствующей/невалидной cookie; не вызывает domain handler при preHandler rejection.
- `GET /api/v1/session/bootstrap`: успешный bootstrap устанавливает HttpOnly cookie с `Path=/api/v1`, invalid/missing/stale/reused/wrong-run token возвращает `401`, token после успеха недействителен.
- Frontend: hash `ebb-bootstrap` обрабатывается как bootstrap; без hash выполняется restore; `401` restore переводит UI в unauthenticated state с явным способом получить новый launch link, без бесконечного retry.

- [ ] Написать RED server tests для no-cookie `GET /api/v1/session` (`401` до handler), valid-cookie `200`, и сохранения bootstrap one-shot semantics.
- [ ] Написать RED web/transport tests для no-fragment/no-cookie (`GET /api/v1/session` → `401`, ожидаемое UI state), bootstrap success, invalid/reused/stale token (`401`), и cookie reload.
- [ ] Выполнить focused tests и зафиксировать ожидаемые RED failures до implementation.
- [ ] Реализовать минимальную contract-aligned обработку, не добавляя header registration и не ослабляя preHandler.
- [ ] Выполнить focused server/web tests; ожидание: все перечисленные cases PASS.

**Зависит от:** Task 1 для runtime harness; **разблокирует:** Task 3 и browser evidence.

### Task 3: Исправить hostname/origin/proxy и проверить browser transport

**Files:**
- Modify: `apps/server/src/app/create-app.ts:150-163, 251-288` — согласовать origin/CSRF validation с canonical development origin и фактически используемым proxy.
- Modify: `vite.config.ts:7-12` — сохранить/явно протестировать `changeOrigin=true` и target.
- Modify: `get-link.html:43` — генерировать canonical `127.0.0.1` URL, совместимый с server/start config, вместо `localhost:3000`.
- Test: real HTTP/browser E2E fixture; origin/CSRF tests.

**Root cause / impact:** backend origin `127.0.0.1`, Vite proxy `changeOrigin=true`, а generated link `localhost:3000` создают hostname/origin mismatch; mutation может получить `403`, хотя bootstrap GET доступен. Документированный CORS не подтверждён фактическим plugin/header.

**Interfaces:** canonical dev origin должен быть единственным значением в generated link/server config; cross-origin mutation без разрешённого origin получает `403`; proxied same-origin browser mutation получает ожидаемый success.

- [ ] Написать RED real transport cases: bootstrap through proxy, reload with `Set-Cookie`, mutation through canonical host, mutation with `Origin: http://localhost:3000`/неразрешённым host (`403`), and direct frontend/backend mismatch.
- [ ] Выполнить E2E до implementation; ожидаемый RED — mismatch/403 или отсутствующий cookie/proxy evidence.
- [ ] Реализовать минимальное согласование canonical hostname, generated link и origin policy; не добавлять широкое CORS allow-all.
- [ ] Повторить browser E2E: bootstrap fragment исчезает из URL, cookie survives reload, valid mutation succeeds, disallowed origin is `403`.

**Зависит от:** Task 1–2. **Разблокирует:** доказательную runtime проверку.

### Task 4: Централизовать startup lifecycle и cleanup

**Files:**
- Modify: `apps/server/src/main.ts:59-79, 182-188, 190-201, 211-246` — coordinator с фазами acquire/start/READY/failure/shutdown.
- Modify: `apps/server/src/system-lifecycle.ts:93-136` — идемпотентный cleanup lock/DB/resources.
- Modify: `docs/issues/01-server-exits-immediately.md` — отделить наблюдаемый SIGINT/SIGTERM от недоказанного источника сигнала.
- Test: startup coordinator tests, signal-before-READY and startup-error cleanup tests.

**Root cause / impact:** lock/DB/resources приобретаются до readiness; ошибки после acquire не гарантируют cleanup; pre-ready signals игнорируются из-за `serverReady` guard; JobWorker/JobRunner wiring также пока отсутствует.

**Interfaces:** `startServer()` должен либо вернуть READY с зарегистрированным shutdown handler, либо выполнить cleanup всех уже acquired resources и вернуть исходную ошибку; сигналы до READY должны инициировать cleanup и не оставлять lock; cleanup повторяемый.

- [ ] Написать RED tests для ошибок после каждой acquisition phase, signal до READY, signal после READY и двойного cleanup.
- [ ] Исправить coordinator/cleanup минимально, сохранив существующие resource ownership boundaries.
- [ ] Проверить focused lifecycle tests и controlled process run; ожидание: no orphan lock/DB handles, deterministic exit, READY only after all required resources.

**Зависит от:** Task 1. **Разблокирует:** jobs и full runtime evidence.

### Task 5: Сделать migration integrity единственным источником schema truth

**Files:**
- Modify: `migrator.ts:52-77` — проверять весь applied set по name/version/checksum, continuity/gaps и запрещать изменённую applied migration.
- Create/Modify: versioned migration files — перенести DDL из `run-service.ts:26-34` и `scheduler-service.ts:50-80` в append-only migrations.
- Modify: `run-service.ts`, `scheduler-service.ts` — убрать runtime schema create/alter и оставить работу с мигрированной схемой.
- Test: migrator integrity and schema bootstrap tests.

**Root cause / impact:** проверяется только `MAX(version)`; изменение applied migration, duplicate/name mismatch и gaps проходят молча. Runtime DDL разделяет source of truth и делает startup зависимым от скрытых schema mutations.

**Interfaces:** migrator принимает ordered migration set и applied metadata, возвращает success только при точном соответствии name/version/checksum и непрерывной истории; runtime services не выполняют `CREATE/ALTER`.

- [ ] Написать RED tests: changed checksum, skipped version, duplicate version/name, unknown applied migration, fresh DB, already-current DB, and migration containing former runtime DDL.
- [ ] Перенести DDL в новые append-only migration versions; существующие applied migration files не редактировать.
- [ ] Реализовать полную integrity validation с явным диагностическим сообщением и fail-fast до запуска workers.
- [ ] Удалить runtime DDL paths из services.
- [ ] Запустить focused migrator/schema tests, затем `pnpm typecheck`; ожидание: fresh and upgraded databases migrate once, tampered/gapped histories fail before service startup.

**Зависит от:** Task 4 для startup ordering. **Разблокирует:** reliable runtime and jobs.

### Task 6: Ввести typed command policy и containment checks

**Files:**
- Modify: `action-gateway.ts:102-113` — authorise typed command action, а не только capability.
- Modify: `command-tools.ts:45-63` — принимать typed policy input и enforce executable/args/path/timeout/output limits.
- Modify: `mcp/tool-registry.ts:173-196` — регистрировать только declared command schemas/policies.
- Test: command security unit/integration tests.

**Root cause / impact:** `command.exec` проверяет только capability; отсутствуют allowlisted executable, typed arguments, path containment, timeout и output policy, что создаёт command/path escape risk.

**Interfaces:** `CommandPolicy` должен явно содержать `id`, `executable`, аргументную схему, allowed root(s), timeout и stdout/stderr limits; executor принимает только validated policy invocation и возвращает bounded result либо typed rejection. Абсолютные пути вне allowed roots, shell metacharacters и неразрешённые executable запрещаются.

- [ ] Написать RED tests для unknown command, wrong arg type, executable substitution, `../` escape, symlink/absolute path escape, timeout, oversized output и missing capability.
- [ ] Реализовать registry/schema validation и containment check через canonical path comparison; не выполнять пользовательскую строку через shell.
- [ ] Проверить focused security suite и отрицательные cases; ожидание: каждый unsafe invocation отклонён до spawn.

**Зависит от:** Task 5 не обязателен для unit tests, но до production rollout требуется lifecycle baseline. **Разблокирует:** safe action execution.

### Task 7: Запретить незаконное reopen terminal runs

**Files:**
- Modify: `run-service.ts:214-233` — validate status, capability, attempt и result перед `resumeRun`.
- Test: run transition matrix tests.

**Root cause / impact:** `resumeRun` записывает `IN_PROGRESS` для любого status; terminal runs могут быть reopened без capability/attempt/result validation.

**Interfaces:** `resumeRun(runId, resumeInput)` разрешён только из перечисленных resumable states, с валидными capability/attempt/result; terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED` или фактические equivalent enum values) immutable, повторный resume возвращает typed conflict.

- [ ] Написать RED matrix: every current status × valid/invalid attempt, capability, result; отдельно terminal reopen и idempotent retry.
- [ ] Реализовать state-transition guard с атомарным conditional update, чтобы concurrent resume не создавал двойной transition.
- [ ] Запустить focused run-service suite; ожидание: illegal transitions rejected, legal transition persisted once, terminal record unchanged.

**Зависит от:** Task 5 для стабильной schema semantics. **Разблокирует:** jobs/retry correctness.

### Task 8: Выбрать и реализовать typed background-job registry + worker

**Files:**
- Modify: `main.ts:182-188,222-230` — запуск worker после READY и controlled shutdown.
- Modify: `job-worker.ts:11-71` — poll/claim/execute/ack/fail with bounded retry and shutdown.
- Create/Modify: `background_jobs` repository/handler registry modules — typed job names/payloads and handler registration.
- Test: worker/registry integration tests.

**Решение:** выбрать typed registry + worker, а не объявлять jobs out-of-scope: production уже запускает scheduler/outbox workers и имеет `background_jobs` queue, поэтому скрытое отсутствие JobWorker/JobRunner wiring создаёт ложное ощущение обработки. Registry должен быть allowlisted и typed; неизвестная job type не исполняется и переводится в диагностируемый failure state.

**Interfaces:** `JobHandler<TPayload>` получает validated payload и cancellation context; `JobRegistry.register<T>(name, schema, handler)` запрещает duplicate names; `JobWorker.claim()` атомарно резервирует job, `runOnce()` возвращает processed/failed/empty, shutdown прекращает claims и дожидается in-flight handlers.

- [ ] Написать RED integration tests: known typed job processed, malformed payload rejected, unknown type failed safely, retry/backoff bounded, concurrent claim once, shutdown before READY and during in-flight job.
- [ ] Реализовать registry validation, queue claim and handler wiring; не запускать worker до READY.
- [ ] Проверить worker suite и controlled process lifecycle; ожидание: queued jobs are actually processed, no duplicate claim, cleanup on failure.

**Зависит от:** Task 4–5 и Task 7. **Разблокирует:** project completion evidence.

### Task 9: Редактировать MCP ошибки и проверить disclosure boundary

**Files:**
- Modify: `mcp-server.ts:223-228` — map internal exceptions to stable public JSON-RPC error code/message; log correlation-safe diagnostics server-side without secrets.
- Test: MCP JSON-RPC error redaction tests.

**Root cause / impact:** raw `error.message` возвращается клиенту и может раскрывать paths, SQL, tokens или infrastructure details.

**Interfaces:** public error payload содержит stable code, safe Russian/English message per existing API convention и request correlation id; raw message никогда не сериализуется в JSON-RPC response.

- [ ] Написать RED tests с ошибками, содержащими абсолютный path, SQL, token-like value и nested cause; assert response excludes each secret and preserves code/id.
- [ ] Реализовать typed error mapper и bounded server-side logging.
- [ ] Запустить focused MCP suite; ожидание: protocol-valid redacted errors and unchanged success responses.

**Зависит от:** независим от Task 8, но входит в общий security rollout.

### Task 10: Обновить stale documentation и собрать доказательства

**Files:**
- Modify: `docs/issues/01-server-exits-immediately.md` — документировать только наблюдаемые signals и новый coordinator evidence.
- Modify: `docs/audit/07-project-state.md` — обновить revision/dirty-state только после implementation verification, не затирая историю аудита.
- Create: `docs/audit/08-web-401-and-project-completion-evidence.md` — команды, даты/ревизия, pass/fail и ограничения runtime evidence.

**Interfaces:** evidence document обязан различать static, unit, integration и real browser evidence; каждый claim ссылается на command/test и результат.

- [ ] Написать RED documentation check: stale HEAD/clean-tree assertions должны быть найдены и исправлены.
- [ ] Обновить docs после фактических тестов, включая explicit statement, если runtime trace stale token так и не получен.
- [ ] Проверить `git diff --check` и поиск запрещённых утверждений вроде «доказано stale token» без trace.

**Зависит от:** Tasks 1–9. **Разблокирует:** final gates.

### Task 11: Выполнить полный набор gates и зафиксировать rollout

**Files:**
- Test/evidence: все test locations из Tasks 1–10; `docs/audit/08-web-401-and-project-completion-evidence.md`.

- [ ] Выполнить focused suites по каждой изменённой области.
- [ ] Выполнить real HTTP/browser E2E: no-fragment/no-cookie 401 и UI state, valid bootstrap, invalid/reused/stale/wrong-run token 401, fragment removal, `Set-Cookie` reload, proxy hostname, allowed mutation и CSRF/origin 403.
- [ ] Выполнить `pnpm typecheck`; ожидаемый результат: exit 0.
- [ ] Выполнить `pnpm test`; ожидаемый результат: contracts 3/3, server suite без новых failures, web suite без новых failures, skipped cases перечислены.
- [ ] Выполнить `pnpm build`; ожидаемый результат: exit 0.
- [ ] Выполнить `pnpm lint`; ожидаемый результат: exit 0, включая `node --check scripts/run-server.js`.
- [ ] Выполнить controlled start/stop и migration integrity run; ожидание: READY, job processing, deterministic cleanup, no orphan lock.
- [ ] Сохранить exact command outputs и explicit limitations; не объявлять проект runtime-verified, если любой browser/startup gate не пройден.

**Зависит от:** Tasks 1–10. Этот task не создаёт commit.

## Трассировка требований

| Требование аудита/пользователя | Реализационный task | Обязательная проверка |
|---|---:|---|
| Launcher SyntaxError и lint blocker | 1 | `node --check`, `pnpm lint`, controlled `pnpm start` |
| Доказанный no-fragment restore 401 | 2 | no-cookie real HTTP + UI/browser E2E |
| One-shot/bootstrap invalid-reused token | 2 | valid, missing, stale, reused, wrong-run cases |
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
