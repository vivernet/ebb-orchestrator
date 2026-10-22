# Внедрение проверенных паттернов из lobehub/lobehub — Implementation Plan

**Goal:** внедрить в Ebb Orchestrator проверенные паттерны и контракты из открытого репозитория lobehub/lobehub (canary), усилия безопасность инструментов, durable recovery, контекст/наблюдаемость и контракты — без изменения утверждённой архитектуры и инвариантов.

**Architecture:** заимствование выполняется как перенос **паттернов и контрактов**, а не кода (стеки расходятся: у донора PostgreSQL/Drizzle/Hono/tRPC + `@lobechat/*` и React-хост; у Ebb — SQLite/better-sqlite3, Express-подобный backend, собственный порт `AgentRuntime`). Улучшения сгруппированы в четыре независимо оцениваемых слоя: (A) Security Foundation, (B) Runtime & Recovery Execution, (C) Context & Observability, (D) Transport / Contracts / New Tools. Каждый слой сохраняет существующие порты Ebb (`AgentRuntime`, `ActionGateway`, `PermissionEngine`, `ContextBuilder`/`ContextManifest`) и расширяет их изнутри.

**Authority:**
- `docs/architecture/specs/01-system-design.md` (утверждённая архитектура v1);
- `AGENTS.md`, `.hermes.md`, `apps/server/AGENTS.md`, `packages/contracts/AGENTS.md`;
- Аудит донора от 2026-10-22 (два read-only исследования lobehub/lobehub, ветка `canary`; локальный клон: `C:\Users\alex1\lobehub-research`).

**Global Constraints:**
- Не нарушать инварианты: детерминированность-first; modular monolith + Ports & Adapters; Git — источник истины для кода, SQLite — для оркестрационного состояния; все AI-запуски через порт `AgentRuntime`; действия агента через `ActionGateway`/`PermissionEngine` (fail-closed, unknown → deny); Scheduler без LLM; recovery до новой работы.
- `master` и remote read-only; работа только в worktree `develop`; никаких push/merge/force.
- Новые и изменённые production-комментарии и JSDoc — только на русском; технические идентификаторы не переводятся.
- Никаких копий кода донора «как есть»: переносятся интерфейсы, контракты и подходы, адаптированные под стек Ebb и русский JSDoc.
- Не менять существующий обощённый контракт (`packages/contracts`) без поиска всех consumers и обновления их тестов.

**Specialist Constraints (trigger-only):**
- Изменения схемы SQLite (C4 traces, при необходимости новые таблицы) — работать через `ebb-database-engineering` (версионированная миграция, append-only история).
- Любые изменения security-границ (A3/A4) — обязательный security-focused review и evidence.
- Если в ходе исполнения потребуется расширение интерфейса `AgentRuntime` (B2/B4) — проверить всех реализаторов (HermesRuntimeAdapter, тестовые fake) и обновить их тесты.

**Review Focus (наивысшие риски):**
- Расширение `PermissionEngine` matcher-логикой (A3) не должно ослабить most-restrictive-wins и unknown → deny.
- Новая сетевая capability (A4) не должна создать неконтролируемый канал выхода данных из оркестратора (SSRF, размер ответа).
- Рефакторинг `RunContextAssembler` в конвейер (C1) не должен изменить `prompt_hash`/`context_hash` (digest-семантика) и, как следствие, manifest и resume.
- Step/event-модель (B2) не должна сломать существующий durable resume по `session_id`.
- OTel (C5) — опциональный экспорт: локальный запуск без экспортёра должен работать без изменения поведения и без «тихого» падения.

---

## File / interface map

Группировка по ответственности (файлы, меняющиеся вместе).

### Security Foundation (Phase A)
| Файл | Тип | Ответственность |
|---|---|---|
| `apps/server/src/platform/security/path-scope.ts` | new | Нормализация/резолвинг аргументов-путей с ограничением scope; `ALWAYS_ALLOWED_PATHS`; API в стиле `pathScope.ts` донора (normalizePathForScope, resolvePathWithScope, isPathWithinScope, resolveArgsWithScope) поверх существующего `PathResolver`. |
| `apps/server/src/modules/permissions/intervention-checker.ts` | new | Матчеры аргументов (`exact/prefix/wildcard/regex`), политики `always/required/never`, «security blacklist побеждает всё», unknown → `required` (fail-closed). |
| `apps/server/src/modules/permissions/default-security-blacklist.ts` | new | Реестр regex-правил опасных действий (удаление данных, `/etc/passwd`, fork bomb, sudoers, firewall и т.п.), адаптированный к workspace-контексту. |
| `apps/server/src/platform/network/ssrf-safe-fetch.ts` | new | SSRF-безопасный fetch: блокировка private/meta-адресов, allow/deny-списки, env-overrides, `maxContentLength`-обрезка, классификация ошибок. |
| `apps/server/src/modules/execution/workspace-tools.ts` | modify | Проводить все входные пути через `resolveArgsWithScope`/`isPathWithinScope`. |
| `apps/server/src/modules/execution/action-gateway.ts` | modify | Прогон аргументов через `InterventionChecker` до исполнения; защита от inbound `cwd`. |
| `apps/server/src/modules/permissions/permission-types.ts`, `permission-engine.ts` | modify | Расширение `EvaluationInput` полем `args`; интеграция matchers/blacklist в оценку. |

