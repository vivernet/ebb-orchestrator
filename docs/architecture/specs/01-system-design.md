---
id: spec-01
status: superseded
title: System Design
date: 2026-09-16
stage: 01
type: spec
tags: [architecture, design, system]
---


# Local-first оркестратор разработки ПО с помощью ИИ — спецификация дизайна

**Статус:** архитектура утверждена по секциям; документ собран для финального ревью
**Дата:** 2026-09-16
**Область:** архитектура v1 + явно обозначенные точки будущего расширения
**Пример основной ветки по умолчанию:** `master` (настраивается для каждого проекта)

---

## 0. Краткое резюме

Продукт — универсальный local-first оркестратор разработки ПО с помощью ИИ для произвольных Git-репозиториев. Пользователь работает через локальный Web UI. В v1 интеллектуальные роли запускаются через Hermes Agent, а сам Orchestrator остаётся источником истины для workflow, Git, разрешений, scheduling, recovery, approvals, context и учёта расходов.

Главный принцип:

> **Если решение можно надёжно принять обычным кодом, LLM для него не вызывается.**

Система строится как модульный монолит с Ports & Adapters. Оркестрационное состояние хранится в SQLite, код — в обычном Git, активная работа ведётся через управляемые worktree. GitHub опционален: локальный workflow должен полностью работать без него.

Типовая standalone-задача проходит:

```text
Development → Review → QA → Integration → ручное подтверждение финального merge
```

Крупная функция оформляется как Epic. Дочерние Task интегрируются в Epic branch; затем выполняются Epic Review, при необходимости Architecture Review, Epic QA, финальная интеграция с текущим `master` и ручное подтверждение финального merge.

---

# 1. Общая архитектура

## 1.1. Форма продукта

Продукт существует как отдельное универсальное приложение, а не как код, встроенный в конкретный репозиторий.

v1 состоит из:

- локального backend-процесса;
- Web UI на localhost/loopback;
- SQLite;
- обычных Git-репозиториев и worktree на диске;
- отдельного управляемого профиля Hermes;
- опциональной интеграции с GitHub.

В будущем тот же backend/Web UI может быть обёрнут в desktop-приложение, но v1 — browser-based и не CLI-first.

## 1.2. Архитектурный стиль

Используется **модульный монолит + Ports & Adapters**. В v1 не нужны микросервисы и универсальная plugin-платформа.

```text
Web UI
  ↓
Orchestrator Backend
  CORE
    Projects
    Planning
    Work
    Workflow Engine
    Scheduler
    Approvals
    Guidelines / Decisions
    Permission Engine
    AI Invocation Policy
    Recovery
    Usage / Budget

  INFRASTRUCTURE
    Git Manager
    Worktree Manager
    SQLite Storage
    Internal Event Bus
    Logs / Artifacts
    Secure Storage

  PORTS
    AgentRuntime
    GitHosting
    ExecutionEnvironment

  ADAPTERS
    HermesRuntimeAdapter
    GitHubAdapter
    LocalExecutionAdapter
    ContainerExecutionAdapter (будущее)
```

Каждый модуль владеет своей логикой и своим состоянием. Общая SQLite **не означает**, что любой модуль может напрямую читать или изменять чужие таблицы. Взаимодействие идёт через публичные application API или domain events.

---

# 2. Модель управления с приоритетом детерминированности

Orchestrator управляет workflow. Hermes не управляет workflow самостоятельно.

Обычным кодом выполняются:

- state machine;
- dependency scheduling;
- concurrency limits;
- Permission Engine;
- Git/worktree management;
- approval gates;
- Merge Policy;
- retry/recovery mechanics;
- budget checks/reservations;
- config validation;
- структурный выбор контекста;
- schema/semantic output validation;
- reconciliation после restart.

LLM используется только там, где нужен смысловой анализ или генерация:

- понимание запроса;
- разбиение на Task/Epic;
- product requirements;
- архитектура;
- написание кода;
- code review;
- semantic QA;
- смысловое разрешение конфликтов;
- сложная диагностика blocker/recovery.

Каждый AI Run должен объяснять, **почему вообще понадобился LLM**: сохраняются trigger reason, роль, runtime, модель, context version, tokens, cost и результат.

Прямых agent-to-agent сообщений нет. Результат роли:

```text
Agent
→ structured result
→ validation
→ domain state / event
→ БД
→ Context Engine следующей роли
```

---

# 3. Среда выполнения агентов и роли

## 3.1. Универсальная среда выполнения

Все AI-запуски идут через `AgentRuntime`.

```text
AgentRuntime
├── HermesRuntimeAdapter   (v1)
├── CodexRuntimeAdapter    (позже)
├── OpenCodeRuntimeAdapter (позже)
└── другие adapters        (позже)
```

Концептуальный контракт:

- `startRun()`;
- `resumeRun()`;
- `cancelRun()`;
- `inspectRun()`;
- `collectResult()`;
- `collectUsage()`;
- `healthCheck()`.

Scheduler не знает CLI/API Hermes. Runtime Manager выбирает runtime/model, а adapter знает технические детали запуска.

Worktree всегда создаёт и назначает Orchestrator. Hermes запускается внутри уже подготовленного worktree и не владеет worktree самостоятельно.

## 3.2. Девять ролей v1

### Управление и проектирование

- Coordinator
- Product Manager
- Architect

### Реализация

- Middle Developer
- Senior Developer
- DevOps Agent

### Качество и интеграция

- Reviewer
- QA Agent
- Integration Agent

Роль — это не просто prompt. `RoleContract` содержит:

```text
purpose
allowed_workflows
input_schema
output_schema
permission_profile
default_model
runtime
allowed_tools
session_policy
escalation_policy
```

Модель настраивается отдельно для каждой роли. Middle и Senior прежде всего позволяют маршрутизировать простые задачи в более дешёвую модель, а сложные — в более сильную. Senior не получает автоматически больше административных прав.

## 3.3. Границы ролей

