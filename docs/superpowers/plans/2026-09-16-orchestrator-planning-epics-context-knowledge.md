# Orchestrator Planning, Epics, Context, Knowledge & Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить интеллектуальное планирование Coordinator/PM/Architect, полноценный Epic workflow, долгосрочную project knowledge, advanced Context Engine и иерархические usage/budget controls.

**Architecture:** Planning вызывает Hermes через тот же Runtime port, но model outputs всегда становятся candidate data и проходят deterministic validators/policies. Guidelines/Decisions живут versioned в repository и индексируются локально; Context Engine выбирает их структурно. Usage/Budget располагается перед Scheduler dispatch и резервирует бюджет атомарно.

**Tech Stack:** Existing Hermes runtime; Zod; SQLite; Markdown/YAML project knowledge; native Git.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`

## Global Constraints

- Coordinator не создаёт реальные Task/Epic IDs; только temporary refs.
- Planning approval defaults: standalone task false, multi-task plan true, epic true, architecture change true.
- Agent может предложить Guideline/Decision/Dependency/Task, но не активирует их напрямую.
- Long-term memory — DB + repository knowledge, не вечная Hermes session.
- Vector DB/RAG не входит в v1.
- Hard budget блокирует новые AI runs; soft budget создаёт approval, но не прерывает уже выполняющийся Run автоматически.

---

### Task 1: Coordinator, PM, Architect and DevOps contracts

**Files:**
- Create: `packages/contracts/src/roles/coordinator.ts`
- Create: `packages/contracts/src/roles/product-manager.ts`
- Create: `packages/contracts/src/roles/architect.ts`
- Create: `packages/contracts/src/roles/devops.ts`
- Modify: `apps/server/src/modules/runtime/output-validator.ts`
- Test: `apps/server/test/modules/runtime/planning-output-validator.test.ts`

**Interfaces:**
- Produces Coordinator operation schemas `CLASSIFY_REQUEST|PLAN|REPLAN|DIAGNOSE|ANALYZE_PROPOSAL`.
- Produces PM `ProductDefinition`, Architect `DesignResult`, DevOps `DevOpsOutput`.

- [ ] **Step 1: Write invalid-plan tests**

Reject:

```text
duplicate task refs
depends_on unknown ref
cyclic temporary dependency graph
unknown role/workflow
missing Task acceptance criteria
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- planning-output-validator.test.ts
```

- [ ] **Step 3: Implement role schemas + semantic checks**

Coordinator `recommended_*` fields remain recommendations; policy engine has final authority. Architect guideline output uses `ProposalCandidate`, not direct knowledge mutation.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- planning-output-validator.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/roles apps/server/src/modules/runtime/output-validator.ts apps/server/test/modules/runtime/planning-output-validator.test.ts
git commit -m "feat: add planning and design role contracts"
```

---

### Task 2: Planning service and approval policy

**Files:**
- Create: `apps/server/src/modules/planning/planning-types.ts`
- Create: `apps/server/src/modules/planning/planning-policy.ts`
- Create: `apps/server/src/modules/planning/plan-validator.ts`
- Create: `apps/server/src/modules/planning/planning-service.ts`
- Create: `apps/server/src/platform/database/migrations/009_planning.sql`
- Test: `apps/server/test/modules/planning/planning-service.test.ts`

**Interfaces:**
- Produces: `PlanningService.createRequest`, `classify`, `preparePlan`, `approvePlan`, `rejectPlan`.

- [ ] **Step 1: Write approval default tests**

Assert effective defaults:

```yaml
standalone_task: false
multi_task_plan: true
epic: true
architecture_change: true
```

A simple standalone Task may be materialized without planning approval; Epic plan remains pending until approval.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- planning-service.test.ts
```

- [ ] **Step 3: Implement temporary-ref materialization**

On approval, one transaction creates Epic/Tasks/dependencies and maps:

```text
task_1 → TASK-n
task_2 → TASK-n+1
```

Emit `PlanApproved` and domain creation events. No partial Task creation on validation/DB failure.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- planning-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/planning apps/server/src/platform/database/migrations/009_planning.sql apps/server/test/modules/planning
git commit -m "feat: add coordinator planning and approval flow"
```

---

### Task 3: Full Epic orchestration with PM/Architect and final validation

