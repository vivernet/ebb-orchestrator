# План реализации планирования Orchestrator, эпиков, контекста, знаний и использования

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: используйте superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации этого плана по задачам. Для отслеживания шаги используют синтаксис флажков (`- [ ]`).

**Цель:** Добавить интеллектуальное планирование Coordinator/PM/Architect, полноценный Epic workflow, долгосрочные знания проекта, расширенный Context Engine и иерархические средства управления использованием/бюджетом.

**Архитектура:** Planning вызывает Hermes через тот же Runtime port, но выводы модели всегда становятся данными-кандидатами и проходят детерминированные валидаторы/политики. Guidelines/Decisions хранятся в версиях в repository и индексируются локально; Context Engine выбирает их структурно. Использование/бюджет располагается перед отправкой в Scheduler и резервирует бюджет атомарно.

**Технологический стек:** существующий runtime Hermes; Zod; SQLite; знания проекта в Markdown/YAML; native Git.

**Спецификация:** `docs/architecture/specs/2026-09-16-ebb-orchestrator-design.md`

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
- Повторно использовать: `apps/server/test/e2e/fixtures/health-service/` или добавить более крупный fixture в стиле провайдера.

**Интерфейсы:**
- Доказывает применимость всех девяти контрактов ролей; вызываются только роли, нужные сценарию.

- [ ] **Шаг 1: Определить запрос и ожидаемые структурные проверки**

Использовать запрос, которому обязательно нужны 2–3 зависимые Tasks. Тест проверяет, что Coordinator возвращает Epic, одобрение плана создаётся, временные ссылки проходят проверку, а работа не начинается до одобрения.

- [ ] **Шаг 2: Один раз запустить для выявления интеграционных пробелов**

```bash
RUN_HERMES_E2E=1 pnpm --filter @ebb-orchestrator/server test -- request-to-epic.hermes.test.ts
```

- [ ] **Шаг 3: Завершить связку без ослабления политики**

После одобрения Tasks выполняются с учётом зависимостей и параллельности. Роли Architecture/PM запускаются только если выбраны одобренным workflow. Финальное слияние Epic по-прежнему требует явного одобрения.

- [ ] **Шаг 4: Проверить устойчивость к перезапуску в середине Epic**

Тестовый стенд завершает и перезапускает backend после интеграции хотя бы одной дочерней задачи; согласование при запуске продолжает оставшуюся работу без дублирования Task/Run/слияния.

- [ ] **Шаг 5: Закоммитить**

```bash
git add apps/server/test/e2e apps/server/src
git commit -m "feat: complete request to epic orchestration"
```

## Критерии приёмки плана 5

- Вывод плана Coordinator не может обойти валидацию или политику одобрение планирования.
- Workflow Epic переживает перезапуск backend.
- Манифест контекста доказывает, какие именно версии guideline/decision/contract видел каждый Run.
- Новые семантические изменения Guideline требуют одобрения; точные дубликаты не требуют вызовов LLM.
- Резервирование бюджета предотвращает параллельный перерасход.
- Vector DB и вечная сессия Hermes проекта отсутствуют.
