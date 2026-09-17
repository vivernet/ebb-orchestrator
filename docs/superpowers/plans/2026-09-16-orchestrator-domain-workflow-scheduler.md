# Orchestrator Domain, Workflow, Scheduler & Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать Project/Epic/Task domain, approvals, state machine, FakeAgentRuntime, deterministic Scheduler и Recovery так, чтобы полный workflow прогонялся без LLM и Git.

**Architecture:** Модули `work`, `workflow`, `scheduler`, `runtime`, `recovery` общаются только через public services/events. Scheduler создаёт `AgentRunRequested`, Runtime Manager исполняет его через port, Recovery возвращает новые run requests через Scheduler, а не вызывает runtime напрямую.

**Tech Stack:** TypeScript 7; Vitest 5; Zod 4; SQLite adapter из Plan 1.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`

## Global Constraints

- Не добавлять Git/Hermes; использовать только `FakeAgentRuntime`.
- Display IDs project-local (`TASK-42`, `EPIC-3`), внутренние IDs opaque UUID/ULID.
- Dependency graph v1 поддерживает только `BLOCKING`.
- Final merge state недоступен без approval.
- Scheduler decisions должны быть объяснимы (`wait_reason`, `policy_ref`).
- Один active writer/run на Task stage; duplicate durable events не создают duplicate runs.

---

### Task 1: Domain IDs, Projects and Work entities

**Files:**
- Create: `apps/server/src/modules/projects/project-types.ts`
- Create: `apps/server/src/modules/projects/project-service.ts`
- Create: `apps/server/src/modules/work/work-types.ts`
- Create: `apps/server/src/modules/work/work-service.ts`
- Create: `apps/server/src/modules/work/work-repository.ts`
- Create: `apps/server/src/platform/database/migrations/002_work_domain.sql`
- Test: `apps/server/test/modules/work/work-service.test.ts`

**Interfaces:**
- Produces: `Project`, `Epic`, `Task`, `TaskContract`, `TaskStatus`, `EpicStatus`.
- Produces: `WorkService.createStandaloneTask`, `createEpic`, `createEpicTask`, `archiveTask`.

- [ ] **Step 1: Write tests for IDs and invariants**

```ts
it("allocates project-local task numbers", () => {
  const a = work.createStandaloneTask(projectA.id, contract("A"));
  const b = work.createStandaloneTask(projectB.id, contract("B"));
  expect(a.displayId).toBe("TASK-1");
  expect(b.displayId).toBe("TASK-1");
});

it("does not allow a task to belong to two epics", () => {
  expect(() => work.attachTaskToEpic(task.id, epic2.id)).toThrow(/already belongs/i);
});
```

- [ ] **Step 2: Verify tests fail**

```bash
pnpm --filter @ebb-orchestrator/server test -- work-service.test.ts
```

- [ ] **Step 3: Implement entities and migration**

Task statuses must include exactly:

```ts
type TaskStatus =
  | "DRAFT" | "READY" | "DEVELOPMENT" | "REVIEW" | "QA"
  | "READY_FOR_INTEGRATION" | "INTEGRATION" | "INTEGRATED_INTO_EPIC"
  | "READY_FOR_MERGE" | "MERGING" | "DONE" | "RELEASED"
  | "BLOCKED" | "WAITING_FOR_DEPENDENCY" | "WAITING_FOR_APPROVAL"
  | "PAUSED" | "FAILED" | "CANCELLED";
