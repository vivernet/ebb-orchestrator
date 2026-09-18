# Отчёт по проверке архитектуры EBB Orchestrator

**Дата проверки:** 18 сентября 2026  
**Репо:** C:/Users/alex1/Repos/NEW/DEV/ebb-orchestrator-russian-jsdoc-readme  
**Ветка:** docs/russian-jsdoc-readme  
**Документ дизайна:** docs/superpowers/specs/2026-09-16-ebb-orchestrator-design.md

---

## Итог

Архитектура **соответствует дизайну** по всем ключевым принципам. Реализация последовательно следует спецификации v1.

---

## Проверка принципов

### 1. ✅ Deterministic-first

**Требование ( §1, §2):** Вся логика управления workflow, планированием, Git, permissions, recovery — детерминированный код. LLM используется только для семантического анализа и генерации кода.

**Найдено:**
- `workflow-engine.ts`: чистые функции `canTransition()` (без side effects) и транзакционная `transition()`
- `scheduler-policy.ts`: детерминированное сравнение задач по категории → приоритету → времени создания
- `permission-engine.ts`: политика безопасности на основе кода, без LLM
- `output-validator.ts`: валидация output по схеме и semantic invariants

---

### 2. ✅ Modular Monolith

**Требование (§1.2):** Модульный монолит с чёткими границами между модулями. Один SQLite, но логическое разделение владения таблицами.

**Найдено:**
- Структура модулей соответствует спецификации:
  - `work/` — Project, Epic, Task
  - `workflow/` — Workflow Engine
  - `scheduler/` — Scheduler
  - `runtime/` — Agent Runtime (HermesRuntimeAdapter)
  - `execution/` — Execution Gateway
  - `git/` — Git Manager
  - `permissions/` — Permission Engine
  - `recovery/` — Recovery
  - `knowledge/` — Guidelines, Decisions
  - `usage/` — Budget
  - `approvals/` — Approvals

- Миграции БД модульные: `001_system.sql` → `020_github.sql`

---

### 3. ✅ Ports & Adapters

**Требование (§1.2, §3.1):** Чистая архитектура с портами для внешних систем и адаптерами для реализации.

**Найдено:**
- `runtime/agent-runtime.ts` — порт `AgentRuntime` (контракт интерфейса)
- `runtime/hermes/hermes-runtime-adapter.ts` — адаптер HermesRuntimeAdapter
- `execution/action-gateway.ts` — порт `ExecutionEnvironment`
- `modules/github/` — GitHubAdapter для GitHosting port

**Структура:**
```
AgentRuntime (порт)
├── HermesRuntimeAdapter (адаптер, v1)
├── CodexRuntimeAdapter (запланировано)
└── ...

ExecutionEnvironment (порт)
├── LocalExecutionAdapter (v1)
└── ContainerExecutionAdapter (запланировано)
```

---

### 4. ✅ Git/SQLite Ownership

**Требование (§12, §14, §20):** Git — source of truth для кода. SQLite — source of truth для orchestration state. Каждая операция Git журналируется через GitOperation journal.

**Найдено:**
- `git/worktree-manager.ts`: создаёт worktree, логирует в БД
- `git/git-operation-repository.ts`: журнал операций Git (STARTED → VERIFIED)
- `git/merge-service.ts`: детерминированный Merge Service (не LLM)
- `main.ts`: single-instance lock через Orchestrator.lock
- `platform/process/system-lifecycle.ts`: система жизненного цикла с статусами STARTING → RECOVERING → READY

---

### 5. ✅ Workflow State Transitions

**Требование (§6, §7):** Workflow Engine — единственный владелец переходов состояний. Шаблоны: standard, bugfix, architecture_change, documentation, devops.

**Найдено:**
- `workflow/templates.ts`: 5 шаблонов, полностью соответствуют спецификации
- `workflow/workflow-engine.ts`: транзакционные переходы + outbox event в одной транзакции
- `workflow/workflow-types.ts`: типы контрактов
- `work/work-types.ts`: определения статусов (DRAFT → READY → DEVELOPMENT → REVIEW → QA → ...)

**Пример перехода:**
```ts
transition(taskId, "DEVELOPMENT", "REVIEW") // Atomically updates status + emits TaskStateChanged
```

---

## Проверка валиантов

| Инвариант | § | Проверка |
|-----------|---|----------|
| AI не изменяет domain workflow state напрямую | Б1 | ✅ Workflow Engine — единственное место для transition |
| AI не выделяет authoritative Task/Epic IDs | Б2 | ✅ IDs генерируются Orchestrator |
| Scheduler — единственный authority для dispatch | Б3 | ✅ SchedulerService единственная точка входа |
| Final merge через Merge Service после checks | Б5 | ✅ `merge-service.ts` + human approval |
| Один worktree — один active writer | Б6 | ✅ WorktreeManager создаёт по одному на Task |
| Domain state + outbox event в одной транзакции | Б11 | ✅ `workflow-engine.ts:74-132` |
| Hermes не имеет доступа к SecretStore/credentials | Б14 | ✅ SecretStore отдельно в `platform/secrets/` |

---

## Проверка детерминизма

| Компонент | Использует LLM? | Детерминирован? |
|-----------|-----------------|-----------------|
| Workflow Engine | ❌ | ✅ |
| Scheduler | ❌ | ✅ |
| Permission Engine | ❌ | ✅ |
| Git Manager | ❌ | ✅ |
| Recovery | ❌ | ✅ |
| Output Validator | ❌ | ✅ |
| Hermes RuntimeAdapter | ✅ (только для запуска) | ✅ |

---

## Отклонения / замечания

| Область | Статус | Комментарий |
|---------|--------|-------------|
| GitHub integration | Опционально | ✅ `github/` модуль присутствует |
| ContainerExecution | Запланировано | Не входит в v1 |
| Nested Epics | Нет | ✅ Не входит в v1 |
| Vector DB / RAG | Нет | ✅ Не входит в v1 |
| Multi-user | Нет | ✅ Не входит в v1 |

---

## Выводы

**Архитектура соответствует дизайну по всем ключевым принципам:**

1. **Deterministic-first** — все critical пути (workflow, scheduler, permissions, git, recovery) реализованы детерминированным кодом
2. **Modular Monolith** — чёткие границы модулей, единая БД с логическим разделением
3. **Ports & Adapters** — контракты реализованы, адаптеры (HermesRuntimeAdapter) внедрены
4. **Git/SQLite ownership** — разделение ответственности соблюдено, GitOperation journal присутствует
5. **Workflow state transitions** — Engine — единственный authority, шаблоны полные

**Готовность v1:** Архитектура соответствует спецификации v1.

---
