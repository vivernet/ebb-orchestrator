---
id: plan-02
kind: plan
roadmap: 01
stage: 02
status: completed
title: Plan Document
created: 2026-09-23
updated: 2026-09-23
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/6908acd
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/c18264e
  - apps/server/test/platform/scheduler/
---
# План реализации домена Orchestrator, Workflow, Scheduler и Recovery

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: Использовать superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации этого плана по задачам. Для отслеживания шаги используют синтаксис флажков (`- [ ]`).

**Цель:** Реализовать Project/Epic/Задача domain, approvals, state machine, FakeAgentRuntime, deterministic Scheduler и Recovery так, чтобы полный workflow прогонялся без LLM и Git.

**Архитектура:** Модули `work`, `workflow`, `scheduler`, `runtime`, `recovery` общаются только через public services/events. Scheduler создаёт `AgentRunRequested`, Runtime Manager исполняет его через port, Recovery возвращает новые run requests через Scheduler, а не вызывает runtime напрямую.

**Технологический стек:** TypeScript 7; Vitest 5; Zod 4; SQLite adapter из Plan 1.

**Спецификация:** `docs/architecture/specs/01-system-design.md`

## Глобальные ограничения

- Не добавлять Git/Hermes; использовать только `FakeAgentRuntime`.
- Display IDs project-local (`TASK-42`, `EPIC-3`), внутренние IDs opaque UUID/ULID.
- Dependency graph v1 поддерживает только `BLOCKING`.
- Состояние final merge недоступно без approval.
- Scheduler decisions должны быть объяснимы (`wait_reason`, `policy_ref`).
- Один active writer/run на Задача stage; duplicate durable events не создают duplicate runs.

---

### Задача 1: Domain IDs, Projects и Work entities

****Файлы:****
- Создать: `apps/server/src/modules/projects/project-types.ts`
- Создать: `apps/server/src/modules/projects/project-service.ts`
- Создать: `apps/server/src/modules/work/work-types.ts`
- Создать: `apps/server/src/modules/work/work-service.ts`
- Создать: `apps/server/src/modules/work/work-repository.ts`
- Создать: `apps/server/src/platform/database/migrations/002_work_domain.sql`
- Тест: `apps/server/test/modules/work/work-service.test.ts`

****Интерфейсы:****
- Создаёт: `Project`, `Epic`, `Task`, `TaskContract`, `TaskStatus`, `EpicStatus`.
- Создаёт: `WorkService.createStandaloneTask`, `createEpic`, `createEpicTask`, `archiveTask`.

- [ ] **Шаг 1: Написать тесты для IDs и инвариантов**

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

- [ ] **Шаг 2: Проверить, что тесты не проходят**

```bash
pnpm --filter @ebb-orchestrator/server test -- work-service.test.ts
```

- [ ] **Шаг 3: Реализовать сущности и миграцию**

Статусы Задача должны содержать ровно:

```ts
type TaskStatus =
  | "DRAFT" | "READY" | "DEVELOPMENT" | "REVIEW" | "QA"
  | "READY_FOR_INTEGRATION" | "INTEGRATION" | "INTEGRATED_INTO_EPIC"
  | "READY_FOR_MERGE" | "MERGING" | "DONE" | "RELEASED"
  | "BLOCKED" | "WAITING_FOR_DEPENDENCY" | "WAITING_FOR_APPROVAL"
  | "PAUSED" | "FAILED" | "CANCELLED";
```

Сохранять Задача Contract как версионированный структурированный JSON вместе с нормализованные поля, необходимыми для запросов.

- [ ] **Шаг 4: Запустить тесты и typecheck**

```bash
pnpm --filter @ebb-orchestrator/server test -- work-service.test.ts
pnpm typecheck
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/projects apps/server/src/modules/work apps/server/src/platform/database/migrations/002_work_domain.sql apps/server/test/modules/work
git commit -m "feat: add project epic and task domain"
```

---

### Задача 2: Dependencies, Proposals, Decisions и Approvals

****Файлы:****
- Создать: `apps/server/src/modules/work/dependency-service.ts`
- Создать: `apps/server/src/modules/work/proposal-service.ts`
- Создать: `apps/server/src/modules/work/decision-service.ts`
- Создать: `apps/server/src/modules/approvals/approval-types.ts`
- Создать: `apps/server/src/modules/approvals/approval-service.ts`
- Создать: `apps/server/src/platform/database/migrations/003_work_control.sql`
- Тест: `apps/server/test/modules/work/dependencies.test.ts`
- Тест: `apps/server/test/modules/approvals/approvals.test.ts`

