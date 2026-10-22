---
id: plan-22
kind: plan
status: proposed
title: Внедрение паттернов lobehub/lobehub
summary: Перенос адаптированных паттернов безопасности, runtime, контекста и наблюдаемости без расширения утверждённой архитектуры Ebb Orchestrator.
created: 2026-10-22
updated: 2026-10-22
depends_on: []
specs:
  - ../specs/01-system-design.md
---

# Внедрение проверенных паттернов из lobehub/lobehub — Implementation Plan

**Goal:** внедрить в Ebb Orchestrator проверенные паттерны и контракты из открытого репозитория lobehub/lobehub (canary), усилить безопасность инструментов, улучшить durable recovery, контекст и наблюдаемость — без изменения утверждённой архитектуры и инвариантов.

**Architecture:** заимствование выполняется как перенос **паттернов и контрактов**, а не кода (стеки расходятся: у донора PostgreSQL/Drizzle/Hono/tRPC + `@lobechat/*` и React-хост; у Ebb — SQLite/better-sqlite3, Fastify, собственный порт `AgentRuntime`). Работа ограничена тремя слоями: (A) Security Foundation, (B) Runtime & Recovery Execution, (C) Context & Observability. Каждый слой сохраняет существующие порты Ebb (`AgentRuntime`, `ActionGateway`, `PermissionEngine`, `ContextBuilder`/`ContextManifest`) и расширяет их изнутри.

**Authority:**
- `docs/architecture/specs/01-system-design.md` (утверждённая архитектура v1);
- `AGENTS.md`, `.hermes.md`, `apps/server/AGENTS.md`, `packages/contracts/AGENTS.md`;
- Исследованный источник lobehub/lobehub: ветка `canary`, точный commit `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1` (локальный read-only clone `C:\Users\alex1\lobehub-research`, наблюдён 2026-10-22). Исследования и паттерны сверяются только с этим commit; новый `canary` HEAD не заменяет зафиксированный источник.

**Global Constraints:**
- Не нарушать инварианты: детерминированность-first; modular monolith + Ports & Adapters; Git — источник истины для кода, SQLite — для оркестрационного состояния; все AI-запуски через порт `AgentRuntime`; действия агента через `ActionGateway`/`PermissionEngine` (fail-closed, unknown → deny); Scheduler без LLM; recovery до новой работы.
- `master` и remote read-only; работа только в worktree `develop`; никаких push/merge/force.
- Новые и изменённые production-комментарии и JSDoc — только на русском; технические идентификаторы не переводятся.
- Никаких копий кода донора «как есть»: переносятся интерфейсы, контракты и подходы, адаптированные под стек Ebb и русский JSDoc.
- Не менять существующий обощённый контракт (`packages/contracts`) без поиска всех consumers и обновления их тестов.

**Specialist Constraints (trigger-only):**
- Изменения схемы SQLite (C4 traces, при необходимости новые таблицы) — работать через `ebb-database-engineering` (версионированная миграция, append-only история).
- Любые изменения security-границ (A3) — обязательный security-focused review и evidence.
- Если B2 меняет observer/adapter contracts — проверить существующих реализаторов и тестовые fake; не добавлять и не менять общий `AgentRuntime` contract без отдельного решения.

**Review Focus (наивысшие риски):**
- Расширение `PermissionEngine` matcher-логикой (A3) не должно ослабить most-restrictive-wins и unknown → deny.
- Сетевые agent-facing capabilities не входят в этот план; их нельзя добавлять через implementation tasks без отдельного решения по whitelist, confirmations и Permission Engine.
- Рефакторинг `RunContextAssembler` в конвейер (C1) не должен изменить `prompt_hash`/`context_hash` (digest-семантика) и, как следствие, manifest и resume.
- Step/event-модель (B2) не должна сломать существующий durable resume по `session_id`.
- OTel (C5) — опциональный экспорт: локальный запуск без экспортёра должен работать без изменения поведения и без «тихого» падения.

---

## File / interface map

Группировка по ответственности (файлы, меняющиеся вместе).

