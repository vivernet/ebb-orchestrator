# Ebb Orchestrator — Project State

## Status
- Current branch: `develop`.
- Current HEAD: `c18264e` (`Устранить зависания Hermes и завершить v1 hardening`).
- `master` и `develop` указывают на один локальный commit `c18264e`; `origin/master` также указывает на эту ревизию, а `origin/develop` удалена.
- Audit date: 2026-09-21.
- Overall state: **V1 production-readiness hardening in progress**.
- Рабочее дерево чистое; новых commit или push в рамках этого прохода не выполнялось.

## Purpose
Ebb Orchestrator — local-first система оркестрации AI-разработки. V1 scope:
- Standalone Task и Epic с разными workflow
- Планирование, зависимости, approvals, recovery
- Единый SchedulerService с resource locks, concurrency и budget accounting
- Git branches, worktrees, merge, reconciliation
- Action Gateway и Permission Engine
- Запуск ролей через AgentRuntime и адаптер Hermes
- MCP-интеграция с capability validation
- Локальные события, outbox, фоновые jobs
- Optional синхронизация с GitHub

## Architecture Overview
Проект следует modular monolith с Ports & Adapters:
- Domain modules (work, workflow, planning, scheduler, approvals, permissions, execution, runtime, git, projects, recovery)
- Platform layer (database, events, jobs, process, security, home)
- Adapters (HermesRuntimeAdapter, GitHubAdapter, LocalExecutionAdapter)

## Sources of Truth
- Git: source of truth для кода/commit history
- SQLite/orchestration persistence: source of truth для orchestration state/history
- Scheduler: SchedulerService — единственный authority для dispatch/capacity/reservation
- permissions/executable actions: Permission Engine + Action Gateway (интегрированы)
- runtime: AgentRuntime port + HermesRuntimeAdapter
- integration/merge authority: MergeService

## Core Workflow
Request → planning → Task/Epic → development → review → QA → integration → approval → merge/release

## Authoritative Runtime Path
Scheduler → RunService → AgentRuntime
- RunService.prepareRun() → durable identity
- RunService.executePreparedRun() → runtime execution
- submit_result → atomic COMPLETING transition

## Scheduler and Resource Ownership
- SchedulerService — единственная точка входа
- Reservations и resource locks в одной таблице (scheduler_reservations, scheduler_resource_locks)
- Capacity: globalMax, projectMax, roleCapacity
- Budgets: scheduler_budgets с reserved_cost/spent_cost
- Reconciliation: SchedulerSafetyWorker запускает reconcile() каждые 5 сек

## Persistence and Migrations
- Migrations в apps/server/src/platform/database/migrations/
- Append-only SQL файлы
- Transactional migration runner
- Outbox events через appendOutboxEvent()

## Recovery and Restart Safety
- Startup: STARTING → RECOVERING → READY
- Migrations до создания services
- Reconciler для runs, Git/worktrees, budgets, outbox/jobs
- Worker start после recovery

## Git and Integration
- Git module для branches, worktrees, commits
- Worktrees для параллельной работы
- Merge policy требует final approval
- Реальный Git mutation перед VERIFIED

## Epic Semantics
- Epic → child Tasks
- Child Tasks интегрируются в Epic branch
- Epic Review → QA → Integration → merge в master
- Child Tasks становятся RELEASED только после финального Epic merge

## Security Boundaries
- ActionGateway с PathResolver для containment
- SubmitResultTool для validated output
- PermissionEngine интегрирован с ActionGateway (SEC-003 FIXED)
- Shell process через ProcessExecutor с timeout и limited output

## Main Packages and Modules
- apps/server/src/modules/ — domain modules
- apps/server/src/platform/ — adapters/infrastructure
- packages/contracts/ — shared domain contracts
- packages/testing/ — test helpers

## How to Install
```bash
pnpm install --frozen-lockfile
```

## How to Build
```bash
pnpm server:build
pnpm web:build
```

## How to Run
```bash
pnpm --filter @ebb-orchestrator/server dev
pnpm --filter @ebb-orchestrator/web dev
```