****Интерфейсы:****
- Создаёт: `DependencyService.addBlockingDependency(taskId, dependsOnTaskId)`.
- Создаёт: Типы Proposal из спецификации.
- Создаёт: `ApprovalService.request/approve/reject/cancel`.

- [ ] **Шаг 1: Написать тесты циклов и дублирующихся approvals**

```ts
expect(() => deps.addBlockingDependency(a.id, a.id)).toThrow(/itself/i);
deps.addBlockingDependency(b.id, a.id);
expect(() => deps.addBlockingDependency(a.id, b.id)).toThrow(/cycle/i);
```

Approval должен иметь только один переход:

```ts
const approval = approvals.request({ type: "FINAL_MERGE", subjectId: task.id });
approvals.approve(approval.id, actor);
expect(() => approvals.approve(approval.id, actor)).toThrow(/already resolved/i);
```

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- dependencies.test.ts approvals.test.ts
```

- [ ] **Шаг 3: Реализовать проверки графа и аудируемые события approvals**

Типы Proposal:

```ts
"NEW_TASK" | "NEW_DEPENDENCY" | "REMOVE_DEPENDENCY" | "SCOPE_CHANGE" |
"REQUIREMENT_CHANGE" | "ACCEPTANCE_CRITERIA_CHANGE" | "GUIDELINE_CHANGE" |
"ARCHITECTURE_CHANGE" | "ROLE_CHANGE" | "WORKFLOW_CHANGE" | "PLAN_CHANGE"
```

Изменения состояния Approval добавляют `ApprovalRequested|ApprovalApproved|ApprovalRejected` в Outbox в ту же transaction.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- dependencies.test.ts approvals.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/work apps/server/src/modules/approvals apps/server/src/platform/database/migrations/003_work_control.sql apps/server/test/modules
git commit -m "feat: add dependencies proposals decisions and approvals"
```

---

### Задача 3: Шаблоны Workflow и state machine

****Файлы:****
- Создать: `apps/server/src/modules/workflow/workflow-types.ts`
- Создать: `apps/server/src/modules/workflow/workflow-registry.ts`
- Создать: `apps/server/src/modules/workflow/workflow-engine.ts`
- Создать: `apps/server/src/modules/workflow/templates.ts`
- Тест: `apps/server/test/modules/workflow/workflow-engine.test.ts`

****Интерфейсы:****
- Создаёт: `WorkflowEngine.canTransition`, `transition`, `currentStage`.
- Создаёт шаблоны: `standard`, `bugfix`, `architecture_change`, `documentation`, `devops`.

- [ ] **Шаг 1: Написать тесты таблицы переходов**

Должно быть доказано:

```text
READY → DEVELOPMENT allowed
DEVELOPMENT → QA denied
REVIEW + pass → QA allowed
Epic child cannot RELEASE before Epic release
INTEGRATED_INTO_EPIC requires successful IntegrationRun marker
READY_FOR_MERGE → MERGING requires resolved FINAL_MERGE approval
```

- [ ] **Шаг 2: Проверить отказы**

```bash
pnpm --filter @ebb-orchestrator/server test -- workflow-engine.test.ts
```

- [ ] **Шаг 3: Сначала реализовать чистые правила переходов**

Сохранять правила свободными от побочных эффектов:

```ts
export type TransitionContext = {
  hasSuccessfulIntegration: boolean;
  hasFinalMergeApproval: boolean;
  parentEpicReleased: boolean;
};
```

`transition()` транзакционно сохраняет состояние и outbox event `TaskStateChanged`.

- [ ] **Шаг 4: Запустить тесты, включая replay дублирующихся событий**

```bash
pnpm --filter @ebb-orchestrator/server test -- workflow-engine.test.ts outbox.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/workflow apps/server/test/modules/workflow
git commit -m "feat: add deterministic workflow engine"
```

---

### Задача 4: AgentRun model, Runtime port и FakeAgentRuntime

****Файлы:****
- Создать: `packages/contracts/src/agent-run.ts`
- Создать: `apps/server/src/modules/runtime/agent-runtime.ts`
- Создать: `apps/server/src/modules/runtime/run-types.ts`
- Создать: `apps/server/src/modules/runtime/run-service.ts`
- Создать: `packages/testing/src/fake-agent-runtime.ts`
- Создать: `apps/server/src/platform/database/migrations/004_agent_runs.sql`
- Тест: `apps/server/test/modules/runtime/run-service.test.ts`