### Security Foundation (Phase A)
| Файл | Тип | Ответственность |
|---|---|---|
| `apps/server/src/platform/security/path-scope.ts` | new | Нормализация/резолвинг аргументов-путей с ограничением scope; API в стиле `pathScope.ts` донора (normalizePathForScope, resolvePathWithScope, isPathWithinScope, resolveArgsWithScope) поверх существующего `PathResolver`; никакие вне-workspace пути не разрешаются. |
| `apps/server/src/modules/permissions/intervention-checker.ts` | new | Чистый детерминированный matcher аргументов для security blacklist; совпадение возвращает только `ABSOLUTE_DENY`, без новой ASK/approval policy. |
| `apps/server/src/modules/permissions/default-security-blacklist.ts` | new | Реестр regex-правил опасных действий (удаление данных, `/etc/passwd`, fork bomb, sudoers, firewall и т.п.), адаптированный к workspace-контексту. |
| `apps/server/src/modules/execution/workspace-tools.ts` | modify | Проводить все входные пути через `resolveArgsWithScope`/`isPathWithinScope`. |
| `apps/server/src/modules/execution/action-gateway.ts` | modify | Прогон аргументов через `InterventionChecker` до исполнения; защита от inbound `cwd`. |
| `apps/server/src/modules/permissions/permission-types.ts`, `permission-engine.ts` | modify | Расширение `EvaluationInput` полем `args`; интеграция matchers/blacklist в оценку. |

### Runtime & Recovery Execution (Phase B)
| Файл | Тип | Ответственность |
|---|---|---|
| `apps/server/src/modules/runtime/provider-errors.ts` | new | Таксономия ошибок провайдера: `ErrorCategory`, `ErrorSeverity`, `ErrorAttribution`, стабильные numericId, `ErrorClassifier` (предикаты rate-limit/quota/context-window/auth/network). |
| `apps/server/src/modules/runtime/usage-counter.ts` | new | Унифицированный аккумулятор usage/cost (единый формат `ModelUsage`). |
| `apps/server/src/modules/runtime/agent-events.ts` | new | Эфемерная discriminated union только для `run_started`, allowlisted `tool_pending`/`tool_result` и `run_finished`; без raw payload. |
| `apps/server/src/modules/runtime/run-service.ts` | modify | Эмиссия эфемерных событий из существующего lifecycle; интеграция `UsageCounter`; вызов tracing-хуков (C4) без изменения RunStatus/Workflow transitions. |
| `apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts` | modify | Использование таксономии ошибок и `UsageCounter`; поведение запуска/session не меняется. |
| `apps/server/src/modules/runtime/hermes/hermes-stream-session-observer.ts` | modify | Эмиссия только allowlisted tool lifecycle events без args/result payload; stream capture/session validation остаётся без изменения. |

### Context & Observability (Phase C)
| Файл | Тип | Ответственность |
|---|---|---|
| `apps/server/src/modules/runtime/context/context-processor.ts`, `context-pipeline.ts` | new | Каркас конвейера: `ContextProcessor`, `PipelineContext`, `BaseProcessor` (validate → doProcess → validate; ошибки с `cause` + `toJSON`). |
| `apps/server/src/modules/runtime/context/token-accounting.ts` | new | Учёт токенов по бакетам (`TokenSourceType`, per-message/per-tool breakdown, `driftMultiplier`). |
| `apps/server/src/modules/runtime/context/agent-config-snapshot.ts` | new | `AgentConfigSnapshot`: «намеренно plain data» — весь читаемый контекст собирается один раз, правила становятся чистыми функциями. |
| `apps/server/src/modules/runtime/run-context-assembler.ts`, `context-budget.ts` | modify | Рефакторинг в конвейер процессоров; интеграция tokenAccounting. |
| `apps/server/src/modules/runtime/tracing/tracing-payload.ts`, `tracing-store.ts` | new | Безопасные trace metadata и digest contract; raw prompt/input/output не сохраняются. |
| `apps/server/src/platform/database/migrations/048_run_traces.sql` | new | Additive migration для trace rows, связанных с Run; только после preflight подтверждения, что 048 остаётся следующим свободным номером. |
| `apps/server/src/platform/observability/otel.ts` | new | Инициализация OTel OTLP HTTP; `gen_ai` semconv; middleware-трейсинг; гистограммы. |
| `apps/server/package.json`, `pnpm-lock.yaml` | modify | Pinned OTel runtime dependencies из Task C5 для reproducible install/build. |

