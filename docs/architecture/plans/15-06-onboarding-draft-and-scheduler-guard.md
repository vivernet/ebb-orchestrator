---
id: plan-15-06
kind: plan
status: completed
title: Atomic onboarding draft contract и scheduler guard
created: 2026-09-25
updated: 2026-09-27
depends_on:
  - plan-15-01
  - plan-15-04
  - plan-15-05
specs:
  - ../specs/01-system-design.md
  - ../specs/02-web-ui-recovery-design.md
evidence:
  - apps/server/src/app/routes/onboarding.ts
  - apps/server/src/app/create-app.ts
  - apps/server/src/main.ts
  - apps/server/src/modules/projects/onboarding-service.ts
  - apps/server/src/modules/projects/project-service.ts
  - apps/server/src/modules/approvals/approval-service.ts
  - apps/server/src/modules/approvals/approval-types.ts
  - apps/server/src/platform/events/outbox-repository.ts
  - apps/server/src/app/read-models/dashboard-projection.ts
  - apps/server/src/app/read-models/task-projection.ts
  - apps/server/src/app/read-models/project-projection.ts
  - apps/server/src/app/read-models/execution-projection.ts
  - apps/server/src/app/routes/runs.ts
  - apps/server/src/app/routes/work.ts
  - apps/server/src/platform/database/migrations/002_work_domain.sql
  - apps/server/src/platform/database/migrations/003_work_control.sql
  - apps/server/src/platform/database/migrations/021_onboarding_approval.sql
  - apps/server/src/modules/scheduler/scheduler-service.ts
  - apps/server/src/modules/scheduler/resource-lock-service.ts
  - apps/server/src/modules/scheduler/scheduler-types.ts
  - apps/server/src/app/routes/runs.ts
  - apps/server/src/modules/runtime/run-event-handlers.ts
  - apps/server/src/modules/planning/epic-orchestrator.ts
  - apps/server/test/app/api.test.ts
  - apps/server/test/modules/projects/repository-discovery.test.ts
  - apps/server/test/modules/scheduler/scheduler.test.ts
  - apps/web/src/features/onboarding/api.ts
  - apps/web/src/features/onboarding/OnboardingPage.tsx
  - apps/web/src/features/tasks/TaskPage.tsx
  - apps/web/test/core-views.test.tsx
  - apps/web/src/app/router.tsx
---

# 15-06. Atomic onboarding draft contract и scheduler guard

**Результат:** discovery creates a durable draft `projectId` atomically, the persisted review/approval/activation lifecycle is reloadable, and no scheduler reservation or AgentRun dispatch can cross the onboarding boundary.

## Approved lifecycle and exact persistence model

- Keep `RepositoryDiscovery` read-only. `OnboardingService.discoverAndCreateDraft` owns deterministic validation, discovery result normalization and the `Database.transaction` persistence boundary; routes never write project/config SQL.
- Do **not** add `027_onboarding_draft.sql` and do not edit `002_work_domain.sql`, `003_work_control.sql` or `021_onboarding_approval.sql`. The existing `projects.status` CHECK remains exactly `ACTIVE|ARCHIVED|DELETED`. A draft is represented by a generated project row with `projects.status='ACTIVE'`, `onboarding_configs.status='PROPOSED'`, `approval_id=NULL` and `proposed_json='null'`; only that durable combination maps to public `status: "DRAFT"`. Only `onboarding_configs.status='ACTIVE'` with its matching approved approval maps to public `ACTIVE`.
- `discoverAndCreateDraft(repositoryPath)` first validates the real absolute existing directory and collects facts through `RepositoryDiscovery`; inside one `Database.transaction` it inserts `projects(id,name,display_name,status,created_at,updated_at)` with a new UUID, deterministic repository-root name and `status='ACTIVE'`, then inserts `onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at)` with `status='PROPOSED'`, `proposed_json='null'` and `approval_id=NULL`. If either insert or serialization fails, the transaction rolls back both rows. It returns the canonical 15-01 `OnboardingProjection` with mandatory `projectId`; the literal JSON `null` is mapped to public `proposed: null`.
- Repeated successful discovery always creates a new project/config pair and returns a new `projectId`; there is no path uniqueness, implicit merge/reuse or draft garbage collector. A reload calls only `GET /api/v1/onboarding/:projectId`; it never re-runs discovery or requires a client path.
- Approval request reads `repository_path` and detected facts from the persisted draft. The client sends only `{ proposed: OnboardingProposal }`; it never resends an authority-bearing path. In the same `Database.transaction`, validate the proposal, insert one `approvals` row (`type='WORKFLOW_CHANGE'`, `subject_type='PROJECT'`, `status='PENDING'`), set `onboarding_configs.proposed_json` and `approval_id`, and leave config status `PROPOSED`. A partial approval/config write is forbidden.
- `approve` requires the current pending approval and performs conditional `UPDATE approvals SET status='APPROVED',resolved_by='local-user',resolution_note=$note,resolved_at=$now WHERE id=$approvalId AND subject_id=$projectId AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='PENDING'` in its transaction; it returns public `APPROVED` only when `changes()=1`. `activate` is one transaction requiring the exact approved approval id, the same project, and `onboarding_configs.status='PROPOSED'`; its conditional update is `UPDATE onboarding_configs SET status='ACTIVE',updated_at=$now,activated_at=$now WHERE project_id=$projectId AND status='PROPOSED' AND approval_id=$approvalId AND EXISTS (SELECT 1 FROM approvals WHERE id=$approvalId AND subject_id=$projectId AND subject_type='PROJECT' AND type='WORKFLOW_CHANGE' AND status='APPROVED')`, and it returns public `ACTIVE` only when `changes()=1`. Repeated activate is an idempotent `200 ACTIVE` only when the same approved config is already active; a mismatched or missing approval is `409 ONBOARDING_NOT_APPROVED`.