**Coordinator** классифицирует запрос, выбирает Task vs Epic, предлагает план, зависимости, роли и workflow, выполняет replan и сложную диагностику. Не редактирует production-код и не делает финальный merge.

**Product Manager** определяет goal, user behavior, scope, non-goals, requirements и acceptance criteria. Не выбирает техническую реализацию.

**Architect** определяет компоненты, interfaces, data flow, migrations, Decisions, guideline proposals и architecture review. Обычно не реализует production-код.

**Middle Developer** выполняет обычную реализацию.

**Senior Developer** выполняет сложную/core/architecture-sensitive реализацию и escalation после Middle.

**Reviewer** независимо проверяет correctness, architecture, maintainability, security, edge cases, tests, Guidelines, acceptance criteria и scope creep. Обычно не исправляет собственные findings.

**QA Agent** проверяет поведение, acceptance criteria, regression и edge cases. Он создаёт defects, а не «чинит по ходу».

**Integration Agent** подготавливает интеграцию с текущим target, разрешает только однозначные конфликты и блокирует архитектурную неоднозначность. Не даёт себе финальное разрешение на merge.

**DevOps Agent** отвечает за CI/CD, Docker, deployment/env/build/release/IaC. Чувствительные publish/deploy действия проходят Permission Engine и approval.

---

# 4. Подключение проекта и владение конфигурацией

Onboarding:

```text
Repository
→ Discovery
→ Review findings
→ Approve config
→ Activate project
```

Discovery строго разделяет:

- **DETECTED** — факты из репозитория;
- **PROPOSED** — рекомендации Coordinator/Orchestrator.

Например `master`, pnpm, Vitest или GitHub remote — detected. Выбор workflow или новой guideline — proposed.

Versioned project configuration:

```text
.orchestrator/
├── project.yaml
├── workflows.yaml
├── guidelines/
└── decisions/
```

Локально хранятся:

- абсолютные пути;
- Hermes sessions;
- runtime state;
- Task/Epic/Run state;
- approvals;
- recovery;
- GitHub credentials;
- UI preferences;
- machine-specific configuration.

Принцип:

> **Репозиторий описывает, как проект должен разрабатываться; локальная БД описывает, что происходит на этой машине сейчас.**

Если подключаемый репозиторий уже содержит `.orchestrator/`, эти файлы считаются **обнаруженной конфигурацией**, а не автоматически доверенной policy. До активации они проходят parse/validation/review/import.

---

# 5. Модель работы: Project, Epic, Task, Proposal, Decision

## 5.1. Иерархия

```text
Project
├── Epic
│   ├── Task
│   └── Task
└── Автономная Task
```

Nested Epic в v1 нет.

## 5.2. Источники работы

v1 поддерживает:

- natural-language request через Coordinator Chat;
- ручное создание Task/Epic в Web UI;
- import/sync GitHub Issue.

Если агент сам обнаружил дополнительную работу, он не создаёт Task напрямую. Он создаёт `ProposalCandidate`, после чего Orchestrator применяет policy/approval.

## 5.3. Контракт Task

Каждая Task имеет формальный контракт:

- Goal;
- Context;
- Requirements;
- Acceptance Criteria;
- Dependencies;
- Non-goals;
- Definition of Done.

Epic имеет аналогичный контракт более высокого уровня.

Developer не может переписать Acceptance Criteria под свою реализацию. Изменение требований идёт через Proposal.

## 5.4. Обязательные и необязательные Task

Плановые Task внутри Epic по умолчанию `required`. Optional Task указывается явно.

## 5.5. Зависимости

Dependency — отдельная сущность. В v1 основной тип — `BLOCKING`.

Агент может предложить изменение dependency graph, но не меняет его напрямую. Orchestrator проверяет ссылки и отсутствие циклов.

В будущем возможны `SOFT`/`ORDERING`, но они не нужны для v1.

---

# 6. Жизненный цикл Task и Epic

## 6.1. Автономная Task

```text
DRAFT
→ READY
→ DEVELOPMENT
→ REVIEW
→ QA
→ READY_FOR_INTEGRATION
→ INTEGRATION
→ READY_FOR_MERGE
→ MERGING
→ DONE
```

Дополнительные состояния:

```text
WAITING_FOR_DEPENDENCY
WAITING_FOR_APPROVAL
BLOCKED
PAUSED
FAILED
CANCELLED
```

## 6.2. Task внутри Epic

Task всегда target'ит Epic branch, а не `master`.

После успешной интеграции:

```text
INTEGRATED_INTO_EPIC
```

В `RELEASED` она переходит только после попадания Epic в `master`.

## 6.3. Жизненный цикл Epic

```text
User request
→ Coordinator planning
→ validated Epic/Tasks/dependencies
→ planning approval when required
→ epic/*
→ child Task workflows
→ all required Tasks integrated
→ Epic Review
→ Architecture Review when required
→ Epic QA / E2E
→ final integration with current master
→ final merge approval
→ merge to master
→ Epic DONE
→ child Tasks RELEASED
```

Финальная интеграция всегда выполняется против **текущего** `master`, а не состояния ветки на момент создания Epic.

Политика подтверждения планирования по умолчанию:

```yaml
approvals:
  planning:
    standalone_task: false
    multi_task_plan: true
    epic: true
    architecture_change: true
```

Это defaults, а не жёстко зашитые правила. Финальный merge в `master` в v1 требует пользователя по умолчанию. Внутренний Task → Epic merge может выполняться автоматически после успешных Review + QA + Integration.

---

# 7. Workflow Engine и события домена

Workflow Engine — единственный владелец state transitions.

```text
Agent output
→ Output Validator
→ Domain Service
→ Workflow.canTransition()
→ Workflow.transition()
→ Domain Event
```

Coordinator выбирает один из разрешённых workflow templates, но не конструирует произвольный state machine.

Шаблоны v1:

```text
standard
bugfix
architecture_change
documentation
devops
```

События охватывают:

- AgentRun lifecycle;
- Development results;
- Review results;
- QA results;
- Integration results;
- dependencies;
- Жизненный цикл Epic;
- Approval;
- Proposal;
- Recovery;
- Budget;
- Git.

