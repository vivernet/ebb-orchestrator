# Ebb Orchestrator — Project State

## Status
- Current branch: develop
- HEAD before final commit: 67b1426 docs: move audit files to docs/audit/ directory
- Audit date: 2026-09-18
- Overall state: PASS

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
pnpm --filter @ebb-orchestrator/web build
```
Server production artifact gate не определён.

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
- lint: PASS
- typecheck: PASS
- tests: PASS (server: 612/614, web: 65/65)
- build: PASS (web)
- integration: NOT_DEFINED
- e2e: NOT_DEFINED
- migrations: NOT_DEFINED
- security: NOT_DEFINED
- smoke: NOT_DEFINED
- startup: NOT TESTED
- shutdown: NOT TESTED
- git diff --check: PASS

## Important Architectural Invariants
1. SchedulerService — единственная точка входа для reservations/capacity
2. RunService — durable run lifecycle (prepareRun → executePreparedRun → complete)
3. WorkflowEngine — state transitions + outbox в одной транзакции
4. SubmitResultTool — atomic COMPLETING transition
5. Git — source of truth для кода, SQLite — для orchestration state
6. PermissionEngine — интегрирован с ActionGateway

## Known Limitations
1. F-001/GIT-006: main.ts обращается к projects до migrations; GitReconciler не инициализирован с repository path
2. GIT-008: worktree remove --force может удалить dirty data
3. F-005: Hermes E2E тесты skipped по умолчанию
4. F-006: отсутствует production server build/package gate

## Changes Made During This Audit
- SEC-003 FIXED: Integrated PermissionEngine with ActionGateway
  - ActionGateway.checkPermission() now uses permissionEngine.evaluate()
  - PermissionEngine falls back to capability check when no policies match
  - Updated tests to reflect new behavior
- Audit files reorganized into docs/audit/ directory

## Final Review
Independent reviewer: NOT COMPLETED (subagent API limit reached)

## Commit
Final commit SHA: to be created
Final commit message: fix: complete final v1 hardening