---

## Design decisions (зафиксированные решения)

1. **Переносим паттерны, не код.** Разрешён только перенос компактных самодостаточных модулей из baseline scope (`path-scope`, `intervention-checker`, `provider-errors`), портированных под стек Ebb и с русским JSDoc; без зависимостей `@lobechat/*`.
2. **Не переносим:** frontend/UI; `canvas-runtime`, `replica`, `edge-config`, `trpc` (React/Zustand/Vercel-специфика); крипто-протокол `secret-channel` целиком — берём только идею redaction-плейсхолдеров (P2); полный мультимодальный спектр `model-runtime` — берём только подкласс методов (chat/usage/stream) и таксономию ошибок; бизнес-логику чатов/плагинов/knowledge-base.
3. **`pathScope` vs существующий `PathResolver`:** `PathResolver` уже обеспечивает symlink/junction-safe containment. Новый `path-scope` добавляет нормализацию и подстановку scope в аргументы инструментов (`resolveArgsWithScope`) и единый вход для всех workspace-инструментов. Любой канонический путь вне capability-bound workspace, включая `/tmp`, отклоняется; исключений из containment в этом плане нет.
4. **Инвариант «модель не задаёт cwd»** — уже реализован принципиально в `CommandPolicy` («executable, cwd и лимиты агент не задаёт»). В плане это закрепляется регрессионными тестами, а не новой механикой.
5. **Сетевой fetch не входит в текущий scope.** Никакой SSRF helper, `ActionId` или MCP tool не добавляется; принятие такой задачи требует отдельного утверждённого плана после определения production consumer и security/UX contract.
6. **Event-модель (B2)** вводится только как наблюдение существующего Run lifecycle. События эфемерны, не создают persisted step-state, новых таблиц, Run-статусов или Workflow transitions.
7. **OTel (C5)** — опциональный экспорт, включается только при наличии `OTEL_EXPORTER_OTLP_ENDPOINT`; без него код работает в no-op режиме. Все OTel dependencies и их версии фиксируются в Task C5 до установки.

---

## Отложенная область (не входит в DAG этого плана)

Следующие идеи не имеют подтверждённого production consumer или одобренного v1 scope и не должны реализовываться в рамках Plan22:

- `network.fetch`, `ssrf-safe-fetch` и любая agent-facing network capability. Возобновление требует названного потребителя, отдельного scope/security решения, доменного allowlist и UX подтверждений; реализация должна отдельно закрыть DNS pinning, каждый redirect hop и ограничение реально прочитанного body.
- Shared model/provider schemas (`AiModelType`, `ModelAbilities`) и provider-response validation. Возобновление требует source-backed producer/consumer на реальной trust boundary; Hermes-owned provider payload не объявляется входом Ebb без доказанного Ebb boundary.
- Новая типовая система Hermes stream chunks: существующий `HermesStreamSessionObserver` уже ограничивает line size, проверяет UTF-8/JSON/init/session ID и экспортирует только bounded projections; отдельная задача допустима лишь при воспроизводимом пропуске конкретного malformed chunk.
- OpenAPI route/endpoint generation. Возобновление требует отдельного решения о публичности/аутентификации `GET /openapi.json` и конкретного generator/dependency contract.
- Connector-data normalization без существующего connector consumer.
- Дополнительные `AgentRuntime` adapters и generic multi-runtime abstraction сверх существующего порта `AgentRuntime`. Возвращаться к этому только в отдельном утверждённом post-v1 плане; Plan22 не создаёт дублирующий adapter interface.

