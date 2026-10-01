---
id: plan-05
kind: plan
status: blocked
title: План реализации планирования Orchestrator, эпиков, контекста, знаний и использования
created: 2026-09-23
updated: 2026-09-30
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/6908acd
  - https://github.com/ebb-orchestrator/ebb-orchestrator/commit/c18264e
  - apps/server/test/planning/
  - apps/server/test/knowledge/
  - docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md
---
# План реализации планирования Orchestrator, эпиков, контекста, знаний и использования

> **Актуальная сверка (2026-09-30):** `plan-05` остаётся `blocked`. Proposal 06 принят: request API/UI, validated PM/Architect approval summary, запрет materialization/child dispatch до human approval и startup resume одобренных Epic до `READY` входят в scope Task 8. Durable request linkage и seeded production restart harness реализованы, но они не заменяют same-request restart и real Hermes acceptance. В production также нет writer/callsite, который связывает `ContextManifest` с фактическим Orchestrator-prepared Run input. Proposal 08 прошёл независимый design review `PASS` и принят пользователем 2026-09-30; его producer и runtime acceptance реализуются по отдельному Plan20 и пока остаются открытыми.

> **Для агентного исполнения:** REQUIRED SKILL: `ebb-execute-plan`. План выполняется по задачам; для отслеживания шагов используется синтаксис флажков (`- [ ]`).

**Цель:** Добавить интеллектуальное планирование Coordinator/PM/Architect, полноценный Epic workflow, долгосрочные знания проекта, расширенный Context Engine и иерархические средства управления использованием/бюджетом.

**Архитектура:** Planning вызывает Hermes через тот же Runtime port, но выводы модели всегда становятся данными-кандидатами и проходят детерминированные валидаторы/политики. Guidelines/Decisions хранятся в версиях в repository и индексируются локально; Context Engine выбирает их структурно. Использование/бюджет располагается перед отправкой в Scheduler и резервирует бюджет атомарно.

**Технологический стек:** существующий runtime Hermes; Zod; SQLite; знания проекта в Markdown/YAML; native Git.

**Спецификация:** `docs/architecture/specs/01-system-design.md`

**Принятый lifecycle design:** `docs/architecture/proposals/06-coordinator-request-and-epic-recovery.md` (вариант A принят пользователем 2026-09-29). Task 8 включает его request/approval/recovery contract и принимает `Plan 19` как текущий implementation/evidence source.

## Глобальные ограничения

- Coordinator не создаёт реальные Task/Epic IDs; только временные ссылки.
- Значения Planning одобрение по умолчанию: standalone task false, multi-task plan true, epic true, architecture change true.
- Agent может предложить Guideline/Decision/Dependency/Task, но не активирует их напрямую.
- Долгосрочная память — DB + знания repository, не вечная сессия Hermes.
- Vector DB/RAG не входит в v1.
- Жёсткий бюджет блокирует новые AI runs; мягкий бюджет создаёт одобрение, но не прерывает уже выполняющийся Run автоматически.

---

### Задача 1: Контракты Coordinator, PM, Architect и DevOps

**Файлы:**
- Создать: `packages/contracts/src/roles/coordinator.ts`
- Создать: `packages/contracts/src/roles/product-manager.ts`
- Создать: `packages/contracts/src/roles/architect.ts`
- Создать: `packages/contracts/src/roles/devops.ts`
- Изменить: `apps/server/src/modules/runtime/output-validator.ts`
- Тест: `apps/server/test/modules/runtime/planning-output-validator.test.ts`

**Интерфейсы:**
- Создаёт схемы операций Coordinator `CLASSIFY_REQUEST|PLAN|REPLAN|DIAGNOSE|ANALYZE_PROPOSAL`.
- Создаёт для PM `ProductDefinition`, Architect `DesignResult`, DevOps `DevOpsOutput`.

- [ ] **Шаг 1: Написать тесты некорректных планов**

Отклонять:

```text
duplicate task refs
depends_on unknown ref
cyclic temporary dependency graph
unknown role/workflow
missing Task acceptance criteria
```

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- planning-output-validator.test.ts
```

- [ ] **Шаг 3: Реализовать схемы ролей и семантические проверки**

Поля Coordinator `recommended_*` остаются рекомендациями; окончательное решение принимает policy engine. Вывод guideline от Architect использует `ProposalCandidate`, а не прямое изменение знаний.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- planning-output-validator.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add packages/contracts/src/roles apps/server/src/modules/runtime/output-validator.ts apps/server/test/modules/runtime/planning-output-validator.test.ts
git commit -m "feat: add planning and design role contracts"
```

---