## Transaction-aware approval command and port

Create `apps/server/src/modules/approvals/approval-commands.ts` with the data-only symbols `RequestApprovalCommand` and `ApproveApprovalCommand`, and create `apps/server/src/modules/approvals/approval-port.ts` with `ApprovalTransactionPort.requestInTransaction(tx, command)` and `ApprovalTransactionPort.approveInTransaction(tx, command)`. The port accepts the existing `DatabaseTx` and returns the existing `Approval` domain type; it does not expose SQL or `Database` to routes. Modify `apps/server/src/modules/approvals/approval-service.ts` so `ApprovalService` implements this port, `request()` and `approve()` remain transaction-opening compatibility wrappers, and `requestInTransaction()`/`approveInTransaction()` perform the existing approval row, required metadata, outbox and audit writes on the caller transaction. Metadata-write errors propagate and roll back the approval; `approveInTransaction()` updates only the exact pending approval subject/type from its command and requires `changes()=1`. `appendOutboxEvent` remains the only outbox writer.

`apps/server/src/modules/projects/onboarding-service.ts` becomes the sole onboarding command authority. Its production constructor is `new OnboardingService(database: Database, approvalPort: ApprovalTransactionPort, discovery?: RepositoryDiscovery)`, and it exposes the complete `OnboardingCommandService` (`discoverAndCreateDraft`, `getProjection`, `requestApproval`, `approve`, `activate`). `requestApproval(projectId, proposed)` opens one `Database.transaction`, calls `approvalPort.requestInTransaction(tx, ...)`, writes the matching `onboarding_configs` row with `tx`, and returns `APPROVAL_PENDING`. `approve(projectId, note)` opens one transaction, calls `approvalPort.approveInTransaction(tx, ...)`, updates only the matching onboarding config timestamp/projection state with `tx`, and returns `APPROVED`. `activate(projectId)` keeps its existing single transaction and returns `ACTIVE`. `apps/server/src/app/routes/onboarding.ts` receives only this command service through `OnboardingRouteDeps.onboardingService`; it performs DTO parsing and status mapping only and contains no `db.get`, `db.run`, `db.transaction`, `INSERT`, `UPDATE` or approval-service call.

### Composition-root ownership and seam

`15-06` owns the onboarding composition changes in **both** `apps/server/src/main.ts` and `apps/server/src/app/create-app.ts`; `15-04` owns only the auth-service wiring in those same files. In `main.ts`, after migrations and before `createApp`, construct exactly one `ApprovalService(database)` and exactly one `OnboardingService(database, approvalService)`, then pass that instance as `createApp({ ..., onboardingService })`. In `create-app.ts`, remove the fallback `new OnboardingService()` and the route's `db`/`approvalService` dependencies; `AppDeps.onboardingService` is the explicit command boundary and production cannot silently construct a read-only service. Other routes may receive the shared `ApprovalService` for their own approval surface, but onboarding routes never receive a separate database or approval instance. Add `apps/server/test/app/onboarding-composition.test.ts` to assert the production-shaped object graph has one database, one `ApprovalTransactionPort` implementation and one transaction-aware `OnboardingService`, that `createApp` forwards that exact instance to `onboardingRoutes`, and that a route call cannot write persistence outside the service transaction. This test is owned by `15-06`, while auth composition assertions remain in `15-04`.

Add `apps/server/test/modules/approvals/approval-service.transaction.test.ts` and `apps/server/test/modules/projects/onboarding-approval-transaction.test.ts`. The request rollback test installs an SQLite `BEFORE INSERT ON onboarding_configs` trigger that raises `injected_onboarding_failure`; after `requestApproval` fails, assert zero new rows in `approvals`, `approval_metadata`, `onboarding_configs`, `outbox_events` and `audit_log`. The approve rollback test installs a `BEFORE UPDATE ON onboarding_configs` trigger; after `approve` fails, assert the approval remains `PENDING`, `onboarding_configs` remains unchanged, and there is no `ApprovalApproved` outbox row or `audit_log` row. GREEN also asserts successful request preserves exact approval metadata and `ApprovalRequested` outbox payload, successful approve preserves `ApprovalApproved` outbox plus audit details, and route tests prove routes cannot write persistence directly.