Используется текущее состояние в таблицах + event/audit history. Это **не full Event Sourcing**.

---

# 8. Планировщик и параллельность

Scheduler полностью детерминированный и не вызывает LLM.

Перед запуском он проверяет:

- Task readiness;
- blocking dependencies;
- workflow stage;
- global slots;
- project slots;
- role limits;
- resource locks;
- budget;
- approvals;
- pause state;
- permissions/policy prerequisites.

Приоритеты по умолчанию:

```text
integration / unblock
review
QA
rework
new development
optional/docs
```

Rework приоритетнее нового development: сначала заканчиваем уже начатое.

Поддерживаются:

- global `max_parallel_agents`;
- per-project limit;
- role limits;
- Critical / High / Normal / Low;
- priority aging;
- deterministic critical-path boost;
- Resource Locks;
- pause/resume Project/Epic/Task;
- `pause new` и immediate stop/cancel semantics.

Новая Critical Task не вытесняет принудительно уже активный Run.

UI всегда показывает конкретную причину ожидания: dependency, role slot, global limit, approval, budget, resource lock и т. д.

Scheduler работает event-driven, но имеет периодический safety tick для reconciliation.

---

# 9. Структурированные контракты AI-ролей

Для каждой роли существует отдельная versioned input/output schema. Backend не определяет решение по свободному тексту.

Основные outcomes:

- Coordinator — classification / plan / replan / diagnosis;
- PM — product definition / needs input;
- Architect — design / decisions / proposals / blocked;
- Developer — completed / blocked;
- Reviewer — pass / changes requested / blocked;
- QA — pass / fail / blocked;
- Integration — pass / blocked;
- DevOps — completed / blocked + requested operations.

AI не генерирует реальные Task/Epic IDs. В плане используются временные refs:

```text
task_1
task_2
```

после validation/approval они маппятся на реальные domain IDs.

Минимальные типы Proposal:

```text
NEW_TASK
NEW_DEPENDENCY
REMOVE_DEPENDENCY
SCOPE_CHANGE
REQUIREMENT_CHANGE
ACCEPTANCE_CRITERIA_CHANGE
GUIDELINE_CHANGE
ARCHITECTURE_CHANGE
ROLE_CHANGE
WORKFLOW_CHANGE
PLAN_CHANGE
```

Большие logs/evidence не кладутся в JSON output — они живут в Artifacts.

Output Validator выполняет:

1. schema validation;
2. semantic invariants.

Например:

- Reviewer `PASS` не может содержать blocking finding;
- QA `PASS` не может иметь failed required criterion;
- Coordinator не может сослаться на несуществующий temporary ref;
- Integration `PASS` невозможен при unresolved architectural conflict.

При invalid output допускается ограниченная repair continuation в той же session. После повторного invalid — `AGENT_OUTPUT_INVALID` → Recovery.

Финальный результат подаётся через контролируемый `submit_result(...)`. Первый успешно принятый result переводит Run в `COMPLETING`; дальнейшая произвольная работа запрещается.

## 9.1. Findings и дефекты

После первого принятого Review/QA Orchestrator назначает стабильные ID:

```text
FINDING-91
DEFECT-31
```

При re-review/retest обновляется существующая сущность:

```text
RESOLVED
STILL_PRESENT
STILL_REPRODUCIBLE
```

а не создаётся новый дубликат. Эти IDs/fingerprints используются Loop Detector и Recovery.

---

# 10. Context Engine / знания проекта

## 10.1. Три слоя памяти

### Долговременная память проекта

- Guidelines;
- Decisions;
- architecture records;
- approved project config;
- approved contracts.

### Рабочая память

- Task/Epic state;
- open findings;
- open defects;
- dependencies;
- recovery information;
- current Git state.

### Память сессии

- Hermes conversation;
- tool results;
- временное исследование.

Принцип:

> **База и versioned project knowledge — долгосрочная память. Session — временная рабочая память агента.**

## 10.2. Пакет контекста

Каждый Run получает минимальный достаточный context:

```text
role context
work contract
relevant project knowledge
active feedback/findings/defects
execution context
output contract
```

Репозиторий не дампится целиком в prompt. Агент читает исходники on demand через controlled tools.

Priority tiers:

```text
P0 REQUIRED
P1 HIGH
P2 SUPPORTING
P3 OPTIONAL
```

При превышении Context Budget сначала выполняется deterministic pruning:

- resolved findings/defects;
- superseded Decisions;
- irrelevant Guidelines;
- completed dependency details;
- source excerpts, которые можно прочитать tool'ом;
- необязательный background.

LLM summarization используется только после обычного pruning и только там, где структурного сокращения недостаточно.

Каждый Run хранит `ContextManifest`:

- Task/Epic contract version;
- Guidelines/versions;
- Decisions;
- findings/defects;
- Context Builder version;
- initial token size.

## 10.3. Контекст для конкретной роли

**Developer:** Task Contract, target/worktree, relevant Guidelines/Decisions, open findings/defects, dependency state.

**Reviewer:** Task Contract, Git diff, relevant Guidelines/Decisions, authoritative test/check results, open findings during re-review. История reasoning Developer по умолчанию не передаётся.

**QA:** Acceptance Criteria, behavior, environment, defects to retest.

**Architect:** более широкий requirements/architecture context, interfaces, Decisions, repository map.

**Coordinator:** компактный `Project/EpicStateSummary`, собираемый обычным кодом, а не вся история Runs.

## 10.4. Сессии

- Coordinator — на один planning/replan/recovery cycle;
- Architect — на Epic;
- Developer — на Task;
- Reviewer — на Task;
- QA — на Task;
- Integration — на Task/Epic.

Developer resume используется для rework. Reviewer/QA могут resume собственную session при повторной проверке. Вечных project-level sessions нет.

При resume Context Engine сравнивает старый manifest с текущим knowledge state и передаёт `ContextDelta`:

```text
NEW
UPDATED
REMOVED
```

Если relevant context изменился слишком сильно, session считается unsafe для resume и создаётся новая.