## How to Test
```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Verification Results
These are the latest verification results for the clean `develop`
checkout at `c18264e`; they are not a claim
that the branch is ready for merge or publication.

- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm test`: PASS (contracts: 3 passed; server: 687 passed, 2 skipped; web: 127 passed).
- `pnpm server:build`: PASS.
- `pnpm web:build`: PASS.
- `pnpm --filter @ebb-orchestrator/web test:e2e`: PASS (3 passed; launcher exit code 0; teardown artifact absent).
- `pnpm hermes:test`: PASS (6 passed).
- `pnpm hermes:setup`: PASS with `HERMES_CONFIG marker=SETUP_SYNCED verified=true redacted=true`; canonical skills, provider and capabilities hashes were verified after synchronization.
- `pnpm hermes:check`: PASS in a bounded serial run after setup; Windows `resolveHermesHome` resolves to `%LOCALAPPDATA%\\hermes`; all registry/provider/target/delegation checks passed.
- Hermes config/execute supervision tests: PASS for bounded timeouts, fixed redacted markers, cleanup and Windows process-tree termination via `taskkill.exe /PID /T /F`.
- `pnpm hermes:smoke`: the current live redacted smoke reached the Hermes/provider
  path with the documented `mercury-2` mapping and returned `MODEL_FAILED`, exit
  code 1, `redacted=true`, `cleanup_verified=true`. No repository context or raw
  provider output was exposed.
- The previous live smoke with `mercury-2.5` is explicitly superseded and is not
  current model/authorization evidence. Smoke does not replace provider-backed
  parity. Config/execute timeout handling is implemented and covered by focused
  tests; the historical slow `hermes:check` observation is not attributed to a
  separate provider timeout root cause.
- `node --test scripts/security-audit-evidence.test.mjs`: PASS (5 passed).
- Fresh Escalated dependency audit: PASS (0 info/low/moderate/high/critical),
   recorded in `artifacts/security/pnpm-audit-prod-b3b66154729ca2b373e0424dbab96b4435ec2c11.json`
   with current revision, `develop` branch, lockfile SHA-256, timestamp and exit code 0.
- `artifacts/security/pnpm-audit-prod-2026-09-21.json` is retained as an older
  generated snapshot without revision/branch/lockfile provenance and is not current
  evidence.
- `git diff --check`: PASS (only environment-level Git ignore permission warnings).

## Web UI Stage A1 Result

После утверждённого Web UI recovery design реализован и проверен первый bounded increment:

- `router.tsx`: добавлены runtime 404 и безопасная route-error boundary с retry;
- `AppShell.tsx`: добавлены breadcrumbs, контекстная навигация и корректная active-state для Dashboard;
- `DashboardPage.tsx`: известные project/task/run/queue IDs стали client-side links с кодированием сегментов; фиктивный Coordinator Chat и неподтверждённые действия не возвращены;
- malformed route segments обрабатываются без `URIError`;
- добавлены route, accessibility-oriented и encoded-ID regression tests.

Stage A1 status: **PASS**. Stage B foundation и Dashboard/Project/Epic/Task/Execution/AgentRun migration pilot также PASS; onboarding/project flows (Stage C), Approval (Stage D), operational screens (Stage E) и matrix browser verification (Stage F) остаются следующими этапами.

## Web UI Stage B Foundation Slice

- `api/client.ts`: `AbortSignal`, structured `ApiError`, safe 204/empty response handling и корректная сериализация falsy bodies;
- security headers остаются authoritative: caller headers не переопределяют memory-only bearer и CSRF;
- `packages/contracts/src/api.ts`: canonical builders для доказанных session/read/detail/mutation/event paths с encoded segments;
- `state/query-store.ts`: dependency-free canonical keys, cache/dedupe, loading/success/error/stale states, invalidate/refetch, abort и stale-result protection;
- `state/mutation-store.ts`: pending/success/error lifecycle, same-key dedupe, authoritative refetch hook и sync-throw recovery without optimistic domain state;
- `state/use-query.ts`: React subscription adapter с canonical key, shared-consumer-safe cleanup, stable fetcher ref и ручным retry/refetch;
- Dashboard, Project, Epic, Task, Execution и AgentRun переведены на `useQuery`: независимые loading/error/empty/retry states, AbortSignal/stale-result protection, explicit not-found, encoded links и SSE reconnect refetch;
- regression coverage: API foundation 12 focused assertions, query store 7 tests, mutation store 5 tests, query hook 6 tests; Dashboard/Project/Epic/Task/Execution/AgentRun pilot coverage; the listed full-web count is historical and requires rerun.

Stage B status: **FOUNDATION PASS / READ-ONLY PILOT + APPROVE-ONLY MUTATION PASS**. Settings contract freeze теперь PASS с explicit unavailable semantics; SSE key invalidation для remaining consumers остаётся следующим bounded increment; shared Epic/Task child DTOs typed; reject/request-changes не реализуются без backend contract.

## Operational Contract Corrections

- Usage route теперь использует реальные migration-backed поля `actual_cost`, `cached_tokens` и `total_tokens`; aggregate buckets явно маркируются как aggregate membership, а не как scoped budgets.
- Shared `RunStatus` синхронизирован с уже существующим runtime lifecycle: `COMPLETING` включён в contract и покрыт regression test.
- Usage scope/limit semantics, authoritative Settings fields, cancel error mapping и shared child DTOs остаются contract-first задачами; UI не должен выводить их из client-side inference.