### Задача 2: Сервис Planning и политика одобрение

**Файлы:**
- Создать: `apps/server/src/modules/planning/planning-types.ts`
- Создать: `apps/server/src/modules/planning/planning-policy.ts`
- Создать: `apps/server/src/modules/planning/plan-validator.ts`
- Создать: `apps/server/src/modules/planning/planning-service.ts`
- Создать: `apps/server/src/platform/database/migrations/009_planning.sql`
- Тест: `apps/server/test/modules/planning/planning-service.test.ts`

**Интерфейсы:**
- Создаёт: `PlanningService.createRequest`, `classify`, `preparePlan`, `approvePlan`, `rejectPlan`.

- [ ] **Шаг 1: Написать тесты значений одобрение по умолчанию**

Проверить эффективные значения по умолчанию:

```yaml
standalone_task: false
multi_task_plan: true
epic: true
architecture_change: true
```

Простая standalone Task может быть материализована без одобрение планирования; план Epic остаётся в ожидании до одобрения.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- planning-service.test.ts
```

- [ ] **Шаг 3: Реализовать материализацию временных ссылок**

После одобрения одна транзакция создаёт Epic/Tasks/dependencies и выполняет отображение:

```text
task_1 → TASK-n
task_2 → TASK-n+1
```

Публиковать `PlanApproved` и события создания доменных объектов. При ошибке валидации или БД частичные Task не создаются.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- planning-service.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/planning apps/server/src/platform/database/migrations/009_planning.sql apps/server/test/modules/planning
git commit -m "feat: add coordinator planning and approval flow"
```

---

### Задача 3: Полная оркестрация Epic с PM/Architect и финальной валидацией

**Файлы:**
- Создать: `apps/server/src/modules/planning/epic-orchestrator.ts`
- Изменить: `apps/server/src/modules/runtime/run-event-handlers.ts`
- Изменить: `apps/server/src/modules/workflow/workflow-engine.ts`
- Тест: `apps/server/test/e2e/epic.fake-runtime.test.ts`

**Интерфейсы:**
- Создаёт последовательность: план → необязательный PM → необязательный Architect → дочерние Tasks → проверка Epic → проверка архитектуры если установлен соответствующий флаг → Epic QA → Integration → final одобрение.

- [ ] **Шаг 1: Написать детерминированный Epic E2E на FakeAgentRuntime**

Использовать три Tasks, две из которых выполняются параллельно после основы. Проверить обязательную и необязательную семантику, что целью дочерних задач является ветка Epic, а финальные обязательные проверки запускаются только после интеграции обязательных дочерних задач.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- epic.fake-runtime.test.ts
```

- [ ] **Шаг 3: Реализовать условия оркестрации**

Architecture Review выполняется только если `architecture_review_required` или существует одобренное предложение, меняющее архитектуру. Переход дочерней Task в `RELEASED` происходит только после завершения финального слияния Epic.

- [ ] **Шаг 4: Запустить тест**

```bash
pnpm --filter @ebb-orchestrator/server test -- epic.fake-runtime.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/planning apps/server/src/modules/runtime/run-event-handlers.ts apps/server/src/modules/workflow apps/server/test/e2e/epic.fake-runtime.test.ts
git commit -m "feat: orchestrate full epic lifecycle"
```

---

### Задача 4: Индекс и жизненный цикл Guidelines и Decisions repository

**Файлы:**
- Создать: `apps/server/src/modules/knowledge/knowledge-types.ts`
- Создать: `apps/server/src/modules/knowledge/guideline-parser.ts`
- Создать: `apps/server/src/modules/knowledge/decision-parser.ts`
- Создать: `apps/server/src/modules/knowledge/knowledge-service.ts`
- Создать: `apps/server/src/platform/database/migrations/010_knowledge.sql`
- Тест: `apps/server/test/modules/knowledge/knowledge-service.test.ts`

**Интерфейсы:**
- Создаёт стабильные ID `GL-<CATEGORY>-nnn`, `DEC-nnnn` и состояния согласно спецификации.
- Создаёт `KnowledgeService.indexRepository`, `applyApprovedProposal`, `activeForScope`.

- [ ] **Шаг 1: Написать тесты разбора/версий/supersede**

Проверить, что возвращается только активная текущая guideline, вытесненные версии остаются историческими, а ошибочные `superseded_by` и дублирующиеся ID не проходят валидацию.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- knowledge-service.test.ts
```

- [ ] **Шаг 3: Реализовать анализатор метаданных Markdown и индекс БД**