Эти направления не являются задачами или зависимостями Plan22; включение требует отдельного утверждённого плана.

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
  - `isPathWithinScope(workspace: string, target: string): boolean` — true только для канонического пути внутри workspace после symlink/junction resolution.
  - `resolveArgsWithScope(workspace: string, args: Record<string, unknown>, pathFields: readonly string[]): { ok: true; args: Record<string, unknown> } | { ok: false; error: string }`
  - Семантика ошибок: `PATH_OUTSIDE_SCOPE`, `PATH_UNRESOLVABLE`.
- **RED:** расширить существующий `apps/server/test/modules/execution/workspace-tools.test.ts`: на POSIX создать в fixture literal filename `C:\\outside.txt`, затем доказать, что `WorkspaceTools.readFile('C:\\outside.txt')` fail-closed, а не трактует foreign absolute path как относительное имя файла внутри workspace. Это поведенческий RED на текущем production path. Дополнительные unit tests покрывают traversal, UNC/drive paths, absolute `/tmp` вне workspace и symlink/junction escape; отсутствие нового модуля само по себе не считается RED.
- **GREEN:** `resolveArgsWithScope` проверяет исходное значение до native `path.resolve`, сохраняет containment `PathResolver` и отказывает cross-platform absolute input; команда `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/security/path-scope.test.ts test/modules/execution/workspace-tools.test.ts` — PASS.
- **Gates:** `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm lint`.
- **Review Focus:** Windows-пути (drive letters, обратные слеши, UNC), symlink/junction-обход, отказ абсолютному `/tmp` вне workspace, отсутствие регрессий в `PathResolver`.

#### Task A2. Регрессионная защита инварианта «модель не задаёт cwd»
- **Depends on:** A1 (общий `action-gateway.ts` owner/order).
- **Create:** `apps/server/test/modules/execution/command-policy-cwd.test.ts`; расширение `action-gateway.test.ts`.
- **Modify:** `apps/server/src/modules/execution/action-gateway.ts` (защита от inbound `cwd` во всех public-методах, включая новые), `command-policy.ts` (при необходимости — явное игнорирование inbound `cwd`).
- **Interfaces:** контракт `CommandInvocation = { policyId; args }` остаётся без поля `cwd`; любой попавший `cwd` отклоняется (`CWD_NOT_ALLOWED`).
- **RED:** тест подаёт `{ policyId, args, cwd }` и ожидает отклонения; до правок поведение не определено (fail).
- **GREEN:** тест PASS; существующие тесты `command-policy` и `action-gateway` зелёные.
- **Gates:** typecheck; `pnpm lint`; `pnpm --filter @ebb-orchestrator/server test`.
- **Review Focus:** все пути вызова `exec`/`patch`/новых инструментов; отсутствие обходов через аргументы команд.

#### Task A3. Детерминированный security blacklist в Permission Engine
- **Depends on:** A1, A2 (нормализация args и завершённый общий `action-gateway.ts` change).
- **Create:** `apps/server/src/modules/permissions/intervention-checker.ts`; `apps/server/src/modules/permissions/default-security-blacklist.ts`; `apps/server/test/modules/permissions/intervention-checker.test.ts`.
- **Modify:** `permission-types.ts` (`EvaluationInput.args?: Readonly<Record<string, unknown>>`); `permission-engine.ts` (проверка blacklist до capability allow); `action-gateway.ts`/`tool-registry.ts` (передача нормализованных args до любого side effect).
- **Interfaces:**
  - `InterventionMatcherType = 'exact' | 'prefix' | 'wildcard' | 'regex'`; `InterventionMatcher = { type: InterventionMatcherType; pattern: string }`.
  - `InterventionRule { id: string; action: ActionId; matcher: InterventionMatcher; reasonCode: string }` — blacklist rules только запрещают; effect фиксирован как `ABSOLUTE_DENY`, не настраивается на ALLOW/ASK.
  - `InterventionChecker.evaluate(action: ActionId, args: Readonly<Record<string, unknown>>): { decision: PermissionDecision; reason: string }`.
  - Match blacklist до обычного capability fallback и композировать её `ABSOLUTE_DENY` через текущий most-restrictive-wins. `ASK`/approval semantics существующих policies не изменяются; Action Gateway не исполняет ничего, кроме `ALLOW`.
  - Некорректная blacklist rule/config, нераспознанное действие и oversized matcher/input fail closed; ограничить regex length/complexity и не принимать пользовательские regex без валидации.