****Интерфейсы:****
- Создаёт: `AgentRuntime.startRun/resumeRun/cancelRun/inspectRun/collectResult/collectUsage/healthCheck`.
- Создаёт: `FakeAgentRuntime.script(role, outcomes)`.

- [ ] **Шаг 1: Написать тест scripted runtime**

```ts
fake.script("developer_middle", [
  { kind: "failed", code: "TASK_FAILURE" },
  { kind: "completed", result: { outcome: "COMPLETED" } },
]);
```

Проверить, что первый Run завершается ошибкой, а второй успешно, с отдельными строками AgentRun и причинами trigger.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- run-service.test.ts
```

- [ ] **Шаг 3: Реализовать runtime port и персистентный AgentRun**

Записи AgentRun должны как минимум содержать:

```ts
role, runtime, model, taskId, epicId, status, sessionId, attempt,
triggerReason, contextVersion, outputSchemaVersion, startedAt, endedAt,
exitCode, inputTokens, cachedInputTokens, outputTokens, cost
```

Fake runtime не должен использовать sleep или сеть.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- run-service.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add packages/contracts packages/testing apps/server/src/modules/runtime apps/server/src/platform/database/migrations/004_agent_runs.sql apps/server/test/modules/runtime
git commit -m "feat: add runtime port and fake agent runtime"
```

---

### Задача 5: Scheduler eligibility, capacity и точные wait reasons

****Файлы:****
- Создать: `apps/server/src/modules/scheduler/scheduler-types.ts`
- Создать: `apps/server/src/modules/scheduler/scheduler-policy.ts`
- Создать: `apps/server/src/modules/scheduler/resource-lock-service.ts`
- Создать: `apps/server/src/modules/scheduler/scheduler-service.ts`
- Создать: `apps/server/src/platform/database/migrations/005_scheduler.sql`
- Тест: `apps/server/test/modules/scheduler/scheduler.test.ts`

****Интерфейсы:****
- Создаёт: `SchedulerService.recalculate(scope?)`.
- Создаёт: `Eligibility = RUNNABLE | WAIT(reason) | BLOCK(reason)`.
- Создаёт: `ResourceLockService.acquire/release/reconcileDeadOwners`.

- [ ] **Шаг 1: Написать тесты capacity/dependency**

Покрыть:

```text
global max 4
project max 3
reviewer max 1
dependency unresolved -> WAITING_FOR_DEPENDENCY
resource lock held -> WAIT RESOURCE_LOCK
budget placeholder guard -> WAIT BUDGET
approval pending -> WAIT APPROVAL
```

Также проверить Проверить, что Reviewer находится в очереди перед четвёртым новым Developer, когда слот reviewer свободен.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- scheduler.test.ts
```

- [ ] **Шаг 3: Реализовать детерминированный порядок**

Ключ порядка:

```text
1 integration/unblock
2 reviewer
3 QA
4 rework
5 new development
6 optional/docs
```

Затем явный приоритет `Critical > High > Normal > Low`, aging, simple downstream-blocked-count boost. Сохранять wait reason для UI projection.

- [ ] **Шаг 4: Запустить тесты scheduler дважды со случайным порядком вставки**

```bash
pnpm --filter @ebb-orchestrator/server test -- scheduler.test.ts --repeat=2
```

Ожидается: выбранные runs одинаковы независимо от порядка вставки.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/scheduler apps/server/src/platform/database/migrations/005_scheduler.sql apps/server/test/modules/scheduler
git commit -m "feat: add deterministic scheduler and resource locks"
```

---

### Задача 6: Оркестрация run между Workflow, Scheduler и Runtime

****Файлы:****
- Создать: `apps/server/src/modules/runtime/run-orchestrator.ts`
- Создать: `apps/server/src/modules/runtime/run-event-handlers.ts`
- Изменить: `apps/server/src/modules/scheduler/scheduler-service.ts`
- Тест: `apps/server/test/scenarios/standalone-task.fake-runtime.test.ts`

****Интерфейсы:****
- Потребляет: `AgentRunRequested`.
- Создаёт: `AgentRunStarted|Completed|Failed|Interrupted` и события стадий workflow.

- [ ] **Шаг 1: Написать полный сценарий standalone с fake runtime**

Script roles:

```text
Developer COMPLETED
Reviewer PASS
QA PASS
Integration PASS
```