Хранить канонический текст в Markdown репозитория; БД хранит доступные для поиска метаданные/version/hash/provenance. Внешнее семантическое изменение становится `PENDING_EXTERNAL_CHANGE`, а не активируется автоматически.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- knowledge-service.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/knowledge apps/server/src/platform/database/migrations/010_knowledge.sql apps/server/test/modules/knowledge
git commit -m "feat: index project guidelines and decisions"
```

---

### Задача 5: Сужение дубликатов/конфликтов предложений знаний и путь Git-коммита

**Файлы:**
- Создать: `apps/server/src/modules/knowledge/knowledge-analyzer.ts`
- Создать: `apps/server/src/modules/knowledge/knowledge-git-service.ts`
- Тест: `apps/server/test/modules/knowledge/knowledge-analyzer.test.ts`

**Интерфейсы:**
- Создаёт классификации `NEW|DUPLICATE|CLARIFICATION|EXTENSION|CONFLICT|REPLACEMENT`.

- [ ] **Шаг 1: Написать детерминированные тесты выбора кандидатов**

Новая guideline из БД сравнивается только с активными кандидатами базы данных в пересекающейся области. Точный нормализованный дубликат возвращает `DUPLICATE` без запроса AgentRun.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- knowledge-analyzer.test.ts
```

- [ ] **Шаг 3: Реализовать сужение кандидатов и одобренный коммит**

Изменения только форматирования или пробелов детерминированно классифицируются как редакционные. Потенциальные семантические конфликты создают целевой Run анализа Architect, содержащий только подмножество кандидатов. Одобренное изменение записывается атомарно и коммитится отдельным управляемым Git-коммитом, например `orchestrator: update guideline GL-ARCH-014`.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- knowledge-analyzer.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/knowledge apps/server/test/modules/knowledge/knowledge-analyzer.test.ts
git commit -m "feat: validate and apply knowledge proposals"
```

---

### Задача 6: Расширенный Context Engine, манифесты и дельты возобновления

**Файлы:**
- Создать: `apps/server/src/modules/context/context-selector.ts`
- Создать: `apps/server/src/modules/context/context-budget.ts`
- Создать: `apps/server/src/modules/context/context-delta.ts`
- Создать: `apps/server/src/platform/database/migrations/011_context.sql`
- Изменить: `apps/server/src/modules/context/context-builder.ts`
- Тест: `apps/server/test/modules/context/context-selection.test.ts`

**Интерфейсы:**
- Создаёт элементы `P0|P1|P2|P3`, `ContextManifest`, `ContextDelta`.

- [ ] **Шаг 1: Написать тесты выбора и pruning**

Для Task провайдера включить соответствующие guideline провайдера/архитектуры и решение Epic; исключить guideline базы данных, resolved finding и superseded decision. При превышении бюджета сначала удалять P3, затем уплотнять/удалять P2, но никогда не удалять P0.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- context-selection.test.ts
```

- [ ] **Шаг 3: Реализовать структурный выбор**

Релевантность определяется по объёма/area/path/role/tags. Resume delta сообщает `NEW|UPDATED|REMOVED`; существенное изменение Task Contract может вернуть `RESUME_NOT_SAFE` что требует новую сессию. Сервис embedding/vector отсутствует.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- context-selection.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/context apps/server/src/platform/database/migrations/011_context.sql apps/server/test/modules/context
git commit -m "feat: add scoped context selection and deltas"
```

---

### Задача 7: Записи использования, каталог цен и резервирование бюджета

**Файлы:**
- Создать: `apps/server/src/modules/usage/usage-types.ts`
- Создать: `apps/server/src/modules/usage/usage-service.ts`
- Создать: `apps/server/src/modules/usage/budget-service.ts`
- Создать: `apps/server/src/modules/usage/pricing-catalog.ts`
- Создать: `apps/server/src/platform/database/migrations/012_usage.sql`
- Тест: `apps/server/test/modules/usage/budget-service.test.ts`

**Интерфейсы:**
- Создаёт: `BudgetDecision = ALLOW|ASK|DENY`.
- Создаёт атомарные `reserve(runEstimate)` и `reconcile(runActual)`.

- [ ] **Шаг 1: Написать тесты параллельного резервирования**

Оставшийся бюджет `$5`; три параллельных `$2` резервирования. Проверить, что ёмкость получают только два, а третье — `ASK` или `DENY` согласно политике soft/hard; гонка с перерасходом отсутствует.

- [ ] **Шаг 2: Проверить ожидаемое падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- budget-service.test.ts
```

- [ ] **Шаг 3: Реализовать иерархическое разрешение бюджета**