```

Persist Task Contract as versioned structured JSON plus normalized fields required by queries.

- [ ] **Step 4: Run tests/typecheck**

```bash
pnpm --filter @ebb-orchestrator/server test -- work-service.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/projects apps/server/src/modules/work apps/server/src/platform/database/migrations/002_work_domain.sql apps/server/test/modules/work
git commit -m "feat: add project epic and task domain"
```

---

### Task 2: Dependencies, Proposals, Decisions and Approvals

**Files:**
- Create: `apps/server/src/modules/work/dependency-service.ts`
- Create: `apps/server/src/modules/work/proposal-service.ts`
- Create: `apps/server/src/modules/work/decision-service.ts`
- Create: `apps/server/src/modules/approvals/approval-types.ts`
- Create: `apps/server/src/modules/approvals/approval-service.ts`
- Create: `apps/server/src/platform/database/migrations/003_work_control.sql`
- Test: `apps/server/test/modules/work/dependencies.test.ts`
- Test: `apps/server/test/modules/approvals/approvals.test.ts`

**Interfaces:**
- Produces: `DependencyService.addBlockingDependency(taskId, dependsOnTaskId)`.
- Produces: Proposal types from spec.
- Produces: `ApprovalService.request/approve/reject/cancel`.

- [ ] **Step 1: Write cycle and duplicate approval tests**

```ts
expect(() => deps.addBlockingDependency(a.id, a.id)).toThrow(/itself/i);
deps.addBlockingDependency(b.id, a.id);
expect(() => deps.addBlockingDependency(a.id, b.id)).toThrow(/cycle/i);
```

Approval must be single-transition:

```ts
const approval = approvals.request({ type: "FINAL_MERGE", subjectId: task.id });
approvals.approve(approval.id, actor);
expect(() => approvals.approve(approval.id, actor)).toThrow(/already resolved/i);
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- dependencies.test.ts approvals.test.ts
```

- [ ] **Step 3: Implement graph checks and audited approval events**

Proposal types:

```ts
"NEW_TASK" | "NEW_DEPENDENCY" | "REMOVE_DEPENDENCY" | "SCOPE_CHANGE" |
"REQUIREMENT_CHANGE" | "ACCEPTANCE_CRITERIA_CHANGE" | "GUIDELINE_CHANGE" |
"ARCHITECTURE_CHANGE" | "ROLE_CHANGE" | "WORKFLOW_CHANGE" | "PLAN_CHANGE"
```

Approval state changes append `ApprovalRequested|ApprovalApproved|ApprovalRejected` to Outbox in the same transaction.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- dependencies.test.ts approvals.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/work apps/server/src/modules/approvals apps/server/src/platform/database/migrations/003_work_control.sql apps/server/test/modules
git commit -m "feat: add dependencies proposals decisions and approvals"
```

---

### Task 3: Workflow templates and state machine

**Files:**
- Create: `apps/server/src/modules/workflow/workflow-types.ts`
- Create: `apps/server/src/modules/workflow/workflow-registry.ts`
- Create: `apps/server/src/modules/workflow/workflow-engine.ts`
- Create: `apps/server/src/modules/workflow/templates.ts`
- Test: `apps/server/test/modules/workflow/workflow-engine.test.ts`

**Interfaces:**
- Produces: `WorkflowEngine.canTransition`, `transition`, `currentStage`.
- Produces templates: `standard`, `bugfix`, `architecture_change`, `documentation`, `devops`.

- [ ] **Step 1: Write transition table tests**

Must prove:

```text
READY → DEVELOPMENT allowed
DEVELOPMENT → QA denied
REVIEW + pass → QA allowed
Epic child cannot RELEASE before Epic release
INTEGRATED_INTO_EPIC requires successful IntegrationRun marker
READY_FOR_MERGE → MERGING requires resolved FINAL_MERGE approval
```

- [ ] **Step 2: Verify failures**

```bash
pnpm --filter @ebb-orchestrator/server test -- workflow-engine.test.ts
```

- [ ] **Step 3: Implement pure transition rules first**

Keep rules side-effect free:

```ts
export type TransitionContext = {
  hasSuccessfulIntegration: boolean;
  hasFinalMergeApproval: boolean;
  parentEpicReleased: boolean;
};
```

`transition()` persists state + `TaskStateChanged` outbox event transactionally.

- [ ] **Step 4: Run tests including duplicate event replay**

```bash
pnpm --filter @ebb-orchestrator/server test -- workflow-engine.test.ts outbox.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/workflow apps/server/test/modules/workflow
git commit -m "feat: add deterministic workflow engine"
```

---

### Task 4: AgentRun model, Runtime port and FakeAgentRuntime

**Files:**
- Create: `packages/contracts/src/agent-run.ts`
- Create: `apps/server/src/modules/runtime/agent-runtime.ts`
- Create: `apps/server/src/modules/runtime/run-types.ts`
- Create: `apps/server/src/modules/runtime/run-service.ts`
- Create: `packages/testing/src/fake-agent-runtime.ts`
- Create: `apps/server/src/platform/database/migrations/004_agent_runs.sql`
- Test: `apps/server/test/modules/runtime/run-service.test.ts`