### Runtime & Recovery Execution (Phase B)
| Файл | Тип | Ответственность |
|---|---|---|
| `apps/server/src/modules/runtime/provider-errors.ts` | new | Таксономия ошибок провайдера: `ErrorCategory`, `ErrorSeverity`, `ErrorAttribution`, стабильные numericId, `ErrorClassifier` (предикаты rate-limit/quota/context-window/auth/network). |
| `apps/server/src/modules/runtime/usage-counter.ts` | new | Унифицированный аккумулятор usage/cost (единый формат `ModelUsage`). |
| `apps/server/src/modules/runtime/run-step.ts` | new | Абстракция «шага» run (host-injected step): контракт `RunStepExecutor`, `RunStepContext`, стадии lock → persist → execute → events. |
| `apps/server/src/modules/runtime/agent-events.ts` | new | Контракт событий агента (`AgentEvent`-подмножество): `llm_start/llm_result/tool_pending/tool_result/done/interrupted/resumed`, `FinishReason`. |
| `apps/server/src/modules/runtime/hermes/external-cli-adapter.ts` | new | Интерфейс внешнего CLI-рантайма (по образцу adapter-слоя heterogeneous-agents): spawn, stream-нормализация, событийный протокол, обёртка ошибок. |
| `apps/server/src/modules/runtime/run-service.ts` | modify | Подключение step/event-абстракций к существующему запуску; маппинг `FinishReason` → `RunStatus`; интеграция `UsageCounter`; вызов tracing-хуков (C4). |
| `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts` | modify | Использование таксономии ошибок; типизация stream-чанков (D1); реализация `ExternalCliRuntimeAdapter`. |

### Context & Observability (Phase C)
| Файл | Тип | Ответственность |
|---|---|---|
| `apps/server/src/modules/runtime/context/context-processor.ts`, `context-pipeline.ts` | new | Каркас конвейера: `ContextProcessor`, `PipelineContext`, `BaseProcessor` (validate → doProcess → validate; ошибки с `cause` + `toJSON`). |
| `apps/server/src/modules/runtime/context/token-accounting.ts` | new | Учёт токенов по бакетам (`TokenSourceType`, per-message/per-tool breakdown, `driftMultiplier`). |
| `apps/server/src/modules/runtime/context/agent-config-snapshot.ts` | new | `AgentConfigSnapshot`: «намеренно plain data» — весь читаемый контекст собирается один раз, правила становятся чистыми функциями. |
| `apps/server/src/modules/runtime/run-context-assembler.ts`, `context-budget.ts` | modify | Рефакторинг в конвейер процессоров; интеграция tokenAccounting. |
| `apps/server/src/modules/runtime/tracing/tracing-payload.ts`, `tracing-store.ts` | new | `TracingPayload` (prompt_hash/prompt_version/scenario), `computePromptHash`, реестр сценариев, интерфейс хранилища. |
| `apps/server/src/modules/runtime/tracing/migrations/*` | new | Миграция SQLite для trace-записей (сводная строка + полный payload в blob) — через `ebb-database-engineering`. |
| `apps/server/src/platform/observability/otel.ts` | new | Инициализация OTel OTLP HTTP; `gen_ai` semconv; middleware-трейсинг; гистограммы. |