**Files:**
- Create: `apps/server/src/modules/planning/epic-orchestrator.ts`
- Modify: `apps/server/src/modules/runtime/run-event-handlers.ts`
- Modify: `apps/server/src/modules/workflow/workflow-engine.ts`
- Test: `apps/server/test/e2e/epic.fake-runtime.test.ts`

**Interfaces:**
- Produces sequence: plan → optional PM → optional Architect → child Tasks → Epic Review → Architecture Review when flagged → Epic QA → Integration → final approval.

- [ ] **Step 1: Write deterministic Epic E2E on FakeAgentRuntime**

Use three Tasks, two parallel after foundation. Assert required/optional semantics, child target is Epic branch, final required checks only start when required children integrated.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- epic.fake-runtime.test.ts
```

- [ ] **Step 3: Implement orchestration conditions**

Architecture Review runs only when `architecture_review_required` or accepted architecture-changing proposal exists. Child Task `RELEASED` transition occurs only after final Epic merge completion.

- [ ] **Step 4: Run test**

```bash
pnpm --filter @orchestrator/server test -- epic.fake-runtime.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/planning apps/server/src/modules/runtime/run-event-handlers.ts apps/server/src/modules/workflow apps/server/test/e2e/epic.fake-runtime.test.ts
git commit -m "feat: orchestrate full epic lifecycle"
```

---

### Task 4: Repository Guidelines and Decisions index/lifecycle

**Files:**
- Create: `apps/server/src/modules/knowledge/knowledge-types.ts`
- Create: `apps/server/src/modules/knowledge/guideline-parser.ts`
- Create: `apps/server/src/modules/knowledge/decision-parser.ts`
- Create: `apps/server/src/modules/knowledge/knowledge-service.ts`
- Create: `apps/server/src/platform/database/migrations/010_knowledge.sql`
- Test: `apps/server/test/modules/knowledge/knowledge-service.test.ts`

**Interfaces:**
- Produces stable IDs `GL-<CATEGORY>-nnn`, `DEC-nnnn` and states from spec.
- Produces `KnowledgeService.indexRepository`, `applyApprovedProposal`, `activeForScope`.

- [ ] **Step 1: Write parse/version/supersede tests**

Assert active current guideline only is returned, superseded versions remain historical, broken `superseded_by` and duplicate IDs fail validation.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- knowledge-service.test.ts
```

- [ ] **Step 3: Implement Markdown metadata parser + DB index**

Keep canonical text in repository Markdown; DB stores searchable metadata/version/hash/provenance. External semantic change becomes `PENDING_EXTERNAL_CHANGE`, not automatically active.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- knowledge-service.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/knowledge apps/server/src/platform/database/migrations/010_knowledge.sql apps/server/test/modules/knowledge
git commit -m "feat: index project guidelines and decisions"
```

---

### Task 5: Knowledge proposal duplicate/conflict narrowing and Git commit path

**Files:**
- Create: `apps/server/src/modules/knowledge/knowledge-analyzer.ts`
- Create: `apps/server/src/modules/knowledge/knowledge-git-service.ts`
- Test: `apps/server/test/modules/knowledge/knowledge-analyzer.test.ts`

**Interfaces:**
- Produces classifications `NEW|DUPLICATE|CLARIFICATION|EXTENSION|CONFLICT|REPLACEMENT`.

- [ ] **Step 1: Write deterministic candidate selection tests**

New database guideline is compared only against active database/overlapping scope candidates. Exact normalized duplicate returns `DUPLICATE` without AgentRun request.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- knowledge-analyzer.test.ts
```

- [ ] **Step 3: Implement candidate narrowing and approved commit**