**Interfaces:**
- Produces: `AgentRuntime.startRun/resumeRun/cancelRun/inspectRun/collectResult/collectUsage/healthCheck`.
- Produces: `FakeAgentRuntime.script(role, outcomes)`.

- [ ] **Step 1: Write scripted-runtime test**

```ts
fake.script("developer_middle", [
  { kind: "failed", code: "TASK_FAILURE" },
  { kind: "completed", result: { outcome: "COMPLETED" } },
]);
```

Assert first Run fails and second succeeds, with separate AgentRun rows and trigger reasons.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- run-service.test.ts
```

- [ ] **Step 3: Implement runtime port and persistent AgentRun**

AgentRun records at minimum:

```ts
role, runtime, model, taskId, epicId, status, sessionId, attempt,
triggerReason, contextVersion, outputSchemaVersion, startedAt, endedAt,
exitCode, inputTokens, cachedInputTokens, outputTokens, cost
```

Fake runtime must never sleep or use network.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- run-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/testing apps/server/src/modules/runtime apps/server/src/platform/database/migrations/004_agent_runs.sql apps/server/test/modules/runtime
git commit -m "feat: add runtime port and fake agent runtime"
```

---

### Task 5: Scheduler eligibility, capacity and exact wait reasons

**Files:**
- Create: `apps/server/src/modules/scheduler/scheduler-types.ts`
- Create: `apps/server/src/modules/scheduler/scheduler-policy.ts`
- Create: `apps/server/src/modules/scheduler/resource-lock-service.ts`
- Create: `apps/server/src/modules/scheduler/scheduler-service.ts`
- Create: `apps/server/src/platform/database/migrations/005_scheduler.sql`
- Test: `apps/server/test/modules/scheduler/scheduler.test.ts`

**Interfaces:**
- Produces: `SchedulerService.recalculate(scope?)`.
- Produces: `Eligibility = RUNNABLE | WAIT(reason) | BLOCK(reason)`.
- Produces: `ResourceLockService.acquire/release/reconcileDeadOwners`.

- [ ] **Step 1: Write capacity/dependency tests**

Cover:

```text
global max 4
project max 3
reviewer max 1
dependency unresolved -> WAITING_FOR_DEPENDENCY
resource lock held -> WAIT RESOURCE_LOCK
budget placeholder guard -> WAIT BUDGET
approval pending -> WAIT APPROVAL
```

Also verify Reviewer queued ahead of a fourth new Developer when reviewer slot is free.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- scheduler.test.ts
```

- [ ] **Step 3: Implement deterministic ordering**

Order key:

```text
1 integration/unblock
2 reviewer
3 QA
4 rework
5 new development
6 optional/docs
```

Then explicit priority `Critical > High > Normal > Low`, aging, simple downstream-blocked-count boost. Persist wait reason for UI projection.

- [ ] **Step 4: Run scheduler tests twice with randomized insertion order**

```bash
pnpm --filter @ebb-orchestrator/server test -- scheduler.test.ts --repeat=2
```

Expected: same selected runs regardless of insertion order.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/scheduler apps/server/src/platform/database/migrations/005_scheduler.sql apps/server/test/modules/scheduler
git commit -m "feat: add deterministic scheduler and resource locks"
```

---

### Task 6: Run orchestration between Workflow, Scheduler and Runtime

**Files:**
- Create: `apps/server/src/modules/runtime/run-orchestrator.ts`
- Create: `apps/server/src/modules/runtime/run-event-handlers.ts`
- Modify: `apps/server/src/modules/scheduler/scheduler-service.ts`
- Test: `apps/server/test/scenarios/standalone-task.fake-runtime.test.ts`

**Interfaces:**
- Consumes: `AgentRunRequested`.
- Produces: `AgentRunStarted|Completed|Failed|Interrupted` and workflow stage events.

- [ ] **Step 1: Write full fake standalone scenario**

Script roles:

```text
Developer COMPLETED
Reviewer PASS
QA PASS
Integration PASS
```