### Transport / Contracts / New Tools (Phase D)
| Файл | Тип | Ответственность |
|---|---|---|
| `apps/server/src/modules/runtime/hermes/stream-chunk-types.ts` | new | Дискриминирующие юнионы чанков stream-json; ошибки chunk/parse/abort; Last-Event-ID конвенции. |
| `apps/server/src/modules/runtime/hermes/hermes-stream-session-observer.ts` | modify | Применение типизации чанков. |
| `packages/contracts/src/models.ts` | new | Схемы моделей/провайдеров (`AiModelType`, `ModelAbilities`) + zod-валидация (по образцу model-bank). |
| `packages/contracts/src/tracing.ts` | new | Контракты tracing-событий (если пересекают API/process boundary). |
| `apps/server/src/modules/execution/mcp/tool-registry.ts` | modify | Регистрация новых инструментов (network.fetch — только с явной capability), проверка args-scope. |
| `apps/server/src/modules/runtime/context/context-engine-adapter.ts` | new (опц.) | Адаптер между конвейером и существующим `RunContextAssembler` (если потребуется изоляция digest-логики). |

---

## Design decisions (зафиксированные решения)

1. **Переносим паттерны, не код.** Единственный разрешённый «перенос кода» — компактные самодостаточные модули (path-scope, intervention-checker, ssrf-safe-fetch, provider-errors, stream-chunk-types), портированные с переписыванием JSDoc на русский и без зависимостей `@lobechat/*`.
2. **Не переносим:** frontend/UI; `canvas-runtime`, `replica`, `edge-config`, `trpc` (React/Zustand/Vercel-специфика); крипто-протокол `secret-channel` целиком — берём только идею redaction-плейсхолдеров (P2); полный мультимодальный спектр `model-runtime` — берём только подкласс методов (chat/usage/stream) и таксономию ошибок; бизнес-логику чатов/плагинов/knowledge-base.
3. **`pathScope` vs существующий `PathResolver`:** `PathResolver` уже обеспечивает symlink/junction-safe containment. Новый `path-scope` добавляет недостающее: нормализация и подстановка scope в аргументы инструментов (`resolveArgsWithScope`), разрешённые вне-workspace пути (`/tmp`), и единый вход для всех инструментов (включая будущие сетевые/файловые).
4. **Инвариант «модель не задаёт cwd»** — уже реализован принципиально в `CommandPolicy` («executable, cwd и лимиты агент не задаёт»). В плане это закрепляется регрессионными тестами, а не новой механикой.
5. **`network.fetch`** вводится как capability-инструмент за `PermissionEngine`; до появления явного решения по whitelist доменов и UX подтверждений инструмент остаётся внутренним сервисом (используется только внутренним кодом), не выдаётся агентам.
6. **Step-модель (B2)** вводится как *наблюдаемый* слой над существующим запуском Hermes (не переписывает запуск): на первом этапе фиксирует прогресс и события; переход к полноценному «персист шага» — отдельная фаза после стабилизации контракта событий.
7. **OTel (C5)** — опционально, включается только при наличии `OTEL_EXPORTER_OTLP_ENDPOINT`; без него код работает в no-op режиме.

---

## Tasks

### Phase A — Security Foundation

#### Task A1. Модуль `path-scope`: нормализация и ограничение аргументов-путей
- **Depends on:** —
- **Create:** `apps/server/src/platform/security/path-scope.ts`; `apps/server/test/platform/security/path-scope.test.ts`.
- **Modify:** `apps/server/src/modules/execution/workspace-tools.ts` (readFile/writeFile/listDir/exists → `resolveArgsWithScope`), `apps/server/src/modules/execution/action-gateway.ts` (patch → scope).
- **Interfaces:**
  - `normalizePathForScope(value: string): string`
  - `resolvePathWithScope(workspace: string, arg: string, baseCwd?: string): { ok: true; path: string } | { ok: false; error: string }`
  - `isPathWithinScope(workspace: string, target: string): boolean` (с `ALWAYS_ALLOWED_PATHS = ['/tmp']`)
  - `resolveArgsWithScope(workspace: string, args: Record<string, unknown>, pathFields: readonly string[]): { ok: true; args: Record<string, unknown> } | { ok: false; error: string }`
  - Семантика ошибок: `PATH_OUTSIDE_SCOPE`, `PATH_UNRESOLVABLE`.
- **RED:** тест `path-scope.test.ts`: вызов `resolveArgsWithScope` с `../../etc/passwd` и Windows-стилем `C:\...` должен вернуть `{ ok: false }` до изменения production-кода (новый модуль отсутствует → compile/test failure).
- **GREEN:** реализация поверх `PathResolver`; `pnpm --filter @ebb-orchestrator/server test -- path-scope` — PASS; интеграция в `workspace-tools.ts` сохраняет существующие тесты workspace-tools.
- **Gates:** `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm lint`.
- **Review Focus:** Windows-пути (drive letters, обратные слеши), symlink-обход, `/tmp`-разрешённое исключение, отсутствие регрессий в `PathResolver`.