Vector DB, embedding RAG и full semantic repository index не обязательны для v1.

---

# 11. Guidelines и Decisions

## 11.1. Guidelines

Guideline — долговременное общее правило проекта.

Она имеет:

- stable ID, например `GL-ARCH-014`;
- category;
- version;
- scope/path/area;
- applicable roles;
- priority;
- status;
- provenance;
- rationale.

Приоритет:

```text
REQUIRED
RECOMMENDED
PREFERENCE
```

Жизненный цикл:

```text
PROPOSED
→ UNDER_REVIEW
→ ACTIVE
→ SUPERSEDED / DEPRECATED
```

Также возможны `REJECTED`.

AI может предложить guideline, но не активирует её напрямую.

Изменения делятся на:

- editorial — смысл не меняется;
- semantic — меняется правило.

Editorial change может применяться автоматически по policy. Semantic change требует policy/approval.

Детектирование дублей/конфликтов идёт в два этапа:

1. deterministic candidate narrowing по category/scope/path/tags/normalized text;
2. AI semantic comparison только небольшого набора кандидатов.

Классификация:

```text
NEW
DUPLICATE
CLARIFICATION
EXTENSION
CONFLICT
REPLACEMENT
```

## 11.2. Decisions

Decision — конкретный выбор и rationale, облегчённый ADR.

Статусы:

```text
PROPOSED
ACCEPTED
SUPERSEDED
OBSOLETE
REJECTED
```

Decision сохраняется только если он важен для будущей работы: влияет на несколько Task, architecture/interfaces, convention или фиксирует нетривиальный trade-off.

Decision имеет scope:

```text
PROJECT
AREA
EPIC
TASK
```

Повторяющееся решение может быть предложено к promotion в Guideline, но не становится Guideline автоматически.

Superseded knowledge остаётся в history, но не попадает в новый active context.

Manual/Git изменения `.orchestrator/guidelines` и `.orchestrator/decisions` проходят reconciliation. Semantic external change не считается автоматически утверждённым только потому, что пришёл через Git.

---

# 12. Permission Engine и шлюз действий

Техническая граница:

```text
Hermes
→ Run Capability
→ Orchestrator Tool Gateway
→ Permission Engine
→ ALLOW / ASK / DENY / ABSOLUTE_DENY
→ real action
```

Policy составляется из:

```text
Global
Project
Role
Task/Epic
```

Для security действует **most-restrictive-wins**.

Run Capability заранее привязывает:

- role;
- workspace/worktree;
- toolset;
- permission profile.

Hermes не выбирает произвольный workspace.

Основные controlled tools:

```text
workspace.read
workspace.search
workspace.patch
project.test
project.lint
project.typecheck
project.build
command.exec
git.status
git.diff
git.commit
artifact.write
submit_result
```

`command.exec` предпочитает `executable + args` и запуск без shell.

Shell (`bash`, `sh`, `cmd`, `PowerShell` и т. п.) — отдельная более рискованная capability.

Filesystem access всегда проходит:

```text
normalize
→ symlink/junction resolution
→ canonical path
→ worktree containment check
```

Developer может commit'ить свою ветку, но не финально merge'ить `master`. Integration работает в отдельном integration worktree. Финальный merge выполняет Merge Service после проверок и approval.

Для `ASK` Approval Inbox поддерживает узкий scope разрешения:

- allow once;
- allow this Run;
- allow this Task;
- project-level rule, если policy это позволяет.

Постоянные policy changes всегда явные и audited.

Managed Git operations по умолчанию отключают repository Git hooks. Если проект осознанно зависит от hooks, это включается отдельной security setting.

Hermes delegation/subagents в v1 отключены: иначе они обходили бы Scheduler, accounting и Audit.

---

# 13. Модель безопасности

Модель считается потенциально ошибающейся, repository content — потенциально враждебным, а Local Mode — **не OS sandbox**.

Ненадёжные входы:

- source/comments;
- README и repository instructions;
- Issues/PR/comments;
- test output;
- terminal output;
- внешняя документация;
- branch names / commit messages / file names.

Prompt injection не создаёт authority. Authority находится только в коде Orchestrator:

- approved policies;
- Role Contracts;
- Run capabilities;
- Permission Engine;
- explicit user approvals.

Repository-specific instruction files и MCP/plugins не подключаются автоматически.

## 13.1. Секреты

Секреты не попадают в prompt.

`SecretStore` хранит значения отдельно от SQLite и repository config. SQLite содержит только metadata/reference.

Hermes не получает GitHub token/App key. GitHub credentials видит только GitHubAdapter.

Agent subprocess не наследует весь environment backend-процесса. Sensitive variables, SSH agent socket и подобные capabilities удаляются по умолчанию.

Secret injection допускается только для строго scoped execution operation.

Logs/Artifacts проходят redaction/sanitization, но основная защита — **не давать секрет процессу без необходимости**.

## 13.2. Локальный API и Web UI

Backend по умолчанию слушает только loopback.

Требуются:

- local session auth;
- Origin validation;
- CSRF protection;
- closed CORS by default.

Repository/agent text рендерится escaped/sanitized. Terminal escape/control sequences ограничиваются безопасным subset.

Action Gateway по возможности использует private stdio/IPC, а не публичный localhost endpoint.

## 13.3. Уровни доверия

```text
TRUSTED_LOCAL
RESTRICTED_LOCAL
CONTAINER_ISOLATED (позже)
```

Local Mode даёт policy/tool/credential isolation, но не строгую process/filesystem/network isolation после запуска произвольного project code.

Container Mode в будущем добавляет реальную изоляцию.

Dependency installation, package scripts, tests/builds и любые lifecycle scripts считаются потенциальным выполнением произвольного кода. Typed action удобнее для policy, но не делает сам project script «безопасным».

---

# 14. Git, worktree и интеграция

Git — source of truth для кода. SQLite — source of truth для orchestration state.

Модель веток:

```text
master                              # configurable default
epic/42-anthropic-provider
task/421-anthropic-client
integration/task-421
integration/epic-42
```