Ожидается, что статус Задача завершится на `WAITING_FOR_APPROVAL` с ровно одним ожидающим `FINAL_MERGE` approval и без дублирующихся runs после воспроизведения всех durable events.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- standalone-task.fake-runtime.test.ts
```

- [ ] **Шаг 3: Реализовать обработчики событий**

Только domain services могут переводить стадии. Обработчик завершения Runtime проверяет текущую стадию workflow перед применением результата. `ApprovalApproved(FINAL_MERGE)` переводит Задача в `READY_FOR_MERGE`; фактический Git merge остаётся в будущем Plan 3.

- [ ] **Шаг 4: Запустить сценарий и проверить idempotency**

```bash
pnpm --filter @ebb-orchestrator/server test -- standalone-task.fake-runtime.test.ts outbox.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/runtime apps/server/src/modules/scheduler apps/server/test/scenarios
git commit -m "feat: orchestrate fake task workflow"
```

---

### Задача 7: Recovery rules, no-progress fingerprints и эскалация Middle→Senior

****Файлы:****
- Создать: `apps/server/src/modules/recovery/recovery-types.ts`
- Создать: `apps/server/src/modules/recovery/progress-fingerprint.ts`
- Создать: `apps/server/src/modules/recovery/recovery-policy.ts`
- Создать: `apps/server/src/modules/recovery/recovery-service.ts`
- Создать: `apps/server/src/platform/database/migrations/006_recovery.sql`
- Тест: `apps/server/test/modules/recovery/recovery.test.ts`

****Интерфейсы:****
- Создаёт: `RecoveryDecision = RESUME_SAME_SESSION | RETRY | ESCALATE_ROLE | COORDINATOR_DIAGNOSIS | BLOCK`.
- Создаёт: `ProgressFingerprint` из свидетельств, специфичных для стадии.

- [ ] **Шаг 1: Написать тесты лестницы recovery**

Случаи:

```text
Middle TASK_FAILURE #1 -> RESUME/RETRY Middle
Middle no progress #2 -> ESCALATE Senior
Senior exhausted -> COORDINATOR_DIAGNOSIS or BLOCK according to policy
TOOL_ERROR infrastructure -> retry, never role escalation solely for stronger model
same review finding 3 cycles -> loop detected
```

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- recovery.test.ts
```

- [ ] **Шаг 3: Реализовать policy с точными счётчиками**

Политика по умолчанию из спецификации:

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

Recovery создаёт новый scheduler request; он никогда не вызывает runtime напрямую.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- recovery.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/recovery apps/server/src/platform/database/migrations/006_recovery.sql apps/server/test/modules/recovery
git commit -m "feat: add deterministic recovery engine"
```

---

### Задача 8: Симуляция lifecycle дочерних элементов Epic на FakeAgentRuntime

****Файлы:****
- Создать: `apps/server/test/scenarios/epic.fake-runtime.test.ts`
- Изменить: `apps/server/src/modules/workflow/workflow-engine.ts`
- Изменить: `apps/server/src/modules/runtime/run-event-handlers.ts`

****Интерфейсы:****
- Новый public API не создаётся; доказывается, что существующие контракты поддерживают lifecycle Epic.

- [ ] **Шаг 1: Написать сценарий Epic**

Собрать:

```text
EPIC-1
├── TASK-1 required
├── TASK-2 required depends TASK-1
└── TASK-3 optional
```

Подменить результаты всех ролей. Проверить, что TASK-1 достигает `INTEGRATED_INTO_EPIC`, затем TASK-2 становится runnable, интеграция всех обязательных tasks запускает стадии Epic Review/QA, а дочерние Tasks становятся `RELEASED` только после маркера final Epic merge.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- epic.fake-runtime.test.ts
```

- [ ] **Шаг 3: Добавить только недостающие детерминированные переходы Epic**

Пока не добавлять семантику Coordinator/Architect. Рассматривать Epic Review/QA как типы scripted Run, обрабатываемые тем же Runtime port.

- [ ] **Шаг 4: Запустить полный набор тестов Plan 2**

```bash
pnpm typecheck
pnpm test
```

Ожидается: все workflow-сценарии проходят без Git и без AI.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/workflow apps/server/src/modules/runtime apps/server/test/scenarios
git commit -m "test: prove epic lifecycle with fake runtime"
```

## Plan 2 критерии приёмки

Одна команда тестов должна доказать всё перечисленное ниже без LLM/network:

```bash
pnpm test
```

- standalone Задача runs Dev → Review → QA → Integration → final approval;
- dependency graph blocks/unblocks correctly;
- дублирующиеся events не создают дублирующиеся Runs;
- pause/approval/resource lock/budget placeholders produce explicit wait reasons;
- сбои Middle приводят к эскалации до Senior только согласно policy;
- дочерние элементы Epic становятся `INTEGRATED_INTO_EPIC` и переходят в `RELEASED` только после release Epic.