## Exact routes and DTOs

Implement the 15-01 contract unchanged:

- `POST /api/v1/onboarding/discover`, body exactly `{ repositoryPath: string }`, returns `201 OnboardingProjection` with `status="DRAFT"`; invalid/missing path `400 ONBOARDING_INVALID_REPOSITORY`, discovery failure `400 ONBOARDING_DISCOVERY_FAILED`.
- `GET /api/v1/onboarding/:projectId` returns `200 OnboardingProjection` from durable rows or `404 ONBOARDING_NOT_FOUND`. Projection status is derived deterministically: config `PROPOSED` + `approval_id IS NULL` + `proposed_json='null'` is `DRAFT`; config `PROPOSED` + pending approval is `APPROVAL_PENDING`; config `PROPOSED` + matching approved approval is `APPROVED`; config `ACTIVE` + matching approved approval is `ACTIVE`. Reload reads only these rows and never re-runs discovery.
- `POST /api/v1/onboarding/:projectId/approval`, body exactly `{ proposed: { defaultBranch: string, workflow: string, roles: string[], guidelines: string[] } }`, returns `201` with `APPROVAL_PENDING`; malformed body `400 ONBOARDING_INVALID_PROPOSAL`; unknown project `404`; existing pending approval `409 ONBOARDING_APPROVAL_PENDING`.
- `POST /api/v1/onboarding/:projectId/approve`, body exactly `{}` or `{ note?: string }`, returns `200` with `APPROVED`; no pending approval `409 ONBOARDING_NOT_PENDING`.
- `POST /api/v1/onboarding/:projectId/activate`, body `{}` only, returns `200` with `ACTIVE`; absent/mismatched approved approval or non-PROPOSED config `409 ONBOARDING_NOT_APPROVED`.
- All errors use `{ contractVersion: 1, error: { code, message } }`; remote URLs are sanitized and the stored absolute path is returned only where the existing local UI contract permits it. No client-selected project id or repository path is authoritative.

## Shared scheduler projection contract — exact DTO, status and serialization

This is a breaking shared-contract decision owned by `15-06`; no server or Web consumer may invent a projection shape. Modify `packages/contracts/src/api.ts` with these exact symbols and fields:

- `SCHEDULER_PROJECTION_CONTRACT_VERSION = 1`.
- `SchedulerProjectionStatus = "RUNNABLE" | "WAIT" | "BLOCK"`.
- `ProjectionBlockReason` is a discriminated union of `{ code: "BLOCKED"; message: string }`, `{ code: "BLOCKED_BY_WORKFLOW"; message: string }`, `{ code: "BLOCKED_BY_PROJECT_STATE"; message: string }`, `{ code: "PROJECT_NOT_ACTIVE"; message: string }` and the exact onboarding branch `{ code: "ONBOARDING_NOT_ACTIVE"; message: "Онбординг проекта не активирован" }`; no branch has optional fields. The onboarding code may not be serialized with another message or with `status: "WAIT"`.
- `SchedulerEligibilityProjection` is exactly `{ status: "RUNNABLE", reason: null } | { status: "WAIT", reason: WaitReason } | { status: "BLOCK", reason: ProjectionBlockReason }`. `ONBOARDING_NOT_ACTIVE` is legal only in the third variant.
- `DashboardProjection.activeWork[*]` becomes `{ id: string; title: string; status: string; eligibility: SchedulerEligibilityProjection }`; remove `waitReason` from this DTO. A draft/missing-onboarding task serializes `eligibility` as `{ "status": "BLOCK", "reason": { "code": "ONBOARDING_NOT_ACTIVE", "message": "Онбординг проекта не активирован" } }`.
- `TaskOverviewProjection` gains `scheduler: SchedulerEligibilityProjection` and removes `waitReason`. The same exact block object is serialized for a draft/missing-onboarding task.
- `ProjectOverviewProjection.tasks[*]` gains `eligibility: SchedulerEligibilityProjection`; the exact block object is serialized per affected task and never folded into the project `status`.
- `ExecutionQueueProjection.waiting` remains `Array<{ taskId: string; reason: WaitReason }>` and `blocked` becomes `Array<{ taskId: string; reason: ProjectionBlockReason }>`; `ONBOARDING_NOT_ACTIVE` can appear only in `blocked`.

The JSON contract test must assert exact key sets and `JSON.stringify` output: no `waitReason` key for the changed dashboard/task DTOs, no `ONBOARDING_NOT_ACTIVE` item in `runnables` or `waiting`, and the literal Russian message above in every blocked serialization. `SchedulerService.recalculate`, `getEligibility` and all projection adapters must preserve the discriminant; they must not translate this reason into `BLOCKED`, `WAITING_FOR_*`, `null` or a client-only status.