Автономная Task основывается на `master`. Epic child Task — на Epic branch.

Каждая активная Task получает отдельный managed worktree. Один worktree — один активный writer.

После завершения AI Run Git Manager проверяет:

- expected branch;
- base/start/end HEAD;
- dirty/untracked state;
- наличие реальных изменений;
- reachable commit;
- target correctness.

Integration Agent не работает в Task worktree. Создаётся отдельный integration branch/worktree.

Task всегда интегрируется с **текущим** target branch, потому что target может измениться во время выполнения.

`MergeConflict` — first-class entity:

```text
source
target
files
classification
status
```

Классификация:

```text
TRIVIAL
RESOLVABLE
ARCHITECTURAL
```

Сначала deterministic rules, AI — только при semantic uncertainty.

Git и SQLite не имеют общей transaction, поэтому используется `GitOperation` journal:

```text
STARTED
→ VERIFIED
```

Operations включают CREATE_BRANCH, WORKTREE, COMMIT, INTEGRATE, MERGE, DELETE, PUSH.

Manual IDE/Git changes разрешены. Orchestrator делает reconciliation и может зафиксировать:

```text
IN_SYNC
LOCAL_AHEAD
REMOTE_AHEAD
DIVERGED
BRANCH_MISSING
WORKTREE_MISSING
UNCOMMITTED_CHANGES
```

v1 поддерживает обычный merge strategy. Rebase/history rewrite откладываются.

Final merge выполняет deterministic Merge Service, а не Hermes.

---

# 15. Интеграция с GitHub

GitHub — optional adapter, а не source of truth workflow.

```text
GitHosting Port
→ GitHubAdapter
```

Продукт полностью работает без GitHub и offline.

Authentication проектируется least-privilege и GitHub-App-oriented. Credentials остаются внутри Secure Storage/GitHubAdapter.

v1 integration:

- connect/authenticate;
- push managed branch;
- basic Issue import;
- create/update PR;
- final PR merge, если включён такой режим;
- polling;
- `Sync now`.

Polling + Sync Now — основной v1 механизм, потому что localhost не обязан быть доступен для webhook.

Не входят в v1:

- GitHub Projects;
- обязательные webhooks;
- полная двусторонняя sync всех comments/reviews.

Модель PR:

```text
Автономная Task: task/* → master
Epic child Task: task/* → epic/*
Epic: epic/* → master
```

Внутренние Review/QA/Integration остаются source of truth. GitHub может отображать/зеркалировать их состояние.

Human GitHub comments импортируются как `HumanFeedback`. Outbound objects Orchestrator маркируются, чтобы не попасть обратно как «новая человеческая обратная связь».

Закрытие Issue на GitHub не переводит Task в DONE. Metadata-only изменения могут reconcile автоматически, а semantic requirement/description changes превращаются в reconciliation decision/Proposal.

При offline внешние операции остаются `SYNC_PENDING`; local workflow продолжает работу.

GitHub infrastructure errors обрабатываются кодом: timeout retry, 401 re-auth/block, 403 permission block, rate limit wait. Для этого LLM не вызывается.

---

# 16. Recovery Engine и защита от циклов

Recovery — отдельный deterministic module.

Классы сбоев:

```text
CRASH
TIMEOUT
TOOL_ERROR
TASK_FAILURE
BLOCKER
```

Лестница восстановления:

```text
resume same session
→ retry with failure context
→ escalate role/model when appropriate
→ Coordinator diagnosis
→ user intervention / BLOCKED
```

Middle → Senior выполняется только когда более сильный reasoning действительно может помочь. Infrastructure failure не лечится более дорогой моделью.

Progress Detector сохраняет fingerprints:

- HEAD/diff;
- changed files;
- test failures;
- open Review findings;
- QA defects;
- Acceptance Criteria evidence.

No-progress/loop detection использует:

- одинаковый failure fingerprint;
- повтор command/tool pattern;
- одинаковый finding;
- одинаковый defect;
- неизменный Git state;
- revert/reapply cycle.

Retry — ограниченный ресурс. Новый AI Run должен либо продолжать доказанный прогресс, либо менять strategy/role/escalation.

Review/QA/Integration cycles имеют лимиты. После `RECOVERY_EXHAUSTED` Task блокируется.

Coordinator получает компактный Recovery Report и может вернуть структурированный diagnosis, например:

```text
RETRY_WITH_NEW_APPROACH
CREATE_DEPENDENCY
SCOPE_CHANGE
ARCHITECTURE_DECISION_REQUIRED
ENVIRONMENT_PROBLEM
USER_INPUT_REQUIRED
```

но любые domain changes снова проходят Proposal/policy.

Failed/Cancelled worktrees сохраняются по retention policy.

Есть emergency action **STOP ALL AGENTS**.

---

# 17. Usage & Budget Engine

Каждый AI Run относится к:

```text
Project → Epic → Task → Run
```

`UsageRecord` хранит:

- role;
- runtime;
- model;
- trigger reason;
- input tokens;
- cached tokens;
- output tokens;
- total;
- estimated/final cost;
- timestamps.

Причины запуска:

```text
PLANNING
PRODUCT_DEFINITION
ARCHITECTURE_DESIGN
DEVELOPMENT
CODE_REVIEW
QA_VALIDATION
INTEGRATION
REVIEW_REWORK
QA_REWORK
RECOVERY
RECOVERY_ESCALATION
COORDINATOR_DIAGNOSIS
EPIC_REVIEW
ARCHITECTURE_REVIEW
```

Иерархия бюджета:

```text
Global
Project
Epic
Task
```

Effective limit — наиболее restrictive.

```text
soft limit → ASK
hard limit → DENY new AI runs
```

Перед параллельным запуском выполняется budget reservation. Estimate берётся из исторической статистики по role/model с safety margin, а не предсказывается LLM.

После Run reservation reconciles с actual usage. Stale reservations dead/interrupted Runs очищаются во время reconciliation.

Usage tracking включён по умолчанию. Budget limits пользователь может включать/настраивать самостоятельно.