Expected Task status ends at `WAITING_FOR_APPROVAL` with exactly one pending `FINAL_MERGE` approval and no duplicate runs after replaying all durable events.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- standalone-task.fake-runtime.test.ts
```

- [ ] **Step 3: Implement event handlers**

Only domain services may transition stages. Runtime completion handler validates current workflow stage before applying outcome. `ApprovalApproved(FINAL_MERGE)` moves Task to `READY_FOR_MERGE`; actual Git merge remains future Plan 3.

- [ ] **Step 4: Run scenario + idempotency**

```bash
pnpm --filter @ebb-orchestrator/server test -- standalone-task.fake-runtime.test.ts outbox.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/runtime apps/server/src/modules/scheduler apps/server/test/scenarios
git commit -m "feat: orchestrate fake task workflow"
```

---

### Task 7: Recovery rules, no-progress fingerprints and Middle→Senior escalation

**Files:**
- Create: `apps/server/src/modules/recovery/recovery-types.ts`
- Create: `apps/server/src/modules/recovery/progress-fingerprint.ts`
- Create: `apps/server/src/modules/recovery/recovery-policy.ts`
- Create: `apps/server/src/modules/recovery/recovery-service.ts`
- Create: `apps/server/src/platform/database/migrations/006_recovery.sql`
- Test: `apps/server/test/modules/recovery/recovery.test.ts`

**Interfaces:**
- Produces: `RecoveryDecision = RESUME_SAME_SESSION | RETRY | ESCALATE_ROLE | COORDINATOR_DIAGNOSIS | BLOCK`.
- Produces: `ProgressFingerprint` from stage-specific evidence.

- [ ] **Step 1: Write recovery ladder tests**

Cases:

```text
Middle TASK_FAILURE #1 -> RESUME/RETRY Middle
Middle no progress #2 -> ESCALATE Senior
Senior exhausted -> COORDINATOR_DIAGNOSIS or BLOCK according to policy
TOOL_ERROR infrastructure -> retry, never role escalation solely for stronger model
same review finding 3 cycles -> loop detected
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- recovery.test.ts
```

- [ ] **Step 3: Implement policy with exact counters**

Default policy from spec:

```ts
{
  middleAttempts: 2,
  seniorAttempts: 2,
  maxReviewReworkCycles: 3,
  maxQaReworkCycles: 3,
  maxIntegrationResolutionAttempts: 2,
  maxConsecutiveNoProgressRuns: 2
}
```

Recovery creates a new scheduler request; it never calls runtime directly.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- recovery.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/recovery apps/server/src/platform/database/migrations/006_recovery.sql apps/server/test/modules/recovery
git commit -m "feat: add deterministic recovery engine"
```

---

### Task 8: Epic child lifecycle simulation on FakeAgentRuntime

**Files:**
- Create: `apps/server/test/scenarios/epic.fake-runtime.test.ts`
- Modify: `apps/server/src/modules/workflow/workflow-engine.ts`
- Modify: `apps/server/src/modules/runtime/run-event-handlers.ts`

**Interfaces:**
- Produces no new public API; proves existing contracts support Epic lifecycle.

- [ ] **Step 1: Write Epic scenario**

Build:

```text
EPIC-1
├── TASK-1 required
├── TASK-2 required depends TASK-1
└── TASK-3 optional
```

Fake all role outputs. Assert TASK-1 reaches `INTEGRATED_INTO_EPIC`, then TASK-2 becomes runnable, all required tasks integrated trigger Epic Review/QA stages, and child Tasks only become `RELEASED` after final Epic merge marker.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- epic.fake-runtime.test.ts
```

- [ ] **Step 3: Add only missing deterministic Epic transitions**

Do not add Coordinator/Architect semantics yet. Treat Epic Review/QA as scripted Run types handled by same Runtime port.

- [ ] **Step 4: Run full Plan 2 suite**

```bash
pnpm typecheck
pnpm test
```

Expected: all workflow scenarios pass with zero Git and zero AI.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/workflow apps/server/src/modules/runtime apps/server/test/scenarios
git commit -m "test: prove epic lifecycle with fake runtime"
```

## Plan 2 acceptance gate

A single test command must prove all of the following without LLM/network:

```bash
pnpm test
```

- standalone Task runs Dev → Review → QA → Integration → final approval;
- dependency graph blocks/unblocks correctly;
- duplicate events do not create duplicate Runs;
- pause/approval/resource lock/budget placeholders produce explicit wait reasons;
- Middle failures escalate to Senior only according to policy;
- Epic children become `INTEGRATED_INTO_EPIC` and only `RELEASED` after Epic release.