### Exact Web Task consumer semantics

`apps/web/src/features/tasks/TaskPage.tsx` consumes only `TaskOverviewProjection.scheduler` in the existing `Recovery` section; it must stop reading `projection.waitReason` and must not infer scheduler state from `task.status`, lifecycle fields or missing data. The three discriminants have these fixed consumer semantics:

- `scheduler.status === "RUNNABLE"` with `reason: null`: render the task as scheduler-eligible and do not render a waiting or blocked reason.
- `scheduler.status === "WAIT"`: render `scheduler.reason.message` as the backend-provided waiting reason; preserve the backend reason code/details and do not synthesize a replacement message.
- `scheduler.status === "BLOCK"`: render `scheduler.reason.message` as the backend-provided blocked reason; preserve the backend reason code and never downgrade it to `WAIT` or `RUNNABLE`.
- `scheduler.status === "BLOCK"` with `reason.code === "ONBOARDING_NOT_ACTIVE"`: render exactly `Онбординг проекта не активирован`, keep the state blocked, and never render it as a wait reason or replace it with a generic/localized client message. The UI remains presentation-only; dispatch authority stays in the backend.

`apps/web/test/core-views.test.tsx` must remove `waitReason` from every affected dashboard and Task response fixture. Dashboard `activeWork` fixtures use `eligibility`; Task fixtures use `scheduler` with the exact `{ status, reason }` shape, including the reconnect fixture. Its RED coverage must assert the TaskPage `RUNNABLE`, `WAIT`, and `BLOCK` behaviors above, including the exact Russian `ONBOARDING_NOT_ACTIVE` message and the absence of a legacy `waitReason` fallback; after the consumer change the same assertions must pass GREEN.

## Exact scheduler guard and every reservation/dispatch path

Create `apps/server/src/modules/scheduler/project-dispatch-guard.ts` with the exported symbols `projectDispatchEligibilityTx(tx, projectId)` and `assertProjectDispatchableTx(tx, projectId)`, and expose `SchedulerService.assertProjectDispatchable(projectId)` for route preflight. The guard reads both tables in the same transaction:

1. missing or non-`ACTIVE` `projects.status` returns/block-reasons `PROJECT_NOT_ACTIVE`;
2. missing `onboarding_configs` or status other than `ACTIVE` returns/block-reasons `ONBOARDING_NOT_ACTIVE`;
3. only `{ allowed: true }` permits reservation/dispatch.

Use these exact machine reason codes in `BlockReason`/dispatch errors: `PROJECT_NOT_ACTIVE` and `ONBOARDING_NOT_ACTIVE`. `ONBOARDING_NOT_ACTIVE` is a hard `BLOCK` reason, never a `WAIT` reason: `recalculate`, `getEligibility`, dashboard, task, project and execution projections place a PROPOSED or missing-config task in `blocked`, exclude it from `runnables` and `waiting`, and expose the exact shared DTO `{ code: "ONBOARDING_NOT_ACTIVE", message: "Онбординг проекта не активирован" }`. HTTP dispatch returns `409 ONBOARDING_NOT_ACTIVE`.

The guard is required at **all** creation and dispatch boundaries, with direct tests for each named path. The source inventory is intentionally closed: the only `INSERT INTO scheduler_reservations` sites allowed after this change are `SchedulerService.dispatchTask`, `SchedulerService.dispatchAgentRun` and `ResourceLockService.acquire`; release/reconcile updates do not authorize new work.

- `SchedulerService.getSchedulableTasks`/`evaluateEligibility`/`recalculate`: join project + onboarding state and emit the exact block reason without creating rows;
- `SchedulerService.startWorkflowRuns`: preflight each candidate and delegate to `dispatchTask`, with a direct-call test proving no reservation is created for a draft;
- `SchedulerService.dispatchTask`: call `assertProjectDispatchableTx` before eligibility, budget update, reservation insert or workflow transition;
- `SchedulerService.dispatchAgentRun`: call the same guard before idempotent-existing-reservation handling, budget reservation or phase reservation insert;
- `ResourceLockService.acquire`: call the same guard in its transaction before inserting the `LOCK` reservation/resource lock;
- HTTP `POST /api/v1/tasks/:id/dispatch` in `apps/server/src/app/routes/runs.ts`: resolve the task's `project_id`, call `scheduler.assertProjectDispatchable(projectId)` before `runService.prepareRun`, so a draft returns `409 ONBOARDING_NOT_ACTIVE` without an AgentRun or scheduler reservation; `prepareRun` must not precede this guard.
- `RuntimeEventHandlers.handleAgentRunRequested` in `apps/server/src/modules/runtime/run-event-handlers.ts`: resolve the task project and call `scheduler.assertProjectDispatchable(projectId)` before either the legacy `dispatchTask` branch or `runService.prepareRun`; direct-call tests assert zero `agent_runs`, `orchestration_phase_runs` and reservations for a draft.
- `EpicOrchestrator.approveAndRun`, `execute`, `runChild` and `runPhase` in `apps/server/src/modules/planning/epic-orchestrator.ts`: call `scheduler.assertProjectDispatchable(projectId)` before plan approval side effects, workspace provisioning, `epic_orchestrations`/`orchestration_phase_runs` writes, `workflow.transition`, integration preparation, `runs.prepareRun`, `dispatchAgentRun` or `dispatchTask`; direct tests cover integration/non-task and child branches and assert zero `agent_runs`, `orchestration_phase_runs` and reservations for a draft.
- `schedulerRoutes` remains a read/config surface and must not become a dispatch bypass. A repository search test enumerates the above symbols and fails if a new direct scheduler reservation/dispatch call is added without the guard test.