- **RED:** тест на `ActionId.CommandExec` + args `rm -rf ~` ожидает `ABSOLUTE_DENY` и доказывает, что fake executor не вызван; до реализации текущий capability-only ActionGateway пропускает команду. Добавить precedence test, что blacklist `ABSOLUTE_DENY` не ослабляется policy/capability ALLOW. RED должен падать по assertions.
- **GREEN:** blacklist enforcement интегрирован перед реальным execution path; тесты PASS; существующие Permission Engine most-restrictive-wins, `ABSOLUTE_DENY`, unknown action и Action Gateway regression tests остаются зелёными.
- **Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/permissions/intervention-checker.test.ts test/modules/permissions/permission-engine.test.ts test/modules/execution/action-gateway.test.ts`.
- **Expected:** blacklisted action всегда `ABSOLUTE_DENY` до executor; capability/policy ALLOW не смягчает blacklist; существующие policy cases без blacklist сохраняют результаты.
- **Gates:** typecheck; lint; test; security-ревью (specialist).
- **Review Focus:** `ABSOLUTE_DENY` нельзя ослабить; fail-closed на invalid rules/args; ReDoS resistance; matcher является дополнительным deterministic guard, а не заменой capabilities, CommandPolicy или OS sandbox.

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

#### Task B2. Эфемерные события наблюдаемого Run
- **Depends on:** B1 (ошибки).
- **Create:** `apps/server/src/modules/runtime/agent-events.ts`; `apps/server/test/modules/runtime/agent-events.test.ts`.
- **Modify:** `run-service.ts` (эмиссия событий из существующего lifecycle), `hermes-stream-session-observer.ts`/`hermes-runtime-adapter.ts` (allowlisted tool events).
- **Interfaces:**
  - `AgentEvent` — discriminated union: `{ type: 'run_started'; runId; occurredAt }`, `{ type: 'tool_pending'; runId; toolId }`, `{ type: 'tool_result'; runId; toolId; success; errorCategory? }`, `{ type: 'run_finished'; runId; status: 'COMPLETED' | 'FAILED' | 'CANCELLED' }`.
  - Tool events разрешены только для существующего `RuntimeDiagnosticToolId`; результат содержит только boolean/fixed error category, не tool arguments, stdout или result payload.
  - `run_started`/`run_finished` эмитятся из уже выполняемых RunService lifecycle hooks; `run_finished` только после сохранения terminal RunStatus. Никакой event не запускает state transition.
  - Events process-local/ephemeral: не сохраняются в SQLite/outbox, не replay-ятся после restart; payload содержит только Run/tool identity, terminal status и allowlisted error category.
  - Не вводить `llm_start`/`llm_result` или hidden model events, если их нет в наблюдаемом Hermes transport; не выдавать stdout/stream event за structured result.
- **RED:** production RunService test с FakeAgentRuntime показывает отсутствие `run_started` и terminal `run_finished`; ожидает эти события вокруг существующего start/result/commit path. Observer fixture отдельно использует фактические `tool_use`/`tool_result` JSON формы для allowlisted tool ID и ожидает safe `tool_pending`/`tool_result`. Invalid/missing structured result не должен приводить к `run_finished: COMPLETED`. RED должен падать по assertions.
- **GREEN:** event union эмитится в указанном порядке; `run_finished` отражает только persisted terminal status; отсутствие подписчика/ошибка observer не меняет Run outcome; restart/resume по `session_id` остаётся без изменения.
- **Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/agent-events.test.ts test/modules/runtime/run-service.test.ts test/modules/runtime/hermes-stream-session-observer.test.ts`.
- **Expected:** RunService события окружают существующий committed lifecycle; allowlisted Hermes stream fixtures дают только безопасные tool events; malformed/missing structured result никогда не выдаёт `COMPLETED`.
- **Gates:** typecheck; lint; test; точные e2e `test/e2e/epic-restart-production.acceptance.test.ts` и `test/e2e/hermes-session-handoff.acceptance.test.ts`.
- **Review Focus:** no new RunStatus/Workflow lifecycle; event payload без prompt/tool data; event delivery не authority для completion, cancellation или recovery.

