---
id: plan-02
kind: plan
status: in_progress
title: План реализации домена Orchestrator, Workflow, Scheduler и Recovery
created: 2026-09-23
updated: 2026-10-03
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/6908acd
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/c18264e
  - apps/server/test/modules/scheduler/
---
# План реализации домена Orchestrator, Workflow, Scheduler и Recovery

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`. План выполняется по задачам; для отслеживания шагов используется синтаксис флажков (`- [ ]`).

**Цель:** Реализовать Project/Epic/Задача domain, approvals, state machine, FakeAgentRuntime, deterministic Scheduler и Recovery так, чтобы полный workflow прогонялся без LLM и Git.

**Архитектура:** Модули `work`, `workflow`, `scheduler`, `runtime`, `recovery` общаются только через public services/events. Пользовательский Task dispatch сначала сохраняется как durable `SchedulerRunRequest` (`taskId`, выбранные `role`/`model`, стабильный caller idempotency key); Scheduler арбитрирует именно эти requests и только для выбранного запроса в одной SQLite transaction подготавливает Run/manifest, резервирует capacity и создаёт outbox `AgentRunRequested`. Task Recovery создаёт новую попытку через тот же API. Все Epic phase runs (в том числе связанные с Task) и Request-planning runs остаются в своих persisted phase/job lifecycle и не входят в пользовательский Task-dispatch queue. Runtime Manager исполняет уже подготовленный Run через port.

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
- Изменить: `apps/server/src/modules/scheduler/scheduler-types.ts`, `scheduler-policy.ts`, `scheduler-service.ts`.
- Сохранить поведение `apps/server/src/modules/scheduler/resource-lock-service.ts` и точные `wait_reason` для UI projection.
- Создать additive forward migration для nullable `tasks.capacity_wait_started_at`; на schema head `039` это `apps/server/src/platform/database/migrations/040_scheduler_capacity_wait_started_at.sql`. Перед реализацией повторно проверить migration head и выбрать следующий номер.
- Не редактировать уже применённые `002_work_domain.sql`, `003_work_control.sql` и `005_scheduler.sql`.
- Изменить тесты: `apps/server/test/modules/scheduler/scheduler.test.ts`, `apps/server/test/platform/database/context-manifest-migration.test.ts`, `apps/server/test/platform/database/fresh-install-migrations.acceptance.test.ts`.
- Изменить/создать migration acceptance: `apps/server/test/platform/database/scheduler-migration.test.ts`.

****Интерфейсы:****
- Обновляет порядок выдачи из существующего read-only `SchedulerService.recalculate(scope?)` согласно `spec-01 §8.1`.
- Расширяет существующий `SchedulerService.reconcile()` как единственного owner всех start/preserve/reset writes `capacity_wait_started_at`; startup reconciliation и `SchedulerSafetyWorker` safety tick вызывают этот метод. Production event-driven queue path пока не подключён: после его wiring в Task6 он обязан вызывать `reconcile()` до ordered selection/dispatch. Source inspection показывает, что `startWorkflowRuns()` — единственный queue sort→dispatch method, но production caller у него нет.
- Успешные dispatch transaction имеют только узкое право очистки timestamp: `SchedulerService.dispatchRunRequest()` для пользовательской Task queue и `SchedulerService.dispatchTask()` для существующего persisted Epic phase flow очищают его только вместе с commit reservation и workflow state transition. После Task6 `dispatchTask()` остаётся только Epic phase path; пользовательские Task route и Recovery используют исключительно durable RunRequest API. Ни один caller/query API не записывает поле напрямую.
- Сохраняет существующие `Eligibility = RUNNABLE | WAIT(reason) | BLOCK(reason)`, `ResourceLockService.acquire/release/reconcileDeadOwners` и exact `wait_reason` semantics.

### Acceptance matrix (согласовать и покрыть RED-тестами до реализации)

| Область | Проверяемые случаи | Ожидаемый результат |
|---|---|---|
| Категория | Задачи разных категорий; задача более поздней категории имеет максимальный priority/path | Всегда выбирается более ранняя категория; aging/path её не обходят |
| Aging thresholds | Через injected clock проверить каждую базовую ступень за 1 ms до полного порога, ровно на пороге `86_400_000` ms, через 2/3 полных суток и после cap; отдельно future и malformed timestamps | +1 enum level только на точной границе полных 24h, частичный/future interval не повышает, максимум `Critical`; malformed value диагностируется и запрещает dispatch |
| Gate eligibility | Dependency, approval, budget, resource-lock, pause/workflow gate; затем только global, project или role capacity | Non-capacity ожидание не стареет; отсчёт начинается при первой eligible-capacity observation |
| Capacity + budget одновременно | Заполнить capacity и закрыть budget; затем открыть только budget, оставив capacity занятой | Даже если `wait_reason` сообщает capacity раньше budget, независимая gate-проверка удерживает timestamp `NULL`; после budget pass timestamp начинает возраст с нового injected UTC instant |
| Durable/restart | Сохранить начало ожидания, перезапустить process, продолжить с контролируемым UTC clock | Возраст вычисляется от сохранённого timestamp; process-local state и `created_at` не используются |
| Read-only/write owner | Вызвать `recalculate()`, `getEligibility()`, `getWaitReason()` и внешние route/runtime/planning query paths | Query/external paths не мутируют поле; start/preserve/reset делает только `SchedulerService.reconcile()`, кроме atomic dispatch clear |
| Reset/preservation | Переключить capacity reason; затем добавить non-capacity gate, снять его, снова дождаться capacity; наконец dispatch | Capacity reason switch сохраняет время; non-capacity gate/reset очищает; новое ожидание получает новый timestamp; успешный dispatch очищает его вместе с reservation/state commit |
| Legacy `NULL` | Existing task без wait-start evidence впервые наблюдается eligible и ждёт capacity | Остаётся `NULL` до observation, затем получает текущее UTC-время; исторический возраст не backfill-ится |
| Priority/path ordering | Одинаковая категория: разные aged priorities и разные critical-path lengths | Priority сравнивается раньше пути; path влияет только при равном aged priority и не суммируется с ним |
| Branching/path length | Один prerequisite с несколькими ветвями разной длины; unfinished blocking chain; повторить с изменённым `contract_json` | Выбирается самая длинная ветвь по `dependencies`; считаются vertices включая candidate, по 1 на задачу; `contract_json` не влияет |
| Missing/terminal path | Изолированная leaf candidate; terminal node между unfinished tasks; попытка добавить dependency с отсутствующим endpoint | Leaf path length равна `1`; terminal node исключён и не соединяет цепочку; FK отклоняет missing endpoint, `foreign_key_check` пуст |
| Cycles | DependencyService попыткой вставить цикл; также тестовая corrupt persisted graph | Запись цикла отклонена; обнаруженный persisted cycle даёт диагностируемую graph-integrity error, и данный reconciliation cycle ничего не dispatch-ит без изменения Task status |
| Deterministic ties | Равны category, aged priority и path; равные candidate timestamps/ветви; сравнить две equivalent fixtures с противоположным порядком вставки | Tie-break `created_at`, затем ordinal `id`; выбранный порядок не зависит от insertion order |
| Migration compatibility | Empty DB и populated upgrade 039→040 с существующими `context_deltas` rows | Миграция только добавляет nullable `tasks.capacity_wait_started_at`; значения старых задач остаются `NULL`, raw `context_deltas` rows/values и table SQL/columns/indexes не меняются; сохраняются `manifest_id ON DELETE CASCADE` и `previous_manifest_id ON DELETE SET NULL`, `PRAGMA foreign_key_check` пуст |

Migration-specific test boundaries:

- `scheduler-migration.test.ts` добавляет отдельный populated 039→040 upgrade case. Перед 040 сохранить число строк и каждую колонку каждой строки `context_deltas`, включая SQLite `typeof` и byte representation (`hex(CAST(text_column AS BLOB))` для каждого TEXT value); также сохранить `sqlite_master.sql`, `PRAGMA table_info`, `PRAGMA index_list` и `PRAGMA index_xinfo` для `context_deltas` и `context_manifests`, плюс все поля `PRAGMA foreign_key_list` у `context_deltas`. После 040 проверить побайтовое/построчное совпадение, неизменность SQL/columns/indexes обеих context tables, `manifest_id ON DELETE CASCADE`, `previous_manifest_id ON DELETE SET NULL`, ровно одну новую nullable `TEXT` колонку `tasks.capacity_wait_started_at` и пустой `PRAGMA foreign_key_check`.
- `context-manifest-migration.test.ts` остаётся проверкой исходного диапазона 001–039. Ограничить fixture/catalog через `loadTestMigrations().filter(migration => migration.version <= 39)` и оставить assertion последовательности 1..39 и migration 039; новая 040 не должна расширять этот тест.
- `fresh-install-migrations.acceptance.test.ts` обновляет каталог/ожидания на последовательность 001–040 (40 migrations) и проверяет, что новая установка содержит nullable `TEXT` поле `tasks.capacity_wait_started_at` и проходит `PRAGMA foreign_key_check`.
- Migration 040 должна содержать только additive `ALTER TABLE tasks ADD COLUMN capacity_wait_started_at TEXT` (nullable); старые migration files и context tables не перестраиваются.

- [ ] **Шаг 1: Написать RED-тесты eligibility, durable aging, graph scoring и migration**

До реализации добавить новые assertions в указанные suites. Scheduler тесты должны покрыть:

```text
global max 4
project max 3
reviewer max 1
dependency unresolved -> WAITING_FOR_DEPENDENCY
resource lock held -> WAIT RESOURCE_LOCK
budget placeholder guard -> WAIT BUDGET
approval pending -> WAIT APPROVAL
```

Также проверить, что Reviewer находится в очереди перед четвёртым новым Developer, когда слот reviewer свободен.

Дополнительно до production-кода написать регрессии для thresholds `23:59:59.999`/`24:00:00.000`, 48h/72h/cap, строгого category order, aging только после non-capacity gates, сохранения/reset across capacity reasons, process restart, read-only queries, длиннейшего branching path/terminal leaves/cycle, insertion-order ties и legacy NULL. Детерминизм проверяется в одной тестовой процедуре на двух эквивалентных fixtures, записанных в противоположном порядке; они должны дать одинаковую ordered task ID sequence и reservations. Migration suite должна до миграции доказывать ожидаемое nullable поле, empty install через 001–040 и populated upgrade 039→040 с сохранением `context_deltas` rows, table SQL/columns/indexes, обоих FK delete actions и `PRAGMA foreign_key_check`. В `context-manifest-migration.test.ts` ограничить именно historical regression catalog миграциями 001–039, чтобы она по-прежнему проверяла переход 039 без случайного захвата новых будущих migrations.

Отдельная RED-регрессия должна создать ситуацию, где одновременно исчерпана global/project/role capacity и недоступен budget. Текущий `evaluateEligibilityTx()` может первым вернуть capacity `wait_reason`, но `reconcile()` обязан независимо проверить все non-capacity gates: timestamp остаётся `NULL` и не стареет до прохождения budget; если capacity всё ещё занята, стартовое время берётся из нового injected clock observation после снятия budget.

- [ ] **Шаг 2: Подтвердить ожидаемый RED на новых проверках**

```bash
pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/scheduler/scheduler.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/scheduler-migration.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/context-manifest-migration.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/fresh-install-migrations.acceptance.test.ts
```

Ожидается: новые policy assertions и проверка migration 040 падают на отсутствующем поле/поведении; ранее существовавшая migration-039 regression в своей ограниченной цепочке остаётся зелёной. Не использовать `skip`, ослабление assertions или искусственный fail.

- [ ] **Шаг 3: Реализовать durable wait tracking и scoring по spec-01 §8.1**

Порядок строго лексикографический; более ранний ключ никогда не обходится последующим:

```text
1. category: integration/unblock > reviewer > QA > rework > new development > optional/docs
2. aged priority: Critical > High > Normal > Low
3. critical-path length descending, only if aged priority is equal
4. created_at ascending
5. task id ascending (ordinal)
```

Категория остаётся абсолютным первым ключом: aging и путь не могут поднять задачу через границу категории. Aged priority рассчитывается из базового ранга `Low=0`, `Normal=1`, `High=2`, `Critical=3` и durable UTC `capacity_wait_started_at`: `min(3, baseRank + max(0, floor((nowEpochMs - startedAtEpochMs) / 86_400_000)))`. Scheduler использует injected authoritative UTC clock; timestamp хранится канонически в ISO-8601 `YYYY-MM-DDTHH:mm:ss.sssZ`, для сравнения парсится в epoch milliseconds. Ровно `86_400_000` ms дают первый шаг; до точной границы шаг не начисляется. Будущий timestamp временно даёт возраст `0`; некорректный persisted timestamp даёт диагностируемую integrity error и запрещает dispatch без silent fallback.

Aging начинается только после прохождения всех non-capacity gates и первой свежей eligible-capacity observation; `created_at` не заменяет неизвестный wait timestamp. Значение сохраняется при смене global/project/role capacity reason и сбрасывается при non-capacity gate. `reconcile()` проверяет каждый non-capacity gate независимо, не делая вывод по единственному `wait_reason`: если capacity заполнена одновременно с budget gate, timestamp остаётся `NULL`; только после budget pass при всё ещё заполненной capacity injected clock фиксирует новое начало ожидания. Если все gates пройдены и capacity доступна, сохранённый aged priority участвует в ordered selection; `dispatchRunRequest()` очищает timestamp вместе с успешной reservation/state transition для выбранного пользовательского request. Существующий persisted Epic phase dispatch через `dispatchTask()` имеет только такое же атомарное cleanup-исключение при успешном commit; он не создаёт и не арбитрирует пользовательский RunRequest. Старые строки с `NULL` начинают отсчёт лишь при первой подходящей observation; restart не сбрасывает возраст.

Все start/preserve/reset updates выполняются в существующей `SchedulerService.reconcile()` transaction из единой durable DB snapshot и одного injected UTC instant; ошибка посреди transaction не оставляет частичную wait-state запись, повторный вызов идемпотентен. `reconcile()` вызывается при startup и existing periodic `SchedulerSafetyWorker`; event-driven queue path обязан вызывать его до сортировки/dispatch. Source inspection показывает, что `startWorkflowRuns()` содержит сортировку и batch dispatch, но не имеет production caller; подключение production queue path — отдельное требование Plan02 Task6. `recalculate()`, `getEligibility()` и `getWaitReason()` остаются read-only. В production текущие direct `dispatchTask()` callers в routes, runtime event handler и Epic orchestrator не пишут поле напрямую. `dispatchTask()` выполняет только узкую атомарную очистку после успешного reservation/state commit.

После выполнения Task6 единственным атомарным dispatch path для пользовательских Task requests становится `SchedulerService.dispatchRunRequest()`; существующие targeted Task route и Recovery callers передают durable request. `SchedulerService.dispatchTask()` остаётся только для persisted Epic phase intents и может атомарно очистить timestamp лишь при успешном commit; ни один caller напрямую не пишет поле.

Critical path считается по нормализованной таблице `dependencies`, а не по `contract_json`. Forward edge направлен от `depends_on_task_id` prerequisite к `task_id` dependent. Длина — число unfinished `BLOCKING` vertices в максимальной forward-chain, включая candidate task; один vertex даёт одну единицу. Считаются только незавершённые статусы Work domain; terminal `DONE`, `RELEASED`, `INTEGRATED_INTO_EPIC`, `CANCELLED`, `FAILED` не входят в путь и не соединяют его части. Лист имеет длину `1`. При равных ветвях выбор пути детерминируется лексикографической последовательностью `created_at` по возрастанию, затем `id` в ordinal-порядке; это же tie-break очереди после равного category, aged priority и path length. DependencyService отклоняет новые циклы. Обнаруженный persisted cycle выдаёт диагностируемую graph-integrity error и запрещает dispatch в данном reconciliation cycle без silent fallback или нового Task status. Missing endpoint отклоняется FK.

Поле ожидания хранится в отдельной additive migration. Migration/upgrade acceptance обязан сохранить существующие строки `context_deltas` и их FK-семантику (`manifest_id ON DELETE CASCADE`, `previous_manifest_id ON DELETE SET NULL`); никакие уже применённые migrations не переписываются. Новая схема проверяется на empty DB и при upgrade populated DB, затем выполняется `foreign_key_check`.

- [ ] **Шаг 4: Проверить acceptance matrix выше после GREEN**

- [ ] **Шаг 5: Запустить focused Scheduler и migration acceptance suites**

```bash
pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/scheduler/scheduler.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/scheduler-migration.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/context-manifest-migration.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/fresh-install-migrations.acceptance.test.ts
```

Ожидается: все четыре suites завершаются с exit `0`; `context-manifest-migration.test.ts` по-прежнему доказывает migration 039 в ограниченной цепочке 001–039; новая migration suite доказывает 039→040 populated upgrade и неизменность `context_deltas`; fresh install заканчивается на 040. Scheduler suite сравнивает противоположные insertion-order fixtures и получает идентичные ordered task IDs/reservations.

- [ ] **Шаг 6: Коммит**

```bash
git add apps/server/src/modules/scheduler apps/server/src/platform/database/migrations/040_scheduler_capacity_wait_started_at.sql apps/server/test/modules/scheduler apps/server/test/platform/database
git commit -m "feat: добавить детерминированный scheduler и блокировки ресурсов"
```

---

### Задача 6: Оркестрация run между Workflow, Scheduler и Runtime

****Файлы:****
- Создать: `apps/server/src/modules/runtime/run-orchestrator.ts`
- Создать: `apps/server/src/modules/runtime/run-event-handlers.ts`
- Создать additive migration `041_scheduler_run_requests.sql` после migration 040 из Task5: таблица durable Task-bound requests с opaque ID, обязательными `task_id`, `idempotency_key`, исходными `role`/`model`, typed origin/trigger reference, status (`PENDING`, `DISPATCHED`, `FAILED`), created/updated timestamps, nullable `run_id` и nullable stable `failure_code`; добавить unique index на `idempotency_key` во всех status и unique partial index на один `PENDING` request per Task. Перед реализацией проверить schema head и выбрать следующий номер; не переписывать migrations и не трогать `context_deltas`/`context_manifests`.
- Изменить: `apps/server/src/modules/scheduler/scheduler-service.ts`, `apps/server/src/modules/recovery/recovery-service.ts`, `apps/server/src/modules/runtime/run-service.ts`, `apps/server/src/platform/events/event-dispatcher.ts`, `apps/server/src/platform/home/production-composition.ts` и `apps/server/src/main.ts` для durable queue producer/worker startup, event nudge, READY-gated event delivery и safety-tick recovery.
- Перевести production Task dispatch caller `apps/server/src/app/routes/runs.ts`, его Runtime handoff `apps/server/src/modules/runtime/run-event-handlers.ts` и Task Recovery на public Scheduler request API. `/tasks/:id/dispatch` требует `Idempotency-Key`; Recovery создаёт отдельную новую Task попытку с новым source attempt key. Все Epic phase runs, включая child phases с `task_id`, и Request planning не переводить в пользовательскую Task очередь; сохранить их текущие persisted phase/job intents и собственный lifecycle.
- Изменить `apps/server/test/scenarios/standalone-task.fake-runtime.test.ts` и `apps/server/test/platform/events/event-dispatcher.test.ts`; создать/изменить scheduler request, recovery, API и `apps/server/test/platform/database/scheduler-run-request-migration.test.ts` acceptance suites.
- `scheduler-run-request-migration.test.ts` проверяет populated upgrade 040→041, поля/status constraint, unique partial index, FK/delete actions, старые task rows и `foreign_key_check`; `fresh-install-migrations.acceptance.test.ts` проверяет empty install 001–041. `context-manifest-migration.test.ts` остаётся ограничен historical 001–039, а `scheduler-migration.test.ts` по-прежнему покрывает 039→040.

****Интерфейсы:****
- Создаёт durable Task-bound `SchedulerRunRequest` с оригинальными `taskId`, выбранными `role`/`model`, stable `idempotency_key` и source-backed caller reference. Глобальный unique index сохраняет idempotency key навсегда; unique partial index разрешает не более одного активного `PENDING` request на Task. Повтор с тем же ключом и теми же полями во всех состояниях возвращает прежний request/status/`run_id`; тот же ключ с другим payload получает stable conflict. Новая намеренная попытка получает новый ключ. Другой concurrent key для Task с уже активным PENDING получает `RUN_REQUEST_ALREADY_PENDING`.
- При принятии команды API возвращает `202 Accepted` с `requestId` и status `PENDING`; `GET /api/v1/tasks/:taskId/dispatch-requests/:requestId` читает тот же durable request/status после restart. Capacity/priority wait возвращается как обычный pending projection, не как exception.
- `SchedulerRunRequest` остаётся в `PENDING`, пока lifecycle не `READY`, его Task не станет допустимым кандидатом и request не победит общую selection. В `RECOVERING` queue worker только сохраняет wake-up и не пишет Run/manifest/reservation. `EventDispatcher` получает `canDeliver(event)` readiness policy от production composition до вызова подписчиков. Для `AgentRunRequested` при статусе не `READY` он возвращает отдельный `deferred` disposition: не вызывает consumer, не меняет `attempts`, `available_at`, `last_error` или dead-letter state и продолжает batch с другими событиями. Это не обычный успешный возврат handler и не exception. После READY startup scan, event nudge от Task/Recovery/reservation changes и existing periodic safety tick повторно вызывают queue worker; следующий outbox drain доставляет оставшееся событие. Единственное recovery исключение из общего запрета dispatch до READY — возобновление ранее approved Epic по Proposal 06: это существующий persisted phase flow, после всех reconciliations, вне пользовательской Task очереди и не изменяется Task6.
- Queue worker читает актуальные Task gates и выбирает все schedulable pending requests по `spec-01 §8.1`. Сначала проверяет все non-capacity gates независимо от первого `wait_reason`; capacity-wait timestamp ведётся в Task5. Запрос с закрытым non-capacity gate не стареет.
- Worker может заранее собрать только in-memory `PreparedRunContext` кандидата; это не создаёт Run/manifest. В одной SQLite write transaction `SchedulerService.dispatchRunRequest()` повторно проверяет gates и ordered winner, затем `RunService.prepareRunInTransaction(...)` сверяет `PreparedRunContext` с текущей transaction snapshot и только после совпадения сохраняет Run+ContextManifest. Далее та же transaction делает reservation, Workflow state transition, `PENDING → DISPATCHED` claim, сохраняет `run_id` и вставляет outbox `AgentRunRequested`. Run/manifest создаются после выбора winner и до reservation/event dispatch; внешне виден только полный commit. Смена ordering/input откатывает всю операцию; низкоранговые и capacity-waiting requests не создают Run или reservation.
- Одновременные queue workers сериализуются на той же SQLite write transaction и conditional claim; повторный event/worker проход не создаёт второй Run. Ошибка до commit откатывает Run, manifest, reservation, request claim, workflow state и outbox целиком. Некорректная команда отклоняется до persistence; детерминированная integrity failure после enqueue переводит request в terminal `FAILED` с безопасным `failure_code`, transient database/process error оставляет его `PENDING`; raw exception не сохраняется и не возвращается API.
- Только после commit Scheduler создаёт `AgentRunRequested` с точными `requestId` и `runId`. Runtime consumer повторно читает request и Run и допускает запуск только при совпадающих identities и `READY`; условный claim durable process-owner row по `run_id` предотвращает второй запуск. Если Run уже `COMPLETED`, handler применяет сохранённый outcome через unique completion projection по `run_id` без повторного Runtime вызова; если Run уже `FAILED`/`CANCELLED`, handler не запускает его, а Recovery создаёт новый request с новым source attempt key. Completion projection, Workflow transition и retry enqueue идемпотентны относительно `run_id`; повторная доставка безопасна и до, и после inbox/outbox acknowledgement.
- Создаёт: `AgentRunStarted|Completed|Failed|Interrupted` и события стадий workflow.
- Production queue worker впервые подключает policy к реальному потребителю; `startWorkflowRuns()` может остаться helper только если он вызывается тем же worker и проходит ту же durable request transaction. Периодический 5-секундный safety tick не считается единственным trigger, но гарантирует повторный поиск после restart или пропущенного event nudge.
- Ни route, ни Runtime caller, ни Task Recovery не могут вызывать `dispatchTask(taskId)` в обход durable request arbitration для пользовательского Task dispatch. Epic phase runs и Request planning сохраняют существующий отдельный persisted phase/job intent; Task queue не обещает для них priority ordering или capacity wait.
- `/tasks/:id/dispatch` требует opaque `Idempotency-Key`, который клиент сохраняет при повторе после потерянного ответа. `202 Accepted` возвращает прежние request/status/`run_id` при retry того же ключа, включая `DISPATCHED` и terminal states; ключ с другим Task/role/model/source отклоняется stable conflict. `GET /api/v1/tasks/:taskId/dispatch-requests/:requestId` возвращает durable status.

### Production Scheduler→Runtime acceptance matrix

| Сценарий | Выполнение через production Scheduler→Runtime path | Проверяемый результат |
|---|---|---|
| Конкурирующие requests при `capacity = 1` | Создать durable RunRequests разных категорий/priority/path и запустить production queue worker | Только top-ranked request создаёт Run+manifest, reservation и `AgentRunRequested`; остальные остаются `PENDING` без Run/reservation |
| Строгая категория | Более поздняя категория имеет максимальный aged priority и самый длинный path | Scheduler выбирает request из более ранней категории |
| Aged priority | В одной категории два request с разными durable capacity wait timestamps | Scheduler выбирает более высокий aged priority |
| Critical path tie-break | В одной категории равный aged priority, разные unfinished `BLOCKING` forward-chain lengths в `dependencies` | Scheduler выбирает более длинный critical path; при разном priority path порядок не меняет |
| Ожидание capacity/priority | Низкоранговый targeted request или request при занятой capacity поступает через production route | API отвечает `202`; request остаётся durable `PENDING`, исключений/attempt increments/dead letters нет; Run/reservation отсутствуют |
| READY barrier | Сохранить Task RunRequest и `AgentRunRequested` во время `RECOVERING`, запустить queue/outbox workers до READY, вызвать `EventDispatcher.dispatchBatch()` при `RECOVERING` и `READY` | При `RECOVERING` Task queue runtime handler не вызывается, request остаётся pending без Run/manifest/reservation, event attempts/available_at/last_error/dead-letter не меняются; после READY request/event безопасно обрабатывается. Ранее approved Epic может resume до READY только в подтверждённом Proposal 06 recovery path и не проходит через Task queue |
| Restart и освобождение capacity | Перезапустить Orchestrator с pending requests; освободить слот и запустить production worker | Тот же request выбирается по актуальному порядку, получает ровно один Run+manifest/reservation/outbox и становится `DISPATCHED` |
| Параллельные workers/replay | Два worker ticks и повторно доставленный outbox event одновременно видят один request | Один условный claim и ровно одна Run/manifest/reservation; дубликаты становятся no-op |
| Crash после commit до Runtime | Перезапустить после атомарного commit Run/request/outbox, но до event delivery | Owner preflight и Run reconciliation завершают старый Run; replay точного event не создаёт/не запускает второй Run; Recovery использует новый source attempt key |
| Crash во время Runtime | Перезапустить во время исполнения после доказанного owner stop | Старый Run получает один terminal failure; replay не запускает его повторно; Recovery создаёт не более одного нового request для failed attempt |
| Crash после результата до event ack | Сохранить Runtime outcome и остановить процесс до `processed_events`/outbox acknowledgement, затем доставить событие повторно | Stored outcome применяется к Workflow ровно один раз по `run_id`; следующий stage/retry не дублируется; Runtime не вызывается повторно |
| Ошибка подготовки | Принудительно прервать Run/manifest insert внутри dispatch transaction | Нет частичного Run, manifest, reservation, Workflow transition, request claim или outbox; повтор остаётся безопасным |
| Request identity/deduplication | Повторить команду с прежним `Idempotency-Key` до/после `DISPATCHED`, включая потерянный HTTP response; затем повторить ключ с изменёнными role/model | Идентичный вызов возвращает прежние request/status/`run_id` во всех состояниях; изменённый payload получает stable conflict; новый Run возможен только с новым ключом |
| Task Recovery and Epic boundary | Recovery повторно создаёт Task request после persisted Run failure; production Epic flow создаёт task-bound и taskless phase runs | Recovery использует новый source attempt key и общую Task очередь; Epic phase intent/run остаётся в своём persisted lifecycle и не создаётся повторно через пользовательский queue producer |
| Migration compatibility | Empty install и populated upgrade с ожидаемого schema head | Новая migration только создаёт request table/indexes/FKs; `context_deltas` rows/schema/indexes/FKs побайтно сохраняются; `foreign_key_check` пуст |

Acceptance проходит через production composition, Task API и Task Recovery; unit-only вызов `startWorkflowRuns()` или direct handler не засчитывается. Проверки наблюдают lifecycle status, outbox attempts, request state, persisted Run+manifest+owner, reservation, workflow transition и `AgentRunRequested`, а также readback того же request после restart и lost-response replay. Epic/Request phases проверяются только на сохранение их persisted lifecycle boundary и не считаются producer coverage пользовательской Task очереди.

- [ ] **Шаг 1: Написать RED для durable queue, ordered arbitration и полного standalone workflow**

Сначала покрыть все строки acceptance matrix, включая READY barrier, crash/replay после каждой commit/runtime/ack границы, ожидание/restart, selected role/model persistence, error rollback, постоянную request deduplication и отсутствие prepared/failed orphan Run до arbitration. Создать отдельную populated upgrade suite 040→041 и проверить empty install 001–041; Task5 suite отдельно сохраняет проверку 039→040.

Script roles:

```text
Developer COMPLETED
Reviewer PASS
QA PASS
Integration PASS
```

Ожидается, что статус Задача завершится на `WAITING_FOR_APPROVAL` с ровно одним ожидающим `FINAL_MERGE` approval и без дублирующихся runs после воспроизведения всех durable events.

- [ ] **Шаг 2: Подтвердить ожидаемый RED до production-кода**

```bash
pnpm --filter @ebb-orchestrator/server exec vitest run test/scenarios/standalone-task.fake-runtime.test.ts test/modules/scheduler/
pnpm --filter @ebb-orchestrator/server exec vitest run test/app/api.test.ts test/modules/recovery/recovery.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/scheduler-migration.test.ts test/platform/database/scheduler-run-request-migration.test.ts test/platform/database/fresh-install-migrations.acceptance.test.ts
```

- [ ] **Шаг 3: Реализовать durable RunRequest producer, queue worker и transactional runtime handoff**

Добавить migration 041, repository/API для request lifecycle, startup/safety-tick worker и event nudges; добавить deferred disposition для `AgentRunRequested` в outbox во время `RECOVERING`. Перевести Task HTTP/Recovery callers на request API и обеспечить стабильный `Idempotency-Key` во всех request states. В одной write transaction выполнить ordered selection → подготовить Run/manifest → reservation и Workflow transition → отметить request `DISPATCHED` → вставить `AgentRunRequested`. Runtime consumer запускает только matching committed Run после READY и идемпотентно применяет уже сохранённый outcome при replay. Epic/Request сохраняют свои persisted phase/job flows. При capacity/priority WAIT request остаётся `PENDING`, без Run и без ошибки EventDispatcher.

Только domain services могут переводить стадии. Обработчик completion проверяет текущую стадию workflow перед применением результата. `ApprovalApproved(FINAL_MERGE)` переводит Task в `READY_FOR_MERGE`; фактический Git merge остаётся в будущем Plan 3.

- [ ] **Шаг 4: Запустить сценарий и проверить idempotency**

```bash
pnpm --filter @ebb-orchestrator/server exec vitest run test/scenarios/standalone-task.fake-runtime.test.ts test/modules/scheduler/ test/modules/recovery/recovery.test.ts test/platform/events/event-dispatcher.test.ts
pnpm --filter @ebb-orchestrator/server exec vitest run test/app/api.test.ts test/platform/database/scheduler-migration.test.ts test/platform/database/scheduler-run-request-migration.test.ts test/platform/database/fresh-install-migrations.acceptance.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/modules/runtime apps/server/src/modules/scheduler apps/server/test/scenarios
git commit -m "feat: добавить durable Scheduler RunRequest очередь"
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
pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/recovery/recovery.test.ts
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
pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/recovery/recovery.test.ts
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