After activation, the same tests seed `onboarding_configs.status='ACTIVE'` and assert ordinary dependency/capacity rules permit the task. UI visibility is not a security guard.

## Files and interfaces

- Modify `apps/server/src/modules/projects/onboarding-service.ts` `OnboardingService.discoverAndCreateDraft` and its typed result; keep discovery facts separate from persistence.
- Modify `apps/server/src/app/routes/onboarding.ts` `OnboardingCommandService`, `OnboardingRouteDeps`, `POST /discover`, `GET /:id`, `POST /:id/approval`, `POST /:id/approve`, `POST /:id/activate`, `projectView` to consume the shared DTOs and persist/reload the lifecycle above. Remove client `repositoryPath` from approval.
- Modify `apps/server/src/modules/projects/project-service.ts` with a typed `createDraft`/transaction port; no direct SQL from routes.
- Modify `apps/server/src/modules/scheduler/scheduler-service.ts`, `resource-lock-service.ts` and `scheduler-types.ts` to use the named guard/reason codes; `scheduler-types.ts` `BlockReason` must include `ONBOARDING_NOT_ACTIVE` and `Eligibility` must keep it only under `status: "BLOCK"`. Do not add an alternate reservation authority.
- Create `apps/server/test/modules/scheduler/scheduler-fixtures.ts` exporting `loadSchedulerMigrations`, `seedActiveOnboarding(tx, projectId)` and `assertMissingOnboardingIsBlocked(scheduler, projectId)`. `loadSchedulerMigrations` reads the exact repository migration directory; positive dispatch fixtures use the full chain through `021_onboarding_approval.sql`, and missing-config tests intentionally omit the config row.
- Modify `apps/server/src/app/read-models/dashboard-projection.ts` symbols `DashboardProjection.get`, `schedulerWaitReason` and the new `schedulerEligibility` mapper; `task-projection.ts` symbol `TaskProjection.get`; `project-projection.ts` symbol `ProjectProjection.get`; `execution-projection.ts` symbol `ExecutionProjection.get`; and `apps/server/src/app/routes/work.ts` task fallback DTO so every scheduler-derived projection emits the exact shared DTO above. Modify `apps/server/src/app/routes/runs.ts` to map the guard error to the locked `409` DTO. `apps/web/src/features/dashboard/DashboardPage.tsx` and `apps/web/src/features/execution/ExecutionPage.tsx` render that backend code as a blocked reason and never as runnable/waiting work. Modify `apps/web/src/features/tasks/TaskPage.tsx` to consume `scheduler` exactly as specified above and remove the `waitReason` consumer.
- Modify `packages/contracts/src/api.ts` with the exact scheduler projection symbols above plus serializable discover/projection/approval/approve/activate schemas matching 15-01; server and Web import these and remove duplicate incompatible Web DTOs.
- Modify `apps/web/src/features/onboarding/api.ts`, `OnboardingPage.tsx` and `apps/web/src/app/router.tsx` to use the mandatory ID, exact proposal body, persisted GET after every command and a reloadable `/onboarding/:projectId` review route.

## Closed scheduler source and fixture inventory

The runtime source inventory is closed to these files and symbols; a new direct reservation/dispatch boundary requires a plan change and a matching test before implementation:

- `apps/server/src/modules/scheduler/scheduler-service.ts`: `getSchedulableTasks`, `evaluateEligibility`, `recalculate`, `startWorkflowRuns`, `dispatchTask`, `dispatchAgentRun`.
- `apps/server/src/modules/scheduler/resource-lock-service.ts`: `acquire`; release/reconcile paths only update or release existing authority.
- `apps/server/src/app/routes/runs.ts`: HTTP `POST /api/v1/tasks/:id/dispatch` preflight.
- `apps/server/src/modules/runtime/run-event-handlers.ts`: `handleAgentRunRequested`.
- `apps/server/src/modules/planning/epic-orchestrator.ts`: `approveAndRun`, `execute`, `runChild`, `runPhase`.
- `apps/server/src/app/read-models/dashboard-projection.ts`, `task-projection.ts`, `project-projection.ts`, `execution-projection.ts`, and `apps/server/src/app/routes/work.ts`: projection/fallback serialization only; they never authorize dispatch.
- `apps/server/src/app/routes/scheduler.ts`: read/config surface only; it must not be a dispatch bypass.