Dashboard должен показывать concrete metrics: tokens, cache, cost, context size, recovery/rework share и effective cost. Не нужен магический «AI quality score».

---

# 18. Модули backend, API и модели чтения

Основные backend-модули:

- Projects;
- Planning;
- Work;
- Workflow;
- Scheduler;
- Agent Runtime;
- Execution;
- Git;
- Git Hosting;
- Approvals;
- Recovery;
- Usage & Budget;
- Guidelines / Decisions;
- Artifacts;
- Audit.

Модули общаются тремя способами:

```text
COMMAND — сделай
QUERY   — дай данные
EVENT   — это уже произошло
```

HTTP controllers остаются thin и не содержат бизнес-логику.

Для обычных действий UI используется HTTP JSON API.

Для live backend → browser updates используется **SSE**.

WebSocket добавляется только если появится функция, которая реально требует двустороннего realtime, например интерактивный terminal.

Для сложных UI экранов используются read-only projections:

```text
DashboardProjection
ProjectOverviewProjection
EpicOverviewProjection
TaskOverviewProjection
ExecutionQueueProjection
```

Это CQRS-lite: write side остаётся внутри domain modules, read side может эффективно агрегировать несколько источников.

SQLite физически одна, но ownership таблиц сохраняется логически.

---

# 19. Обработка событий, задания и workers

## 19.1. Транзакционный Outbox

Domain state и durable event записываются одной SQLite transaction:

```text
state change
+
outbox event
→ COMMIT
```

Таким образом нельзя получить новое состояние без соответствующей durable записи события.

Delivery semantics — **at-least-once**, не exactly-once. Поэтому durable handlers обязаны быть idempotent.

Critical consumers могут хранить processed-event/inbox state.

## 19.2. Надёжные и эфемерные события

Durable:

- Task state changes;
- approvals;
- run failures;
- budget state;
- merges;
- external Git changes.

Ephemeral:

- ToolCallStarted;
- terminal chunks;
- progress/typing updates.

Ephemeral UI события не обязаны жить в persistent event history.

## 19.3. Событие и задание

```text
Event = что произошло
Job   = что нужно выполнить
```

Например `TaskIntegrated` может создать background job `UPDATE_GITHUB_PR`. GitHub outage не должен удерживать domain event или локальный workflow.

Состояния фоновых заданий:

```text
QUEUED
RUNNING
RETRY_WAIT
SUCCEEDED
FAILED
CANCELLED
```

## 19.4. Workers v1

- Event Dispatcher;
- Scheduler Worker;
- Run Supervisor;
- Recovery Worker;
- Git Reconciliation Worker;
- GitHub Sync Worker;
- Budget Reconciliation Worker;
- Artifact/Worktree Cleanup Worker;
- Startup Reconciliation.

Все они живут в одном backend process.

Run Supervisor проверяет process liveness, heartbeat, timeout и cancellation, но не оценивает качество кода.

Scheduler primarily event-driven, periodic tick — safety net.

Transient external errors используют bounded exponential backoff. Auth/permission errors не бессмысленно retry'ятся бесконечно.

Unprocessable durable operation уходит в dead-letter, а не блокирует всю систему.

## 19.5. Согласование при запуске

При startup Scheduler **не включается сразу**.

```text
STARTING
→ RECOVERING
→ DB/migrations
→ Runs
→ Git/worktrees
→ locks
→ budgets
→ Outbox/jobs
→ GitHub state
→ SYSTEM_RECONCILED
→ READY
```

Состояния системы:

```text
STARTING
RECOVERING
READY
PAUSED
DEGRADED
SHUTTING_DOWN
```

Graceful shutdown сначала прекращает новые dispatch, пытается checkpoint/cancel runtime и flush state; при timeout выполняется forced termination с последующим `INTERRUPTED` recovery.

Backend защищён single-instance lock. Worker leases дополнительно предотвращают duplicate ownership.

---

# 20. Хранение, конфигурация и миграции

Хранение разделено на три слоя.

## 20.1. Версионируемое состояние репозитория

```text
<repo>/.ebb-orchestrator/
```

Здесь project config, workflows, Guidelines, Decisions.

## 20.2. Локальное постоянное состояние и состояние среды выполнения

```text
~/.ebb-orchestrator/
├── ebb-orchestrator.db
├── artifacts/
├── runtime/
├── logs/
└── backups/
```

## 20.3. Безопасное хранилище

Credentials/secrets хранятся отдельно через platform-appropriate secure storage.

Каждый persistent format имеет `schema_version`.

App version и config schema version независимы. Backend знает supported schema range и не пытается «угадать» формат слишком новой конфигурации.

Project config migrations бывают:

- format migration — deterministic/automatic;
- semantic migration — если старое правило нельзя однозначно сопоставить новой модели, требуется review/approval.

SQLite migration history хранится в `schema_migrations`.

Порядок запуска:

```text
open DB
→ integrity/quick check
→ DB migrations
→ RECOVERING
→ reconciliation
→ READY
```

Перед DB schema upgrade создаётся backup.

Downgrade не реализуется reverse migrations; пользователь восстанавливает pre-upgrade backup и предыдущую версию приложения.

SQLite использует:

- WAL mode;
- foreign keys;
- транзакции;
- ограничения/unique constraints там, где они защищают invariants.

Важные domain entities не удаляются без необходимости; чаще используются status/archive semantics.

Внутренние primary keys — opaque stable IDs (UUID/ULID или аналог). Human display numbers project-local:

```text
TASK-42
EPIC-7
```

Приоритет конфигурации:

```text
Global defaults
→ Project override
→ Role override
→ Task/Epic override
```

Обычная настройка — более specific override. Security — most-restrictive-wins.

Каждый AgentRun сохраняет effective config/contract/knowledge versions, с которыми реально работал.

Unknown fields в versioned config не игнорируются молча — это validation error.

Secrets в repository config указываются только как logical reference, а не raw value.

Artifact paths по возможности хранятся относительно Orchestrator home. Artifact/config writes выполняются atomically через temp + rename/verification.