Области: global/project/epic/task, используется наиболее ограничительный доступный лимит. Оценка строится по скользящему историческому p90 для role/model с нижним защитным порогом. Сохранять причину срабатывания и категорию recovery/rework.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- budget-service.test.ts scheduler.test.ts
```

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/src/modules/usage apps/server/src/platform/database/migrations/012_usage.sql apps/server/test/modules/usage
git commit -m "feat: add usage accounting and budget reservations"
```

---

### Задача 8: Сценарий приёмки запроса Real Hermes → Epic

**Файлы:**
- Создать: `apps/server/test/e2e/request-to-epic.hermes.test.ts`
- Использовать production request path `POST /api/v1/projects/{projectId}/requests`, persisted plan/role-run linkage, `apps/web/src/features/coordinator/CoordinatorRequestPanel.tsx` и startup recovery wiring из `apps/server/src/main.ts`.
- Повторно использовать: `apps/server/test/e2e/fixtures/health-service/` или добавить более крупный fixture в стиле provider-backed acceptance.

**Интерфейсы:**
- Доказывает текущий accepted Proposal 06 flow. До explicit plan approval допускаются только request-bound Coordinator/PM/Architect planning Runs; PM/Architect решения и validated summary видны человеку до materialization. До `approve-run` запрещены domain Epic/Task IDs, child-work Runs и child scheduler reservations.
- После human approval сохраняются и повторно используются те же `requestId`, `planId`, Epic/Task/Run/phase IDs; duplicate request delivery или process restart не создаёт дублей.
- Startup выполняет migrations и run/scheduler/git reconciliation до `READY`, автоматически возобновляет только approved Epic и останавливается на `FINAL_APPROVAL`; plan approval и final merge никогда не одобряются автоматически.
- Доказывает применимость нужных role contracts; вызываются только роли, выбранные deterministic workflow. ContextManifest acceptance остаётся отдельным gated criterion по spec-01: Proposal 08 принят, но producer/runtime evidence ещё не реализованы.

- [ ] **Шаг 1: Определить запрос и ожидаемые структурные проверки**

Использовать запрос, которому обязательно нужны 2–3 зависимые Tasks. Проверить сохранение PlanningRequest, authenticated approval summary с PM/Architect decisions, отсутствие materialized Epic/Tasks/child Runs/reservations до approval, а затем создание ровно одного approved plan/Epic и отсутствие дублей после повторной доставки.

- [ ] **Шаг 2: Один раз запустить для выявления интеграционных пробелов**

```bash
RUN_HERMES_E2E=1 pnpm --filter @ebb-orchestrator/server test -- request-to-epic.hermes.test.ts
```

Этот provider-backed acceptance запускается только на исправном isolated Hermes CLI/profile и разрешённой модели/provider; `HERMES_EXECUTE COMPLETED`, fake runtime и локальный smoke не являются заменой. Run повторяется на той же request identity после production-process restart и проверяет отсутствие дублированных role Runs/Tasks/phases.

- [ ] **Шаг 3: Завершить связку без ослабления политики**

После explicit plan approval Tasks выполняются с учётом зависимостей и scheduler policy. Request-bound PM/Architect decisions входят в summary до materialization; child-work выполняется лишь после `approve-run`. Финальное слияние Epic по-прежнему требует отдельного явного одобрения и не выполняется при startup recovery.

- [ ] **Шаг 4: Проверить устойчивость к перезапуску в середине Epic**

Тестовый стенд перезапускает production `dist/main.js` на том же request после approval и после durable child checkpoint. Startup повторно использует сохранённые IDs/checkpoints, проходит обычный Scheduler/budget/permission path, не дублирует Runs/phases/Tasks и останавливается на `FINAL_APPROVAL`. Отдельно запуск `pnpm plan05:epic-restart:acceptance` подтверждает seeded-checkpoint recovery, но сам по себе не закрывает Hermes/same-request части.

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/test/e2e apps/server/src
git commit -m "feat: complete request to epic orchestration"
```

## Критерии приёмки плана 5

- Вывод плана Coordinator не может обойти валидацию или политику одобрение планирования.
- Workflow Epic переживает перезапуск backend.
- Proposal 06 request API/UI, pre-materialization approval summary, durable same-request linkage, no preapproval child work и resume-before-READY проверены на production acceptance.
- Манифест контекста фиксирует Orchestrator-prepared input и версии contract/knowledge для Task/Epic/Request Run bindings. Proposal 08 принят, а реализация и evidence ведутся в Plan20; placeholder manifests не создаются.
- Новые семантические изменения Guideline требуют одобрения; точные дубликаты не требуют вызовов LLM.
- Резервирование бюджета предотвращает параллельный перерасход.
- Vector DB и вечная сессия Hermes проекта отсутствуют.