#### Task B3. Унифицированный `UsageCounter`
- **Depends on:** B1, B2 (изменения `run-service.ts` и `hermes-runtime-adapter.ts` выполняются последовательно).
- **Create:** `usage-counter.ts`; `apps/server/test/modules/runtime/usage-counter.test.ts`.
- **Modify:** `hermes-runtime-adapter.ts`, `run-service.ts` (использование единого счётчика вместо дублирующего `parseUsage`/`sessionObserver.usage`).
- **Interfaces:** `ModelUsage { inputTokens; cachedInputTokens; outputTokens; cost: number | null }`; `UsageCounter.merge(...)/snapshot()`.
- **RED:** тест слияния нескольких источников usage (включая `cost: null`) падает до реализации.
- **GREEN:** реализация; тесты PASS; существующие тесты `collectUsage` зелёные.
- **Gates:** typecheck; lint; test.
- **Review Focus:** правило «NULL cost не подменяется оценкой» сохранено.

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
- **Gates:** typecheck; lint; test; `test/e2e/context-manifest-production.acceptance.test.ts`.
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

#### Task C4. LLM-generation tracing (без raw prompt payload)
- **Depends on:** B3 (usage), C1 (digest).
- **Create:** `apps/server/src/modules/runtime/tracing/tracing-payload.ts`, `tracing-store.ts`; `apps/server/src/platform/database/migrations/048_run_traces.sql`; `apps/server/test/modules/runtime/tracing/tracing-store.test.ts`; migration test `apps/server/test/platform/database/run-traces-migration.test.ts`.
- **Modify:** `run-service.ts` (запись trace при завершении Run).
- **Database ownership / desired state:** новый `run_traces` — таблица runtime/tracing owner; migration additive, не меняет существующие таблицы и строки. Колонки: `id TEXT PRIMARY KEY`, `run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE`, `scenario TEXT NOT NULL`, `prompt_version TEXT NOT NULL`, `prompt_hash TEXT NOT NULL CHECK (64 lowercase hex)`, `context_hash TEXT NOT NULL CHECK (64 lowercase hex)`, `model_metadata_json TEXT NOT NULL`, `usage_json TEXT NOT NULL`, `validation_failed INTEGER NOT NULL CHECK (0,1)`, nullable stable `error_category`, `created_at TEXT NOT NULL`, `version TEXT NOT NULL`. Несколько trace rows на Run разрешены; индекс `(run_id, created_at)`. Нет backfill для исторических Runs; удаление Run каскадно удаляет его traces.
- **Data / trust contract:** не сохранять и не экспортировать raw prompt, raw input/output, stderr, credentials, endpoint URL или headers. Trace содержит только hashes, несекретные model/runtime IDs, usage, validation outcome и stable error category. API projection в этой задаче не добавляется.
- **Interfaces:** `TracingPayload { tracing_id; run_id; scenario; prompt_version; prompt_hash; context_hash; model_metadata; usage; validation_failed; error_category; created_at; version: '1.0' }`; `computePromptHash(finalPromptBytes: Uint8Array): string` делегирует текущему `digestRunPromptBytesV1`, выдаёт полный 64-char lowercase SHA-256 для точных сохранённых prompt bytes; `ITracingStore.save(...)` использует один SQLite transaction boundary с записью trace.
- **Migration preflight:** на текущем catalog последняя migration — 047; перед исполнением подтвердить, что 048 остаётся следующим свободным номером. Если catalog изменился, обновить migration path/version и acceptance references в этом плане до реализации. Не переписывать опубликованные migrations.
- **RED:** тесты по отдельности доказывают fresh install 001–048 и populated upgrade 047→048; чтение новой записи; rollback при ошибке; `PRAGMA foreign_key_check`; cascade semantics; проверку `prompt_hash`/`context_hash` длиной 64; отсутствие raw prompt/input/output в payload/DB projection. RED должен падать по assertion.
- **GREEN:** migration + store проходят upgrade/fresh path; существующие rows остаются неизменными; повторный `save` с тем же `tracing_id` и тем же payload идемпотентно возвращает прежний результат, а с тем же ID и другим payload возвращает stable conflict без update; существующие migration suites зелёные.
- **Run:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/runtime/tracing/tracing-store.test.ts test/platform/database/run-traces-migration.test.ts test/platform/database/fresh-install-migrations.acceptance.test.ts`.
- **Expected:** populated 047→048 и fresh 001→048 проходят, старые rows неизменны, retry не создаёт duplicate, FK/cascade checks зелёные, raw content нигде не сохраняется.
- **Gates:** `ebb-database-engineering`; focused migration/store tests; typecheck; lint; test; fresh-install migration acceptance.
- **Review Focus:** immutable/forward-only migration; trace data minimization; точное соответствие manifest `prompt_hash`; transaction/idempotency boundary; отсутствие новой raw-content API.

#### Task C5. OTel-наблюдаемость (gen_ai semconv + middleware)
- **Depends on:** C4 (данные для trace metadata).
- **Create:** `apps/server/src/platform/observability/otel.ts`; `apps/server/test/platform/observability/otel.test.ts` (no-op без endpoint).
- **Modify:** `apps/server/src/app/create-app.ts`, `apps/server/src/modules/runtime/run-service.ts`, `apps/server/package.json`, `pnpm-lock.yaml`.
- **Dependencies (exact):** `@opentelemetry/api@1.10.0`, `@opentelemetry/sdk-node@0.300.0`, `@opentelemetry/exporter-trace-otlp-http@0.300.0`, `@opentelemetry/exporter-metrics-otlp-http@0.300.0`, `@opentelemetry/semantic-conventions@1.43.0`. `sdk-node@0.300.0` peer contract требует `@opentelemetry/api >=1.10.0 <1.11.0`; оба OTLP exporters `0.300.0` принимают `@opentelemetry/api ^1.3.0`. Добавить как production dependencies server package, exact versions без ranges и без transitive-only dependency. Если peer/Node compatibility изменилась к моменту исполнения, приостановить C5 и получить review обновлённой dependency-матрицы до установки.
- **Interfaces:** `registerOtel(options): Promise<ShutdownFn>`; OTLP HTTP trace+metrics; `gen_ai` attributes из закреплённой semantic-conventions версии; включение только через `OTEL_EXPORTER_OTLP_ENDPOINT`; shutdown встроен в текущий lifecycle.
- **RED:** тест без endpoint доказывает no-op без изменения бизнес-результата; mocked endpoint принимает export только с endpoint; exporter failure не блокирует startup/run и не изменяет Run outcome. RED должен падать по assertion.
- **GREEN:** реализация; tests PASS; локальный startup без env остаётся no-op; shutdown flush/timeout ограничены и проверены.
- **Install:** `pnpm --filter @ebb-orchestrator/server add --save-exact @opentelemetry/api@1.10.0 @opentelemetry/sdk-node@0.300.0 @opentelemetry/exporter-trace-otlp-http@0.300.0 @opentelemetry/exporter-metrics-otlp-http@0.300.0 @opentelemetry/semantic-conventions@1.43.0`.
- **Verify:** `pnpm install --frozen-lockfile`; `pnpm --filter @ebb-orchestrator/server typecheck`; `pnpm --filter @ebb-orchestrator/server build`; `pnpm --filter @ebb-orchestrator/server test`; `pnpm lint`.
- **Review Focus:** отсутствие влияния экспортёра на бизнес-результат; не блокировать старт сервера; не экспортировать prompt/raw context/секреты; проверка pinned OTel dependency compatibility.

### Deferred P2 Improvements

Эти улучшения не входят в baseline acceptance и выполняются только после отдельного явного выбора scope; не трактовать `P2` как автоматическое разрешение на расширение v1.

- **E1. Транзакционные патчи `partiallyApplied`:** расширить `workspace.patch` контрактом частичного применения (по образцу `ModifyOperationResult`), с явным статусом `partiallyApplied`; тесты. (Depends: A1.)
- **E2. Redaction-плейсхолдеры:** защитить секреты в логах/диагностике: модуль `platform/security/redact.ts` + применение в диагностических путях; тесты. (Depends: —)
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

Специализированные gates (вызываются по trigger задач): e2e (`test/e2e/epic-restart-production.acceptance.test.ts`, `test/e2e/hermes-session-handoff.acceptance.test.ts`, `test/e2e/context-manifest-production.acceptance.test.ts`, `test/platform/database/fresh-install-migrations.acceptance.test.ts`); security review для A3; database-engineering для C4.

---

## Зависимости задач (DAG)

```
A1 ── A2 ── A3
│
├── C1 ──┬── C2
│        ├── C3
│        └── C4 ── C5
│
B1 ── B2 ── B3
          ├──── C4