Изменения `.ebb-orchestrator/` должны коммититься как отдельные понятные Git operations, а не случайно смешиваться с кодом Developer.

---

# 21. Тестирование, надёжность и область v1

## 21.1. Принципы тестирования

Критическая логика Orchestrator должна полностью тестироваться **без LLM**.

```text
Unit tests
→ Module integration tests
→ Scenario/workflow tests
→ Adapter contract tests
→ limited real-Hermes smoke tests
→ separate AI behavioral evals
```

`FakeAgentRuntime` — first-class adapter, совместимый с `AgentRuntime`.

Он позволяет скриптовать:

```text
success
changes requested
timeout
crash
rework
recovery
```

и прогонять полный workflow без tokens/cost.

Обязательные тестовые зоны:

- Workflow Engine;
- Permission Engine;
- dependency graph;
- Scheduler;
- resource locks;
- budgets/reservations;
- Recovery/Loop Detector;
- Context Selector/Budget;
- config inheritance;
- Output Validator;
- state-machine invariants.

Dependency graph/state machine полезно дополнительно проверять property-based tests.

Git subsystem тестируется на реальных temporary repositories/worktrees.

Критический кейс:

```text
Task starts from target SHA A
another Task updates target to SHA B
first Task finishes
Integration must validate against current SHA B
```

Crash consistency проверяется test-only failpoints вокруг:

- Git operations;
- DB commit;
- outbox acknowledgement;
- budget reservation;
- AgentRun startup.

Каждый durable handler проходит duplicate-delivery/idempotency tests.

Security tests проверяют технические границы:

- outside-worktree access;
- symlink/junction escape;
- secret leakage;
- local API auth/Origin/CSRF;
- sanitization untrusted UI content.

Real Hermes tests проверяют adapter contract: start/resume/cancel, tool exposure, structured submit, usage collection.

AI behavioral evals отделены от обязательного CI. Их запускают при изменении model/prompt/schema/context policy.

Normal CI должен стоить 0 AI tokens.

## 21.2. Что входит в v1

- local backend + Web UI;
- modular monolith;
- SQLite/migrations;
- Event Bus + Outbox + Jobs;
- startup reconciliation;
- project onboarding;
- `.orchestrator/` configuration;
- Project/Epic/Task/Dependency/Proposal/Decision;
- все 9 Role Contracts;
- HermesRuntimeAdapter как единственный real Agent Runtime;
- LocalExecutionAdapter как единственный execution backend;
- `standard`, `bugfix`, `architecture_change`, `documentation`, `devops`;
- standalone workflow;
- полный Epic workflow;
- Git branches/worktrees;
- Scheduler;
- Recovery;
- Permission Engine/Action Gateway;
- structured `submit_result`;
- Context Engine;
- Guidelines/Decisions lifecycle;
- Usage/Budget;
- optional basic GitHub integration;
- manual final merge approval;
- утверждённая Web UI information architecture.

## 21.3. Что явно не входит в v1

```text
Distributed workers
Cloud control plane
Multi-user collaboration
Organizations / teams
Multi-user RBAC
Remote agents
ContainerExecution implementation
Kubernetes
GitLab adapter
Jira adapter
Linear adapter
Additional AgentRuntime adapters
Nested Epics
Visual Workflow Builder
Vector DB
Full repository semantic indexing
Autonomous production deployment
Automatic final merge by default
GitHub webhooks
GitHub Projects
Mobile UI
```

Enterprise extension points не должны усложнять v1.

## 21.4. Порядок реализации

### Stage 1 — Foundation

SQLite, migrations, config, IDs, Artifacts, Event Bus/Outbox, Jobs, logging.

### Stage 2 — Work + Workflow

Project/Epic/Task/Dependency/Proposal/Decision, Workflow Engine, Approvals, FakeAgentRuntime.

### Stage 3 — Scheduler + Recovery

Parallel limits, Resource Locks, priorities, run lifecycle, Recovery, no-progress/loop detection.

### Stage 4 — Git + Worktrees

Git Manager, Worktree Manager, GitOperation journal, Task/Epic branches, integration workspaces, reconciliation.

### Stage 5 — Security / Execution

Action Gateway, Permission Engine, filesystem/Git/project command tools, secret/env isolation.

### Stage 6 — Hermes Runtime

Hermes adapter, session lifecycle, start/resume/cancel, controlled tools, `submit_result`, usage collection. Сначала только Developer на manually created Task.

### Stage 7 — Vertical Slice 1: Autonomous Task

Reviewer + QA + Integration.

```text
Human-created Task
→ Developer
→ Reviewer
→ QA
→ Integration
→ manual merge
```

### Stage 8 — Vertical Slice 2: Request → Completed Task

Добавляется Coordinator planning/classification.

### Stage 9 — Vertical Slice 3: Large Feature / Epic

PM + Architect + Epic planning + parallel Task + Epic Review/QA/final integration.

### Stage 10 — Advanced context/knowledge + Usage UI + optional GitHub

Укрепляются Guideline/Decision lifecycle, Context Budget/Delta, dashboards и базовый GitHubAdapter.

## 21.5. Приёмочные тесты v1

### Autonomous Task

На test repository пользователь создаёт Task:

> Add `/health` endpoint returning `{status:'ok'}`.

Ожидается:

1. Orchestrator создаёт branch/worktree.
2. Developer реализует изменение.
3. Reviewer PASS либо формирует bounded rework.
4. QA проверяет Acceptance Criteria.
5. Integration проверяет против текущего target.
6. Orchestrator просит финальный merge approval.
7. После approval Merge Service merge'ит в `master`.
8. Worktree cleanup, Audit, Usage и Task `DONE` корректны.
9. Kill/restart backend не теряет committed work и не создаёт duplicate merge.

### Epic

Крупный запрос превращается в validated Epic с несколькими dependent/parallel Task. Каждая child Task проходит Dev → Review → QA → Integration в Epic branch. После required Tasks выполняются Epic Review, optional Architecture Review, Epic QA, final current-`master` integration и user approval. После merge Epic становится DONE, child Tasks — RELEASED.