After the change, the only runtime `INSERT INTO scheduler_reservations` sites are `SchedulerService.dispatchTask`, `SchedulerService.dispatchAgentRun` and `ResourceLockService.acquire`. The inventory assertion scans the exact runtime source list above and fails on any additional reservation insert or direct dispatch call without a named guard test.

Migration files are a separate immutable historical inventory, not runtime source: `apps/server/src/platform/database/migrations/005_scheduler.sql`, `apps/server/src/platform/database/migrations/006_recovery.sql`, `apps/server/src/platform/database/migrations/012_epic_runtime_authority.sql`, `apps/server/src/platform/database/migrations/013_remove_legacy_scheduler_locks.sql`, `apps/server/src/platform/database/migrations/014_migrate_legacy_scheduler_authority.sql`, `apps/server/src/platform/database/migrations/018_scheduler_config_audit.sql` and `apps/server/src/platform/database/migrations/024_scheduler_runtime_schema.sql`. In particular, the `INSERT INTO scheduler_reservations` statements in immutable migrations `013` and `014` are migration-history data transfer and are explicitly excluded from the runtime-source count; they must not be edited or treated as new dispatch authorities. Positive fixtures load the complete repository chain `001` through `025`, including `021_onboarding_approval.sql`; missing-onboarding tests intentionally omit only the config row after loading the same chain.

The exact server fixture inventory is: `apps/server/test/modules/scheduler/scheduler.test.ts`, `apps/server/test/platform/database/scheduler-migration.test.ts`, `apps/server/test/platform/diagnostics/diagnostics.test.ts`, `apps/server/test/app/api.test.ts`, `apps/server/test/app/runs-dispatch.test.ts`, `apps/server/test/app/security.test.ts`, `apps/server/test/app/health.test.ts`, `apps/server/test/app/settings-route.test.ts`, `apps/server/test/app/dependencies-routes.test.ts`, `apps/server/test/app/web-assets.test.ts`, `apps/server/test/app/final-merge-route.test.ts`, `apps/server/test/app/epic-routes.test.ts`, `apps/server/test/e2e/transport-origin.test.ts`, `apps/server/test/e2e/epic.fake-runtime.test.ts`, `apps/server/test/e2e/v1-epic.test.ts`, `apps/server/test/scenarios/standalone-task.fake-runtime.test.ts`, `apps/server/test/scenarios/epic.fake-runtime.test.ts`, `apps/server/test/modules/runtime/run-event-handlers.test.ts`, `apps/server/test/modules/planning/epic-orchestrator-integration.test.ts` and `apps/server/test/modules/git/task-workspace-provisioner.test.ts`. Each selects exactly one fixture mode: `active-onboarding` for dispatch/projection success, `missing-onboarding` for explicit `ONBOARDING_NOT_ACTIVE`, or `no-dispatch` for auth/health/settings/assets-only cases. Existing ACTIVE seeds in final-merge, epic-routes and task-workspace-provisioner remain active-onboarding fixtures; no-dispatch tests must not imply scheduler eligibility. `apps/server/test/modules/scheduler/scheduler-fixture-inventory.test.ts` enumerates this list, validates the three modes, verifies the three allowed runtime insert sites, and rejects a scheduler-shaped project/task created without a mode.

## RED → GREEN