## Important Architectural Invariants
1. SchedulerService — единственная точка входа для reservations/capacity
2. RunService — durable run lifecycle (prepareRun → executePreparedRun → complete)
3. WorkflowEngine — state transitions + outbox в одной транзакции
4. SubmitResultTool — atomic COMPLETING transition
5. Git — source of truth для кода, SQLite — для orchestration state
6. PermissionEngine — интегрирован с ActionGateway

## Closed Findings In This Pass
1. Playwright harness управляет backend/frontend отдельно, корректно завершает Windows process tree и возвращает exit code Playwright.
2. Hermes использует persisted authoritative `capability.workspace`; fallback в `os.homedir()/worktrees/<runId>` удалён, отсутствие capability/workspace завершается fail-closed.
3. Ошибка startup reconciliation переводит lifecycle в `DEGRADED` и блокирует переход в `READY`; health возвращает `503`.
   Built-in reconciliation diagnostics сохраняют только фиксированный step и
   error kind, без raw error message/secret output.
4. Security evidence tooling now requires revision, branch, lockfile SHA-256, run timestamp and exit code in a CI-bound JSON artifact; the manifest no longer stores a stale run snapshot.
5. Project-local Hermes support расширен до 9 skills и 9 capabilities; добавлены
   canonical registry и non-secret Inception profile с `INCEPTION_API_KEY`.
6. Capability contract синхронизирован с MCP surface: добавлены typed handlers для
   `project.lint`, `project.typecheck`, `project.build`, `command.exec`; unsupported
   `command.shell`/`artifact.write` удалены из default role surfaces.

## Known Limitations
1. Browser E2E уже запускает собранный `apps/server/dist/main.js` и Vite frontend с изолированным временным `EBB_ORCHESTRATOR_HOME`; полный набор продуктовых UI flows, Hermes live runtime, Git/worktree recovery и SecretStore-провижининга ещё не покрыт.
2. Hermes live E2E остаётся opt-in и пропускается без установленного Hermes/model runtime.
 3. `.opencode` всё ещё присутствует; локальный Hermes setup/check и repository gates
    проходят, но реальный Stage 9 provider-backed parity-run получил `HTTP 401` от
    Inception. Current synthetic smoke with documented `mercury-2` reached the
    provider path but returned `MODEL_FAILED`; cleanup остаётся отложенным до
    успешного provider-backed parity-run. Redacted smoke не заменяет parity и не
    доказывает authorization.
4. Stage 10 audit artifacts созданы: `docs/audit/web-ui-code-map.md`,
   `docs/audit/web-ui-gap-analysis.md` и
   `docs/architecture/specs/2026-09-18-web-ui-recovery-design.md`; Stage A1
   реализован; Stage B Dashboard/Project/Epic/Task pilot проверен, но миграция
   Usage/Settings contract freeze выполнен с explicit aggregate/unavailable semantics;
   миграция оставшихся страниц и browser acceptance для всех flows ещё не выполнены.
5. Production-readiness plan содержит незакрытые checkbox-инструкции и требует синхронизации после review.
6. Local Mode остаётся policy isolation, а не OS sandbox.
7. Inception provider template/setup проверен локально в Hermes profile; dependency
   audit и Playwright E2E прошли, но live model E2E не подтверждён из-за `HTTP 401`.

## Changes Made During This Audit
- SEC-003 FIXED: Integrated PermissionEngine with ActionGateway
  - ActionGateway.checkPermission() now uses permissionEngine.evaluate()
  - PermissionEngine falls back to capability check when no policies match
  - Updated tests to reflect new behavior
- Audit files reorganized into docs/audit/ directory

## Next Required Sequence
1. Завершить независимый security/architecture/recovery review после последних изменений и обновить evidence.
2. Исправить/подтвердить доступ configured Hermes provider, повторить Stage 9 parity-plan с двумя успешными read-only subagents и только после PASS удалить `.opencode`.
3. Завершить Stage B migration: перевести operational/config pages на query store, затем подключить mutation lifecycle к approval/cancel UI и SSE key invalidation без изменения security/session semantics. Перед Usage/Settings UI changes сначала зафиксировать scoped usage/limit semantics, authoritative settings fields и COMPLETING status contract.
4. Реализовывать Web UI по стадиям C–E из `docs/audit/web-ui-gap-analysis.md`, не добавляя неподтверждённые backend actions; отдельно зафиксировать решения по onboarding, approval reject/request-changes, run observability и settings mutations.
5. Выполнить browser evidence по всем 10 экранам и основным flows, затем провести final v1 productization.
6. При наличии разрешённого `INCEPTION_API_KEY` повторить provider-backed Hermes
   parity-run; не считать template/setup check доказательством live-доступа.