## Дополнение по продолжению от 2026-10-03 — disposition whole-plan review

Свежий независимый whole-plan review завершился с точным вердиктом `CHANGES_REQUIRED`. Поэтому lifecycle возвращён в `in_progress`; прежний статус и completion evidence сами по себе не закрывают обнаруженные требования. Процедурные checklist marks не менялись.

- Production failure → Scheduler путь пока не подключает `RecoveryService`: в `apps/server/src/modules/recovery/recovery-service.ts` есть реализация, но поиск production source показывает только её объявление; конструктор используется тестом в `apps/server/test/modules/recovery/recovery.test.ts`, а production composition создаёт `SchedulerService` в `apps/server/src/main.ts` без wiring `RecoveryService`.
- В этой редакции плана формулировка `simple downstream-blocked-count boost` находилась в Задаче 5 (Scheduler), а `compareTasks` сортировал по категории, priority и времени создания; реализации priority aging и critical-path boost ещё не было. Это историческое состояние и reviewer finding на тот момент. Исполнимый Scheduler policy contract зафиксирован последующим решением пользователя от 2026-10-03 и приведён в `spec-01 §8.1` и обновлённой Задаче 5 ниже; implementation и acceptance остаются открытыми.
- Вложенные команды вида `pnpm --filter @ebb-orchestrator/server test -- <files>` в других задачах Plan02 всё ещё требуют точного аудита: `apps/server/package.json` задаёт `test` как `vitest run`, а приёмка плана также ссылается на корневой `pnpm test`. **Correction (2026-10-03):** два focused recovery examples в Задаче 7 исправлены на `pnpm --filter @ebb-orchestrator/server exec vitest run test/modules/recovery/recovery.test.ts`; текущий запуск из repo root завершился с exit `0`, 1 file / 16 tests passed. Это подтверждает только указанную focused suite; production recovery wiring и прочие whole-plan findings остаются открытыми.

До закрытия Plan02 нужно устранить или корректно разрешить перечисленные расхождения и выполнить проверяемую acceptance/review-сверку. Одного прежнего статуса `completed` и старых completion evidence недостаточно.