1. Server RED in `apps/server/test/app/api.test.ts`: discover against a temp repository returns `201` + `projectId`, creates exactly one ACTIVE project + PROPOSED config with `proposed_json='null'` atomically; injected failure leaves neither; GET projection survives reload; approval body `{}` or any path-bearing body is rejected; approve/activate ordering and exact `409` codes are enforced; repeated discovery creates two distinct drafts.
2. Add `apps/server/test/modules/projects/onboarding-service.test.ts` for read-only discovery versus transaction persistence, the two transaction rollback suites named above, and `apps/server/test/platform/database/migrator.test.ts` asserting 026 applies after 025, 021 remains unchanged and no 027 is loaded.
3. Add `apps/server/test/modules/scheduler/scheduler.test.ts`, `apps/server/test/app/runs-dispatch.test.ts`, `apps/server/test/app/api.test.ts`, `apps/server/test/modules/runtime/run-event-handlers.test.ts`, `apps/server/test/modules/planning/epic-orchestrator.test.ts` and `apps/server/test/modules/scheduler/resource-lock-service.test.ts` cases for missing/non-active onboarding: `recalculate`, `dispatchTask`, `dispatchAgentRun`, `ResourceLockService.acquire`, `startWorkflowRuns`, the HTTP route, runtime handler and epic paths return `ONBOARDING_NOT_ACTIVE` with zero new reservations/runs/phase rows; activate the same config and assert dispatch succeeds. Include `PROJECT_NOT_ACTIVE` separately. Add a source-inventory assertion for the three allowed reservation INSERT sites and direct-call coverage for every named guard boundary.
4. Add `apps/server/test/app/read-models/scheduler-projection.test.ts` covering `DashboardProjection.get`, `TaskProjection.get`, `ProjectProjection.get` and `ExecutionProjection.get`: a missing/PROPOSED config yields blocked `ONBOARDING_NOT_ACTIVE`, never `RUNNABLE` or `waiting`. Add the matching Web assertions in `apps/web/test/features/dashboard-execution-onboarding.test.tsx`.
5. The exact inventory above is implemented through `apps/server/test/modules/scheduler/scheduler-fixtures.ts` and `apps/server/test/modules/scheduler/scheduler-fixture-inventory.test.ts`: dispatch-success/projection fixtures load migrations `001`–`025` and seed matching approved `approvals` plus `onboarding_configs.status='ACTIVE'`; `missing-onboarding` keeps the project/task but has no config row; `no-dispatch` does not claim scheduler eligibility. The inventory test covers every listed fixture file, the three allowed runtime reservation INSERT symbols and the immutable `013`/`014` migration exclusion. `apps/server/test/app/final-merge-route.test.ts`, `apps/server/test/app/epic-routes.test.ts` and `apps/server/test/modules/git/task-workspace-provisioner.test.ts` keep their ACTIVE seeds and are explicitly included, not silently omitted.
6. Web RED in `apps/web/test/features/onboarding.test.tsx` and `apps/web/test/configuration-views.test.tsx`: mock only the canonical DTO; assert discover ID, exact approval body without path, `GET` refetch after each command, status/reload route, loading/error live regions and no guessed identifier.
7. Web RED in `apps/web/test/core-views.test.tsx`: replace every dashboard `activeWork[*].waitReason` fixture with `eligibility`, replace every Task `waitReason` fixture (including SSE reconnect) with `scheduler`, and add focused TaskPage cases for `RUNNABLE` (no waiting/blocked reason), `WAIT` (backend `reason.message`), and `BLOCK` with `ONBOARDING_NOT_ACTIVE` (exact `Онбординг проекта не активирован`, never waiting/runnable). These tests must fail against the current `waitReason` consumer and pass GREEN only after `TaskPage.tsx` consumes `scheduler`.
8. Implement service/routes/contracts/UI and rerun focused tests to GREEN. Preserve backend authority for path validation, proposal validation, approval matching, activation and scheduler guard.

## Explicit Create/Modify task scope

- **Create:** `apps/server/src/modules/approvals/approval-commands.ts` (`RequestApprovalCommand`, `ApproveApprovalCommand`), `apps/server/src/modules/approvals/approval-port.ts` (`ApprovalTransactionPort`), `apps/server/src/modules/scheduler/project-dispatch-guard.ts` (`projectDispatchEligibilityTx`, `assertProjectDispatchableTx`), `apps/server/test/modules/approvals/approval-service.transaction.test.ts`, `apps/server/test/modules/projects/onboarding-approval-transaction.test.ts`, `apps/server/test/modules/projects/onboarding-service.test.ts`, `apps/server/test/app/onboarding-composition.test.ts`, `apps/server/test/modules/planning/epic-orchestrator.test.ts`, `apps/server/test/modules/scheduler/resource-lock-service.test.ts`, `apps/server/test/modules/scheduler/scheduler-fixtures.ts`, `apps/server/test/modules/scheduler/scheduler-fixture-inventory.test.ts`, `apps/server/test/app/read-models/scheduler-projection.test.ts`, `packages/contracts/test/scheduler-projection-contract.test.ts`, and `apps/web/test/features/dashboard-execution-onboarding.test.tsx`.
- **Modify:** `apps/server/src/app/create-app.ts` and `apps/server/src/main.ts` for the onboarding composition seam only (15-04 remains owner of auth composition in these files); existing `apps/server/src/app/read-models/dashboard-projection.ts`, `task-projection.ts`, `project-projection.ts`, `execution-projection.ts`, `apps/server/src/app/routes/runs.ts`, `apps/server/src/app/routes/work.ts`, `apps/server/src/app/routes/onboarding.ts`, `apps/server/src/modules/scheduler/scheduler-service.ts`, `apps/server/src/modules/scheduler/resource-lock-service.ts`, `apps/server/src/modules/scheduler/scheduler-types.ts`, `apps/server/src/modules/runtime/run-event-handlers.ts`, `apps/server/src/modules/planning/epic-orchestrator.ts`, `apps/web/src/features/dashboard/DashboardPage.tsx`, `apps/web/src/features/execution/ExecutionPage.tsx`, `apps/web/src/features/tasks/TaskPage.tsx`, `apps/web/test/app/api.test.ts`, `apps/server/test/app/runs-dispatch.test.ts`, `apps/server/test/modules/runtime/run-event-handlers.test.ts`, `apps/server/test/modules/scheduler/scheduler.test.ts`, `apps/server/test/platform/database/migrator.test.ts`, `apps/web/test/features/onboarding.test.tsx`, `apps/web/test/configuration-views.test.tsx`, `apps/web/test/core-views.test.tsx`, `apps/server/test/app/health.test.ts`, `apps/server/test/app/security.test.ts`, `apps/server/test/app/settings-route.test.ts`, `apps/server/test/e2e/transport-origin.test.ts`, `apps/server/test/e2e/epic.fake-runtime.test.ts`, `apps/server/test/e2e/v1-epic.test.ts`, `apps/server/test/scenarios/standalone-task.fake-runtime.test.ts`, `apps/server/test/scenarios/epic.fake-runtime.test.ts`, `apps/server/test/modules/planning/epic-orchestrator-integration.test.ts`, `apps/server/test/platform/database/scheduler-migration.test.ts`, `apps/server/test/app/final-merge-route.test.ts`, `apps/server/test/app/epic-routes.test.ts`, `apps/server/test/app/dependencies-routes.test.ts`, `apps/server/test/app/web-assets.test.ts`, and `apps/server/test/modules/git/task-workspace-provisioner.test.ts` for the lifecycle, exact fixture modes, every guard boundary and the exact shared projection serialization. `TaskPage.tsx` must implement the fixed `RUNNABLE`/`WAIT`/`BLOCK` semantics above; `core-views.test.tsx` remains the canonical Web scheduler fixture consumer and must contain the `scheduler`/`eligibility` fixtures and assertions. The new projection test must cover `DashboardProjection.get`, `TaskProjection.get`, `ProjectProjection.get` and `ExecutionProjection.get` with both missing and `PROPOSED` onboarding rows.