Formatting/whitespace-only changes classify editorial deterministically. Potential semantic conflicts create a targeted Architect analysis Run containing only candidate subset. Approved change is written atomically and committed as a separate managed Git commit, e.g. `orchestrator: update guideline GL-ARCH-014`.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- knowledge-analyzer.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/knowledge apps/server/test/modules/knowledge/knowledge-analyzer.test.ts
git commit -m "feat: validate and apply knowledge proposals"
```

---

### Task 6: Advanced Context Engine, manifests and resume deltas

**Files:**
- Create: `apps/server/src/modules/context/context-selector.ts`
- Create: `apps/server/src/modules/context/context-budget.ts`
- Create: `apps/server/src/modules/context/context-delta.ts`
- Create: `apps/server/src/platform/database/migrations/011_context.sql`
- Modify: `apps/server/src/modules/context/context-builder.ts`
- Test: `apps/server/test/modules/context/context-selection.test.ts`

**Interfaces:**
- Produces `P0|P1|P2|P3` items, `ContextManifest`, `ContextDelta`.

- [ ] **Step 1: Write selection/pruning tests**

For provider Task include matching provider/architecture guideline and Epic decision; exclude database guideline, resolved finding, superseded decision. Over-budget pruning removes P3 then compacts/removes P2 but never P0.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- context-selection.test.ts
```

- [ ] **Step 3: Implement structural selection**

Relevance uses scope/area/path/role/tags. Resume delta reports `NEW|UPDATED|REMOVED`; material Task Contract change may return `RESUME_NOT_SAFE` requiring fresh session. No embedding/vector service.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- context-selection.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/context apps/server/src/platform/database/migrations/011_context.sql apps/server/test/modules/context
git commit -m "feat: add scoped context selection and deltas"
```

---

### Task 7: Usage records, pricing catalog and budget reservations

**Files:**
- Create: `apps/server/src/modules/usage/usage-types.ts`
- Create: `apps/server/src/modules/usage/usage-service.ts`
- Create: `apps/server/src/modules/usage/budget-service.ts`
- Create: `apps/server/src/modules/usage/pricing-catalog.ts`
- Create: `apps/server/src/platform/database/migrations/012_usage.sql`
- Test: `apps/server/test/modules/usage/budget-service.test.ts`

**Interfaces:**
- Produces: `BudgetDecision = ALLOW|ASK|DENY`.
- Produces atomic `reserve(runEstimate)` and `reconcile(runActual)`.

- [ ] **Step 1: Write parallel reservation tests**

Remaining budget `$5`; three concurrent `$2` reservations. Assert only two acquire capacity and third is `ASK` or `DENY` according to soft/hard policy; no oversubscription race.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @orchestrator/server test -- budget-service.test.ts
```

- [ ] **Step 3: Implement hierarchical budget resolution**

Scopes: global/project/epic/task, effective most restrictive available limit. Estimate from rolling historical p90 by role/model with safety floor. Persist trigger reason and recovery/rework category.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @orchestrator/server test -- budget-service.test.ts scheduler.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/usage apps/server/src/platform/database/migrations/012_usage.sql apps/server/test/modules/usage
git commit -m "feat: add usage accounting and budget reservations"
```

---

### Task 8: Real Hermes Request → Epic acceptance scenario

**Files:**
- Create: `apps/server/test/e2e/request-to-epic.hermes.test.ts`
- Reuse: `apps/server/test/e2e/fixtures/health-service/` or add a larger provider-style fixture.

**Interfaces:**
- Proves all nine role contracts are usable; only roles needed by scenario are invoked.

- [ ] **Step 1: Define request and expected structural assertions**

Use a request that necessarily needs 2–3 dependent Tasks. Test asserts Coordinator returns an Epic, plan approval is created, temporary refs validate, and no work starts before approval.

- [ ] **Step 2: Run once to expose integration gaps**

```bash
RUN_HERMES_E2E=1 pnpm --filter @orchestrator/server test -- request-to-epic.hermes.test.ts
```

- [ ] **Step 3: Complete wiring without relaxing policy**

After approval, Tasks run according to dependencies and concurrency. Architecture/PM roles run only when chosen by approved workflow. Final Epic merge still requires explicit approval.

- [ ] **Step 4: Verify restart resilience mid-Epic**

Test harness kills/restarts backend after at least one child integration; startup reconciliation resumes remaining work without duplicate Task/Run/merge.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/e2e apps/server/src
git commit -m "feat: complete request to epic orchestration"
```

## Plan 5 acceptance gate

- Coordinator plan output cannot bypass validation or planning approval policy.
- Epic workflow survives backend restart.
- Context manifest proves exactly which guideline/decision/contract versions each Run saw.
- New semantic Guideline changes require approval; exact duplicates cost zero LLM calls.
- Budget reservation prevents parallel overspend.
- No vector DB or eternal project Hermes session exists.