E1 (P2) зависит от A1 и выполняется только после отдельного выбора scope.
E2, E4 (P2) не входят в baseline и требуют отдельного выбора scope.
```

Все зависимости ацикличны. Каждый production file имеет одного task owner за раз: общие `action-gateway.ts` changes строго A1→A2→A3; общие `run-service.ts`/`hermes-runtime-adapter.ts` changes строго B1→B2→B3. C4 начинается только после C1 и B3; C5 — после C4. Deferred scope и P2 improvements не создают рёбер baseline DAG.

---

## Self-review

1. Требования baseline scope имеют владельцев: A1–A3 (path-scope, cwd invariant, InterventionChecker/blacklist), B1–B3 (error taxonomy, ephemeral events, usage), C1–C5 (context pipeline, token accounting/snapshot, tracing, OTel). Unsupported network/model/OpenAPI/connector/extra-runtime items явно вынесены из DAG; P2 E1/E2/E4 не входят в baseline acceptance.
2. Все task dependencies перечислены в `Depends on` и DAG; пересечения `action-gateway.ts` и runtime adapter/service выполняются в заданном последовательном порядке.
3. Producer/consumer interfaces сверены: `path-scope` → workspace tools; provider errors/usage/events → Hermes adapter/RunService; tracing ← Run/Context digest.
4. RED должен падать на ожидаемой behavioral assertion в реальном production seam; отсутствие нового модуля само по себе не принимается как RED. GREEN включает focused и neighboring tests.
5. `Run`/`Expected` и точные test commands указаны для tasks; package install impact закреплён в C5.
6. Load-bearing semantics: workspace containment не имеет `/tmp` exception; RunStatus/Workflow не расширяются; context digests остаются byte-identical; tracing не хранит raw content; OTel failure не влияет на выполнение.
7. План ограничен утверждённой архитектурой и не вводит agent-facing network tool, новый provider boundary или OpenAPI endpoint.
8. Lifecycle остаётся `proposed`; перевод в `planned` допустим только после независимого review с verdict `APPROVED`. Реализация начинается только после такого verdict.

---

## Порядок внедрения (рекомендация)

Фаза 1 (безопасность): A1 → A2 → A3.
Фаза 2 (runtime): B1 → B2 → B3.
Фаза 3 (контекст/наблюдаемость): C1 → C2 → C3 → C4 → C5.
P2 E1/E2/E4 — только после отдельного выбора scope; не часть baseline DAG.

Каждая фаза завершается своими focused/full gates и независимым review; общие файлы редактируются только в указанном task order. B выполняется до C4 по зависимости B3 → C4.