## Commands / Expected

- `pnpm --filter @ebb-orchestrator/server test -- onboarding-service.test.ts onboarding-approval-transaction.test.ts approval-service.transaction.test.ts onboarding-composition.test.ts` — PASS; discovery, request/approve/activate, metadata/outbox/audit atomicity and the `main.ts` → `create-app.ts` single-service composition all use one caller-owned transaction and no route persistence access.
- `pnpm --filter @ebb-orchestrator/server test -- scheduler.test.ts` — PASS; `recalculate`/`getEligibility`, `startWorkflowRuns`, `dispatchTask` and `dispatchAgentRun` block missing/PROPOSED onboarding with `ONBOARDING_NOT_ACTIVE` before any reservation/run/phase write, while an approved ACTIVE config remains dispatchable.
- `pnpm --filter @ebb-orchestrator/server test -- resource-lock-service.test.ts` — PASS; `ResourceLockService.acquire` applies the same transaction-local guard and creates no `LOCK` reservation for missing/PROPOSED onboarding; active onboarding preserves ordinary lock behavior.
- `pnpm --filter @ebb-orchestrator/server test -- runs-dispatch.test.ts api.test.ts` — PASS; HTTP task dispatch preflights the project before `runService.prepareRun`, returns `409 ONBOARDING_NOT_ACTIVE`, and creates no AgentRun, phase or reservation; onboarding lifecycle and exact projection errors remain green.
- `pnpm --filter @ebb-orchestrator/server test -- run-event-handlers.test.ts` — PASS; `RuntimeEventHandlers.handleAgentRunRequested` blocks before both legacy dispatch and `prepareRun`, with zero `agent_runs`, `orchestration_phase_runs` and reservations for a draft.
- `pnpm --filter @ebb-orchestrator/server test -- epic-orchestrator.test.ts epic-orchestrator-integration.test.ts` — PASS; `approveAndRun`, `execute`, `runChild` and `runPhase` all guard integration, non-task and child paths before workspace/phase/workflow/run side effects.
- `pnpm --filter @ebb-orchestrator/server test -- scheduler-projection.test.ts` — PASS; Dashboard, Task, Project and Execution projections serialize the exact `BLOCK/ONBOARDING_NOT_ACTIVE` object and never place missing/PROPOSED onboarding in `runnables` or `waiting`.
- `pnpm --filter @ebb-orchestrator/server test -- scheduler-fixture-inventory.test.ts scheduler-migration.test.ts` — PASS; all 20 fixture files select an explicit mode, migrations `001`–`025` load in order, only the three named runtime INSERT sites are allowed, and `013`/`014` INSERT statements are counted only as immutable migration history.
- `pnpm --filter @ebb-orchestrator/web test -- features/dashboard-execution-onboarding.test.tsx core-views.test.tsx features/onboarding.test.tsx configuration-views.test.tsx` — PASS against canonical `scheduler`/`eligibility` DTOs and the exact blocked Russian message.
- `pnpm --filter @ebb-orchestrator/server typecheck && pnpm --filter @ebb-orchestrator/web build` — PASS.

**Depends on:** 15-01, 15-04 and 15-05. **Unblocks:** 15-07 and final end-to-end flow.