#### Task A2. Регрессионная защита инварианта «модель не задаёт cwd»
- **Depends on:** —
- **Create:** `apps/server/test/modules/execution/command-policy-cwd.test.ts`; расширение `action-gateway.test.ts`.
- **Modify:** `apps/server/src/modules/execution/action-gateway.ts` (защита от inbound `cwd` во всех public-методах, включая новые), `command-policy.ts` (при необходимости — явное игнорирование inbound `cwd`).
- **Interfaces:** контракт `CommandInvocation = { policyId; args }` остаётся без поля `cwd`; любой попавший `cwd` отклоняется (`CWD_NOT_ALLOWED`).
- **RED:** тест подаёт `{ policyId, args, cwd }` и ожидает отклонения; до правок поведение не определено (fail).
- **GREEN:** тест PASS; существующие тесты `command-policy` и `action-gateway` зелёные.
- **Gates:** typecheck; `pnpm lint`; `pnpm --filter @ebb-orchestrator/server test`.
- **Review Focus:** все пути вызова `exec`/`patch`/новых инструментов; отсутствие обходов через аргументы команд.

#### Task A3. `InterventionChecker` + security blacklist в Permission Engine
- **Depends on:** A1 (порядок оценки аргументов).
- **Create:** `apps/server/src/modules/permissions/intervention-checker.ts`; `apps/server/src/modules/permissions/default-security-blacklist.ts`; `apps/server/test/modules/permissions/intervention-checker.test.ts`.
- **Modify:** `permission-types.ts` (расширение `EvaluationInput` полем `args`; тип `InterventionMatcher`), `permission-engine.ts` (интеграция check'а), `action-gateway.ts`/`tool-registry.ts` (прогон args через `evaluate`).
- **Interfaces:**
  - `InterventionMatcherType = 'exact' | 'prefix' | 'wildcard' | 'regex'`
  - `InterventionRule { action: ActionId; matcher: InterventionMatcher; pattern: string; decision: PADecision }`
  - `HumanInterventionPolicy = 'always' | 'required' | 'never'`
  - `evaluate(input: EvaluationInput): EvaluationResult` — при `args` дополнительно возвращает `intervention` для ASK/required.
  - Правило: `defaultSecurityBlacklist` побеждает всё (включая auto-run); неизвестные правила → `required` (ASK).
- **RED:** тест: аргумент `rm -rf ~` для команды должен вернуть `DENY`/`ASK` (до реализации — PASS без проверки args, тест падает).
- **GREEN:** реализация + интеграция; тесты PASS; существующие тесты Permission Engine (most-restrictive-wins, unknown → deny) остаются зелёными.
- **Gates:** typecheck; lint; test; security-ревью (specialist).
- **Review Focus:** не ослабить `ABSOLUTE_DENY`; порядок композиции blacklist vs policy; матчеры не должны допускать ReDoS (ограничение длины pattern/входа).

#### Task A4. `ssrf-safe-fetch`: безопасный сетевой fetch
- **Depends on:** —
- **Create:** `apps/server/src/platform/network/ssrf-safe-fetch.ts`; `apps/server/test/platform/network/ssrf-safe-fetch.test.ts`.
- **Modify:** `permission-types.ts` (новый `ActionId.NetworkFetch = 'network.fetch'`), `tool-registry.ts` (регистрация инструмента только при наличии capability; по умолчанию внутренний сервис).
- **Interfaces:**
  - `ssrfSafeFetch(url: string, options: SSRFOptions): Promise<Response>` — блокировка private/meta-IP; `allowIPAddressList`, `allowPrivateIPAddress`, `maxContentLength`; env `SSRF_ALLOW_PRIVATE_IP_ADDRESS`, `SSRF_ALLOW_IP_ADDRESS_LIST`; ошибка `SSRF blocked: ...` с `cause`.
  - `netZoneForUrl(url: string): 'public' | 'private' | 'loopback' | 'link-local' | 'reserved'`.
- **RED:** тест: fetch на `http://127.0.0.1/` и `http://169.254.169.254/` должен блокироваться; до реализации модуль отсутствует (fail).
- **GREEN:** реализация (адаптация под Node `fetch`/undici, а не node-fetch); тесты PASS (включая редиректы http→https и `maxContentLength`).
- **Gates:** typecheck; lint; test; security-ревью.
- **Review Focus:** SSRF-обходы (redirect, DNS-rebind, IPv6-mapped), ограничение размера ответа (memory blowup), явные списки allow/deny.

### Phase B — Runtime & Recovery Execution

#### Task B1. Таксономия ошибок провайдера
- **Depends on:** —
- **Create:** `apps/server/src/modules/runtime/provider-errors.ts`; `apps/server/test/modules/runtime/provider-errors.test.ts`.
- **Modify:** `hermes-runtime-adapter.ts` (использование классификатора в `classifyHermesStderr`/`HermesStartupStderrClassifier`), `run-service.ts` (обогащение `RunOutcome.diagnostics`).
- **Interfaces:**
  - `ErrorCategory = 'auth' | 'quota' | 'capacity' | 'request' | 'safety' | 'network' | 'stream' | 'provider' | 'config'`
  - `ErrorAttribution = 'user' | 'provider' | 'harness' | 'system'`
  - `ErrorClassifier.isRateLimitExceeded / isExceededContextWindow / isInsufficientQuota / isAccountDeactivated`
  - Стабильные `numericId` (формат `E1xxx..E9xxx`, append-only).
- **RED:** тест классификации stderr-строк (401 → auth, 429 → rate-limit, connection refused → network) падает до реализации.
- **GREEN:** реализация; тесты PASS; существующие тесты `hermes-startup-stderr` и `run-service` зелёные.
- **Gates:** typecheck; lint; test.
- **Review Focus:** неизменность существующего `stderrCategory`-контракта; точность классификации без хранения текста ошибок.

#### Task B2. Step/event-модель наблюдаемого запуска (durable step)
- **Depends on:** B1 (ошибки), A3 (безопасность событий).
- **Create:** `run-step.ts`, `agent-events.ts`; `apps/server/test/modules/runtime/agent-events.test.ts`; `apps/server/test/modules/runtime/run-step.test.ts`.
- **Modify:** `run-service.ts` (эмиссия событий из существующего потока запуска; `FinishReason` → `RunStatus` маппинг), `hermes-runtime-adapter.ts` (прокидывание событий из stream-json).
- **Interfaces:**
  - `RunStep { id; kind; startedAt; finishedAt?; status; context }`
  - `AgentEvent = { type: 'llm_start' | 'llm_result' | 'tool_pending' | 'tool_result' | 'done' | 'interrupted' | 'resumed'; ... }`
  - `FinishReason = 'completed' | 'user_requested' | 'max_steps_exceeded' | 'cost_limit_exceeded' | 'error_recovery' | 'interrupted'`
  - Маппинг: `completed → COMPLETED`, `error_recovery → RECOVERING/FAILED` (согласовать с существующими статусами Run), `interrupted → INTERRUPTED` (если статус существует, иначе CANCELLED).
- **RED:** тест: `runAgentLoop`-подобный цикл на фикстуре завершается с `done/FinishReason.completed` и эмитит `llm_start → tool_pending → tool_result → done`; до реализации события отсутствуют (fail).
- **GREEN:** реализация наблюдаемого слоя; тесты PASS; существующий e2e-тест resume по `session_id` остаётся зелёным (критично).
- **Gates:** typecheck; lint; test; соответствующие e2e (`epic-restart-production`, `hermes-session-handoff`).
- **Review Focus:** совместимость с текущим `resumeRun` (session binding); отсутствие изменения порядка/семантики существующих статусов; идемпотентность событий.

#### Task B3. Унифицированный `UsageCounter`
- **Depends on:** B1.
- **Create:** `usage-counter.ts`; `apps/server/test/modules/runtime/usage-counter.test.ts`.
- **Modify:** `hermes-runtime-adapter.ts`, `run-service.ts` (использование единого счётчика вместо дублирующего `parseUsage`/`sessionObserver.usage`).
- **Interfaces:** `ModelUsage { inputTokens; cachedInputTokens; outputTokens; cost: number | null }`; `UsageCounter.merge(...)/snapshot()`.
- **RED:** тест слияния нескольких источников usage (включая `cost: null`) падает до реализации.
- **GREEN:** реализация; тесты PASS; существующие тесты `collectUsage` зелёные.
- **Gates:** typecheck; lint; test.
- **Review Focus:** правило «NULL cost не подменяется оценкой» сохранено.

#### Task B4. Интерфейс `ExternalCliRuntimeAdapter` (подготовка к мульти-runtime)
- **Depends on:** B1, B2 (события).
- **Create:** `external-cli-adapter.ts`; `apps/server/test/modules/runtime/external-cli-adapter.test.ts` (на fake-runtime).
- **Modify:** `hermes-runtime-adapter.ts` (реализация интерфейса; поведение не меняется).
- **Interfaces:**
  - `ExternalCliRuntimeAdapter { startRun; resumeRun; cancelRun; inspectRun; collectResult; collectUsage; healthCheck; prepareHermesRunSelection }` — общий контракт для внешних CLI (референс: adapter-слой heterogeneous-agents).
- **RED:** тест: `HermesRuntimeAdapter` удовлетворяет типу `ExternalCliRuntimeAdapter` (compile-time) — падает до правок.
- **GREEN:** выделение интерфейса и реализация; typecheck/test PASS; поведенческие тесты Hermes adapter зелёные.
- **Gates:** typecheck; lint; test.
- **Review Focus:** отсутствие изменения поведения; чистота интерфейса (без Hermes-специфики в сигнатурах).

### Phase C — Context & Observability

#### Task C1. Конвейер контекста (рефакторинг `RunContextAssembler`)
- **Depends on:** A1 (безопасность путей в контексте), B3 (usage для бюджета).
- **Create:** `context/context-processor.ts`, `context/context-pipeline.ts`; `apps/server/test/modules/runtime/context/context-pipeline.test.ts`.
- **Modify:** `run-context-assembler.ts` (декомпозиция на процессоры), `context-budget.ts` (интеграция workflow).
- **Interfaces:**
  - `ContextProcessor { name; process(context): Promise<PipelineContext> }`
  - `PipelineContext { readonly initialState; messages; metadata; isAborted; abortReason }`
  - `BaseProcessor` — validate → doProcess → validate; ошибки с `cause` + `toJSON()`.
  - **Ключевой инвариант:** финальные `prompt_hash`/`context_hash` (digest) идентичны текущим для тех же входов.
- **RED:** golden-тест: для фиксированного набора входов digest совпадает с текущим эталоном; после рефакторинга без сохранения семантики — fail.
- **GREEN:** рефакторинг с сохранением digest-семантики; golden-тест PASS; существующие тесты context/`ContextManifest` зелёные.
- **Gates:** typecheck; lint; test; e2e manifest (`context-manifest-production.acceptance`).
- **Review Focus:** не изменить семантику digest; идентичность результата для тех же входов; обработка abort.

#### Task C2. Учёт токенов по бакетам (`tokenAccounting`)
- **Depends on:** C1.
- **Create:** `context/token-accounting.ts`; `apps/server/test/modules/runtime/context/token-accounting.test.ts`.
- **Modify:** `context-budget.ts` (использование бакетов и `driftMultiplier` для триггеров компрессии).
- **Interfaces:** `TokenSourceType = 'content' | 'fileContext' | 'toolCalls' | 'thoughtSignature' | 'reasoning' | 'toolDefinition'`; `InputTokenBuckets`, `MessageTokenBreakdown`, `countContextTokens`, `addTokenBuckets`.
- **RED:** тест: сумма бакетов совпадает с подсчётом по токенизатору; триггер компрессии срабатывает при `driftMultiplier` — падает до реализации.
- **GREEN:** реализация; тесты PASS; существующие тесты budget зелёные.
- **Gates:** typecheck; lint; test.
- **Review Focus:** точность учёта (exact tokenizer result, без byte-estimate); совместимость с `initial token size = NULL`-правилом.

#### Task C3. `AgentConfigSnapshot` — сбор контекста один раз
- **Depends on:** C1.
- **Create:** `context/agent-config-snapshot.ts`; `apps/server/test/modules/runtime/context/agent-config-snapshot.test.ts`.
- **Modify:** `run-context-assembler.ts` (использование snapshot как входа для правил).
- **Interfaces:** `AgentConfigSnapshot` — plain-data (права, группа, modelOverride, isDev, workspaceId, policy); правила — чистые функции от snapshot.
- **RED:** тест: правила используют только snapshot (не тянут БД/Zustand); до рефакторинга fail.
- **GREEN:** реализация; тесты PASS; существующие тесты assembler зелёные.
- **Gates:** typecheck; lint; test.
- **Review Focus:** неизменность входного контекста; отсутствие побочных эффектов в правилах.

#### Task C4. LLM-generation tracing (payload + store)
- **Depends on:** B3 (usage), C1 (digest).
- **Create:** `tracing/tracing-payload.ts`, `tracing/tracing-store.ts`; миграция `run_traces` (через `ebb-database-engineering`); `apps/server/test/modules/runtime/tracing/tracing-store.test.ts`.
- **Modify:** `run-service.ts` (запись trace при завершении Run), `packages/contracts/src/tracing.ts` (если пересекает API-границу).
- **Interfaces:**
  - `TracingPayload { tracing_id; scenario; prompt_version; prompt_hash; input; output; model_metadata; validation_failed; error; created_at; version: '1.0' }`
  - `computePromptHash(systemPrompt, schema): string` (sha256, 6 hex)
  - `ITracingStore { save; get?; list? }` — SQLite-реализация (сводная строка + blob).
- **RED:** миграция применяется на свежей БД; тест сохранения/чтения trace падает до реализации.
- **GREEN:** миграция + реализация; тесты PASS; существующие миграционные тесты зелёные.
- **Gates:** database-engineering gates; typecheck; lint; test; fresh-install migration acceptance.
- **Review Focus:** append-only/forward-only миграция; отсутствие секретов в payload; стабильность `prompt_hash`.

#### Task C5. OTel-наблюдаемость (gen_ai semconv + middleware)
- **Depends on:** C4 (данные для трейсов).
- **Create:** `platform/observability/otel.ts`; `apps/server/test/platform/observability/otel.test.ts` (no-op без endpoint); `apps/server/src/modules/observability/` (если потребуется расширение).
- **Modify:** `create-app.ts` (подключение middleware), `run-service.ts` (эмиссия спанов запусков).
- **Interfaces:** `registerOtel(options): Promise<ShutdownFn>` (OTLP HTTP trace+metrics); `ATTR_GEN_AI_*` (модель, токены, finish reasons); селекторы включения через env (`OTEL_EXPORTER_OTLP_ENDPOINT`).
- **RED:** тест: без endpoint инициализация не падает и не меняет поведение (no-op); с mocked endpoint — экспорт спанов. До реализации fail.
- **GREEN:** реализация; тесты PASS; локальный запуск без env зелёный.
- **Gates:** typecheck; lint; test; e2e smoke.
- **Review Focus:** отсутствие влияния на бизнес-результат при сбое экспортёра; не блокировать старт сервера.

### Phase D — Transport / Contracts / New Tools

#### Task D1. Типизация SSE-чанков stream-json
- **Depends on:** B2 (события).
- **Create:** `hermes/stream-chunk-types.ts`; `apps/server/test/modules/runtime/hermes/stream-chunk-types.test.ts`.
- **Modify:** `hermes-stream-session-observer.ts` (применение юнионов; ошибки chunk/parse/abort).
- **Interfaces:** `StreamChunk = MessageTextChunk | MessageToolCallsChunk | MessageReasoningChunk | MessageUsageChunk | StopChunk`; `StreamChunkError`; `finishedType = 'done' | 'abort' | 'error'`.
- **RED:** тест парсинга фикстуры stream-json (usage/tool_calls/stop) падает до реализации.
- **GREEN:** реализация; тесты PASS; существующие тесты session-observer зелёные.
- **Gates:** typecheck; lint; test.
- **Review Focus:** обратная совместимость с существующим разбором; корректная обработка abort.

#### Task D2. Контракты: zod-валидация на trust boundaries
- **Depends on:** —
- **Create:** `packages/contracts/src/models.ts` (схемы моделей) + тесты; `packages/contracts/src/validation.ts` (общие zod-хелперы).
- **Modify:** статьи, где внешние payload валидируются (например, `output-validator.ts` при необходимости).
- **Interfaces:** `AiModelType`/`ModelAbilities` zod-схемы (референс model-bank); контракт: «схемы валидируют входящие данные на trust boundaries».
- **RED:** тест валидации внешнего payload (например, ответа провайдера) с невалидной схемой падает до реализации.
- **GREEN:** реализация; тесты PASS; `pnpm --filter @ebb-orchestrator/contracts typecheck && test`.
- **Gates:** contracts gates; lint.
- **Review Focus:** не протекать в implementation details; минимальность контрактов.

#### Task D3. OpenAPI-генерация из живых маршрутов + CI-паритет
- **Depends on:** D2 (валидация).
- **Create:** `apps/server/src/api/openapi.ts` (сборка спека из роутера); `scripts/generate-openapi.mjs` (generate/--check); коммиченный `openapi.yml`.
- **Modify:** `create-app.ts` (регистрация `GET /openapi.json`), `package.json` (скрипты).
- **Interfaces:** `GET /openapi.json`; `pnpm generate:openapi --check` — падает, если маршрут отсутствует/лишний в спеке.
- **RED:** `--check` на текущем коде не проходит (спека нет) — ожидаемое падение.
- **GREEN:** генерация спека; `--check` PASS; существующие API-тесты зелёные.
- **Gates:** typecheck; lint; test; diff --check.
- **Review Focus:** исключение внутренних эндпоинтов; стабильность спека (versioned artifact).

#### Task D4. Капабилити `network.fetch` как инструмент (после A4)
- **Depends on:** A4, D2.
- **Modify:** `tool-registry.ts` (регистрация `network.fetch` только при capabilities), `permission-types.ts` (ActionId уже добавлен в A4), тесты e2e MCP.
- **Interfaces:** MCP-инструмент `network.fetch { url; method?; headers?; body?; maxContentLength? }` — результат проходит `ssrfSafeFetch`.
- **RED:** e2e-тест: вызов `network.fetch` без capability → `DENY`; с capability на локальный адрес → `SSRF blocked`.
- **GREEN:** реализация; тесты PASS.
- **Gates:** typecheck; lint; test; security-ревью.
- **Review Focus:** выход за пределы whitelist; размер ответа; заголовки (запрет передачи секретов).

#### Task E1..E4 (P2, опциональные улучшения)
- **E1. Транзакционные патчи `partiallyApplied`:** расширить `workspace.patch` контрактом частичного применения (по образцу `ModifyOperationResult`), с явным статусом `partiallyApplied`; тесты. (Depends: A1.)
- **E2. Redaction-плейсхолдеры:** защитить секреты в логах/диагностике: модуль `platform/security/redact.ts` + применение в диагностических путях; тесты. (Depends: —)
- **E3. Нормализация внешних данных (connector-data-подход):** zod-валидация + нормализация внешних ответов в markdown с лимитами; используется будущими web-инструментами. (Depends: D4.)
- **E4. Типизированная валидация конфига:** zod-схемы для env-конфигурации при старте (fail-fast). (Depends: —)

---

## Команды проверки (общие gates)

```bash
pnpm lint
pnpm typecheck
pnpm --filter @ebb-orchestrator/server test
pnpm --filter @ebb-orchestrator/contracts typecheck
pnpm --filter @ebb-orchestrator/contracts test
git diff --check
```

Специализированные gates (вызываются по trigger задач): e2e (`epic-restart-production`, `hermes-session-handoff`, `context-manifest-production.acceptance`, `fresh-install-migrations.acceptance`), security-ревью для A3/A4/D4, database-engineering для C4.

---

## Зависимости задач (DAG)

```
A1 ─┬─ A2
     ├─ A3 ── B2 ── D1
     └─ (A1 используется C1, E1)
A4 ── D4 ── E3
B1 ── B2 ── B4
B3 ── C4
C1 ── C2, C3, C4
C4 ── C5
D2 ── D3, D4
E2, E4 — независимы
```

Все зависимости ацикличны. Производитель существует до потребителя.

---

## Self-review

1. Каждое требование из аудита (P0/P1/P2) имеет задачу-владельца: A1–A4 (pathScope, cwd-invariant, InterventionChecker/blacklist, SSRF), B1–B4 (taxonomy, step/events, usage, CLI-adapter), C1–C5 (pipeline, tokenAccounting, snapshot, tracing, OTel), D1–D4 (SSE, contracts, OpenAPI, network.fetch), E1–E4 (P2).
2. Task dependencies ацикличны (см. DAG); producer существует до consumer.
3. Имена/интерфейсы согласованы между задачами (path-scope API используется в workspace-tools/action-gateway; provider-errors используется в adapter/run-service; события используются в B2/D1).
4. RED действительно падает до изменения (модуль absent/behavior не определён), GREEN проверяет нужный production path.
5. Commands существуют и конкретны; Expected проверяемы.
6. High-risk failure modes покрыты: digest-семантика (C1), resume-совместимость (B2), fail-closed (A3/A4), no-op OTel (C5).
7. План не является транскриптом кода; тела приводятся только там, где без них остаётся неоднозначность.
8. Коммит: только этот файл плана (rules repository governance); реализация начинается только после независимого review с verdict `APPROVED`.

---

## Порядок внедрения (рекомендация)

Фаза 1 (безопасность): A1 → A2 → A3 → A4.
Фаза 2 (runtime): B1 → B2 → B3 → B4.
Фаза 3 (контекст/наблюдаемость): C1 → C2 → C3 → C4 → C5.
Фаза 4 (транспорт/контракты/инструменты): D1 → D2 → D3 → D4, затем E1–E4.

Каждая фаза завершается полными gates и независимым review; фазы последовательны по перекрытию файлов (run-service и adapter разделяют B и C — исполнять B до C4 по зависимостям).