## 21.6. Definition of Done для v1

v1 считается готовым, когда:

- local Git project можно onboard;
- standalone Task и Epic проходят реальные workflow;
- Hermes работает только через controlled runtime/tools;
- каждая Task имеет isolated worktree;
- Reviewer/QA независимы от Developer;
- Scheduler прозрачно управляет concurrency/dependencies/locks;
- Recovery переживает kill/restart;
- final merge требует человека;
- AI не может выдать себе permissions или изменить final merge policy;
- usage/cost полностью attributable to Run;
- Guidelines/Decisions переживают sessions;
- persistence/config migrations и backup работают;
- deterministic core tests не требуют LLM;
- local workflow не зависит от GitHub;
- системой можно управлять через Web UI без обязательного CLI workflow.

---

# Приложение A — утверждённая архитектура Web UI

Все перечисленные ниже концепты были отдельно просмотрены и утверждены.

## Dashboard

Показывает Running agents, Active work, Need approval, AI spend, Active projects, Approval Inbox summary, Execution Queue, Agent Pool и Coordinator Chat. Основные действия — Pause All и New Request.

Концепт: `01-dashboard-concept.html`.

## Project View

Repository/path/default branch/GitHub status, Overview/Epics/Tasks/Runs/Git/Guidelines/Usage, active Epic, dependency state, runtime/isolation/parallel/merge settings, activity, budget и project-scoped Coordinator.

Концепт: `06-project-view-concept.html`.

## Epic View

Жизненный цикл Epic, parallel work graph, Task status/agents, Epic Contract, branch state, approvals/blockers, budget/events и финальные Epic Review / Architecture Review / Epic QA / Merge stages.

Концепт: `03-epic-view-concept.html`.

## Task View

Workflow Dev → Review → QA → Integration → Epic/master, Task Contract, Agent Runs, Review findings, QA defects, Git/worktree/PR state, Recovery, Usage, Dependencies и events.

Концепт: `02-task-view-concept.html`.

## Approval Inbox

Только реальные human gates: Plans, Architecture, Permissions, Budget, Merge. Detail panel показывает что запрашивается, почему, impact/evidence и Approve / Reject / Request Changes.

Концепт: `04-approval-inbox-concept.html`.

## Execution Queue / Agents Monitor

Running / Queued / Blocked / Waiting approval, scheduler capacity, точная причина ожидания, Resource Locks, scheduler events, Pause / Cancel / Stop All Agents.

Концепт: `05-execution-queue-concept.html`.

## Agent Run Detail / Live Logs

Live observable events, controlled tool calls, sanitized terminal output, permission decisions, runtime/session/attempt/resume, usage, recovery/loop signals, Context Package и checkpoint controls.

UI показывает **наблюдаемые действия и результаты**, но не скрытую chain-of-thought модели.

Концепт: `10-agent-run-detail-concept.html`.

## Usage & Budget

Spend/tokens/cache/recovery share, budgets, spend by role/reason, deterministic `$0` checks, anomalies, model comparison и effective cost.

Концепт: `09-usage-budget-concept.html`.

## Settings / Project Configuration

General, Roles & Models, Workflows, Runtime, Scheduler, Recovery, Permissions, Git & GitHub, Budgets, Guidelines, Secrets.

Hierarchy:

```text
Global defaults
→ Project overrides
→ Role overrides
→ Task/Epic override
```

Security остаётся most-restrictive-wins.

Концепт: `08-settings-concept.html`.

## Project Onboarding

Repository → Discovery → Review Findings → Approve Config → Activate Project. DETECTED и PROPOSED визуально разделены. Показывается, какие `.orchestrator/*` файлы будут созданы, а secrets/runtime state остаются локальными.

Концепт: `07-project-onboarding-concept.html`.

---

# Приложение B — фундаментальные инварианты

1. AI не изменяет domain workflow state напрямую.
2. AI не выделяет authoritative Task/Epic IDs.
3. Scheduler — единственный authority для dispatch Agent Runs.
4. Recovery не обходит Scheduler/budget/permissions.
5. Final merge выполняет deterministic Merge Service после required checks и approval.
6. Один managed worktree имеет не более одного active writer.
7. Epic child Task target'ит Epic branch, а не `master`.
8. Child Task не становится `RELEASED` до merge Epic в `master`.
9. Blocking dependency должна быть выполнена до runnable Task.
10. Dependency cycle недопустим.
11. Domain state + durable Outbox event записываются одной transaction.
12. Durable event handlers idempotent.
13. После restart сначала reconciliation, затем новые AI Runs.
14. Hermes не имеет прямого доступа к SecretStore/GitHub credentials/unrestricted filesystem.
15. Run не может выдать себе tools/permissions/policy/final merge authority.
16. Security config использует most-restrictive-wins.
17. `PASS` output не может противоречить собственным blocking evidence.
18. Source code читается on demand, а не дампится в каждый initial prompt.
19. Long-term knowledge живёт в project state, а не в вечной conversation.
20. Недоступность GitHub не препятствует local workflow.
21. Final integration всегда проверяется против текущего target branch.
22. Task/Epic contracts и Guidelines/Decisions versioned; AgentRun сохраняет использованные версии.
23. Reviewer/QA findings сохраняют стабильную identity между re-runs.
24. External semantic changes не становятся approved policy автоматически.
25. Routine deterministic checks никогда не вызывают LLM только ради «контроля».

---

# Приложение C — граница архитектуры v1

Эта архитектура намеренно сначала строит надёжный single-user local orchestrator, а не distributed AI-development platform.

Ports для Container Execution, других Agent Runtimes, других Git hosting providers и будущей collaboration существуют заранее, но эти будущие возможности не должны усложнять или дестабилизировать v1.

Итоговая формулировка продукта:

> **Local-first Web-приложение, которое превращает Git-репозиторий в управляемую виртуальную software-команду: AI выполняет интеллектуальную работу, а Orchestrator детерминированно контролирует workflow, Git, permissions, recovery, approvals, context, persistence и расходы.**
