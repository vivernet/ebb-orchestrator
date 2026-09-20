# Ebb Orchestrator — Final Audit, Remediation and Verification

> **Назначение:** обязательная инструкция для финального полного прохода по Ebb Orchestrator после завершения стадий 1–8.
>
> **Целевая модель:** инструкция должна быть исполнима даже слабой моделью уровня GPT-5.4-nano. Не полагайся на догадки, память или «очевидность». Работай только по доказательствам из текущего репозитория.
>
> **Главная цель:** проверить весь проект, устранить подтверждённые архитектурные, функциональные, security, persistence, Git, recovery, runtime, build и quality-проблемы, реально прогнать проект и тесты, устранить все project-controlled failures, привести документацию к фактическому состоянию и только затем сделать финальный commit.
>
> **Важно:** стадии 1–8 уже выполнены. Их нельзя начинать заново, перепроектировать без причины или повторно реализовывать как новые этапы.

---

# 0. Жёсткие правила выполнения

## 0.1. Не более 2 субагентов одновременно

Это абсолютное правило.

```text
MAX_ACTIVE_SUBAGENTS = 2
```

Одновременно могут работать **не более двух субагентов**.

Если уже работают два субагента:

- все остальные обязаны ждать;
- третий субагент не запускается;
- Coordinator ждёт завершения хотя бы одного активного субагента;
- после завершения результат сначала собирается и просматривается Coordinator;
- только затем запускается следующий ожидающий субагент.

Запрещено обходить лимит:

- nested-subagents;
- запуском субагентов через уже работающего субагента;
- дополнительными background-agent процессами;
- параллельными reviewer/implementer сверх лимита.

Если два задания могут менять одни и те же файлы или один subsystem, выполняй их **последовательно**, даже если второй слот свободен.

Допустимая схема:

```text
Wave 1:
  Subagent A
  Subagent B

wait for at least one completion

Wave 2:
  next waiting subagent
  second slot only if files/subsystems do not overlap
```

Coordinator обязан вести учёт:

```text
RUNNING
WAITING
COMPLETED
```

---

## 0.2. Субагенты обязательны

Coordinator не выполняет весь аудит самостоятельно.

Обязательные направления:

```text
A. Architecture / Domain
B. Scheduler / Runtime / Permissions
C. Persistence / Migrations / Recovery
D. Git / Integration / Worktrees
E. API / Security
F. Testing / Startup / Build
G. Code Quality / Optimization
H. Final Independent Reviewer
```

A–G выполняются волнами с лимитом `MAX_ACTIVE_SUBAGENTS = 2`.

H запускается только после исправлений и полного зелёного verification gate.

---

## 0.3. Сначала доказательства, потом исправления

Запрещено начинать массовый refactoring до завершения первичного аудита.

Рабочая последовательность:

```text
inspect
→ prove
→ reproduce
→ classify
→ fix root cause
→ focused test
→ related tests
→ full verification
→ real startup
→ independent final review
→ documentation
→ final verification
→ commit
```

Не использовать:

```text
guess
→ broad rewrite
→ make tests green somehow
```

---

## 0.4. Не доверять старым PASS/NOT_READY автоматически

В предоставленных audit-документах есть исторические состояния и противоречия.

Поэтому:

- старый audit report — evidence/history;
- architecture review — evidence;
- `PROJECT_STATE.md` — более поздний snapshot, но тоже требует проверки;
- дизайн v1 — нормативная архитектурная база;
- текущий код + tests + runtime — фактическая реализация.

Если документы противоречат друг другу, нельзя выбирать удобный вариант.

Нужно:

```text
inspect current code
→ inspect tests
→ inspect current schema
→ reproduce behavior
→ compare with approved design
→ determine actual truth
→ fix code or stale documentation
```

---

## 0.5. Не расширять Post-v1 scope

`post-v1.md` — roadmap, а не разрешение автоматически реализовывать новые возможности.

Не добавлять без отдельного утверждённого design/proposal:

- Codex/OpenCode runtime adapters;
- Container Mode;
- distributed scheduler/workers;
- multi-user/RBAC;
- GitLab/Bitbucket;
- Linear/Jira;
- vector DB/RAG;
- nested Epics;
- arbitrary workflow engine;
- autonomous deployment;
- enterprise features;
- plugin ecosystem.

Разрешено исправлять только то, что необходимо для корректности, безопасности, надёжности, полноты и release-readiness текущего V1.

---

# 1. Обязательное правило комментариев и JSDoc

Это правило применяется ко **всем изменениям production-кода**, которые будут внесены в ходе этого аудита.

## 1.1. Язык комментариев

Все создаваемые или изменяемые комментарии к production-коду должны быть написаны **на грамотном русском языке**.

Запрещено добавлять новые английские поясняющие комментарии.

Технические идентификаторы не переводятся:

```text
SchedulerService
RunService
AgentRuntime
ActionGateway
PermissionEngine
MergeService
Git
SQLite
Epic
Task
Run
ALLOW
ASK
DENY
ABSOLUTE_DENY
```

Названия классов, методов, полей, enum, state, API, commands и paths сохраняются в исходном виде.

## 1.2. Для документирования API использовать JSDoc

Для публичного/контрактного production-кода использовать **JSDoc**, а не произвольные поясняющие `//`-комментарии.

JSDoc обязателен для создаваемых или существенно изменяемых:

- экспортируемых классов;
- экспортируемых функций;
- React-компонентов;
- hooks;
- публичных interfaces;
- значимых domain type aliases;
- enums;
- публичных методов services/adapters;
- security-sensitive API;
- кода со значимыми side effects;
- lifecycle/invariant-sensitive API;
- Git/worktree/reconciliation;
- workflow transitions;
- persistence/transactions;
- recovery;
- scheduler/budget/concurrency/resource locks;
- Hermes/runtime/context/MCP.

Локальный `//` комментарий допустим только если он объясняет узкий алгоритмический шаг, который невозможно разумно выразить JSDoc-контрактом. Такой комментарий тоже должен быть на русском языке.

## 1.3. Что должен описывать JSDoc

Сначала:

```text
назначение
→ зачем компонент существует
→ значимые invariants
→ trust boundary
→ side effects
→ preconditions
→ важные failure modes
```

Не пересказывать TypeScript-сигнатуру.

Не дублировать TypeScript types в `{Type}` без необходимости.

Использовать теги только по смыслу:

```text
@param
@returns
@throws
@example
@deprecated
```

Каждое описание тега — полное предложение на русском языке.

Не добавлять фиктивные `@returns`, `@throws` или `@example` только ради lint.

## 1.4. Особые требования к JSDoc

### Security

Описывать:

- trust boundary;
- недоверенный input;
- `ALLOW / ASK / DENY / ABSOLUTE_DENY`;
- проверки, которые нельзя обходить.

Не называть Local Mode OS sandbox, если он обеспечивает только policy isolation.

### Git

Описывать:

- repository/worktree target;
- hooks;
- network side effects;
- Git operation journal;
- reconciliation;
- важные postconditions.

### Workflow / Persistence

Описывать:

- допустимые states;
- guards;
- approvals;
- сохраняемый invariant;
- transaction boundary;
- idempotency.

### Hermes / Runtime

Чётко различать:

```text
AgentRuntime
runtime adapter
profile
session
context
capability
submit_result
stdout/stderr
```

`submit_result` — authoritative structured result.

stdout/stderr — diagnostic output.

## 1.5. JSDoc gate

Не ослаблять существующие JSDoc ESLint rules.

Проверить, что production source продолжает удовлетворять активной JSDoc policy.

Если найден старый комментарий на английском в изменяемом участке production-кода, который остаётся актуальным, переписать его на русский JSDoc/русский комментарий в соответствии с этим разделом.

---

# 2. Источники, которые необходимо прочитать до изменений

Сначала найти и прочитать актуальные версии следующих документов, если они существуют в repository:

```text
AGENTS.md
README.md
docs/PROJECT_STATE.md
docs/architecture/specs/2026-09-16-ebb-orchestrator-design.md
docs/architecture/plans/*
docs/**/audit-report*.md
docs/**/architecture-review*.md
docs/**/jsdoc-style-guide.md
docs/**/jsdoc-execution-ledger.md
docs/**/post-v1.md
package.json
pnpm-workspace.yaml
eslint.config.*
tsconfig*.json
vitest.config.*
CI workflows
```

Если путь отличается, найти файл по имени/назначению.

Не считать старый audit report текущим source of truth.

---

# 3. Базовая архитектура V1, которую необходимо сохранить

## 3.1. Общий принцип

Ebb Orchestrator — local-first AI software-development orchestrator.

Ключевой принцип:

```text
Если решение можно надёжно принять обычным кодом,
LLM не должен становиться authoritative decision-maker.
```

Архитектура:

```text
Modular Monolith
+
Ports & Adapters
```

Внешние/adaptable boundaries:

```text
AgentRuntime
GitHosting
ExecutionEnvironment
```

V1 runtime:

```text
HermesRuntimeAdapter
```

## 3.2. Sources of truth

Должны сохраняться:

```text
Git    = source of truth для code/commit history
SQLite = source of truth для orchestration state/history
```

Общая SQLite не даёт модулю права напрямую владеть таблицами другого domain module.

Cross-module взаимодействие должно идти через предусмотренные application APIs/domain events.

## 3.3. Deterministic authorities

Проверить, что deterministic code владеет:

```text
Workflow Engine
Scheduler
Permission Engine
Git/worktree operations
approval gates
Merge Policy
retry/recovery
budget checks/reservations
config validation
output validation
restart reconciliation
```

LLM не должен напрямую:

- менять workflow state;
- создавать authoritative Task/Epic IDs;
- делать final merge по собственному решению;
- обходить Scheduler;
- обходить Permission Engine;
- обходить approval;
- считать текстовый output authoritative без validation.

## 3.4. Authoritative runtime path

Для durable AI execution должен сохраняться путь:

```text
Scheduler
→ RunService.prepareRun()
→ RunService.executePreparedRun()
→ AgentRuntime
→ validated submit_result
→ durable transition
```

Проверить отсутствие production bypass:

```text
Orchestrator → AgentRuntime directly
```

если это обходит durable RunService lifecycle.

На одну попытку выполнения должен существовать один authoritative Run identity.

## 3.5. Workflow Engine

Workflow Engine — единственный authority для state transitions.

V1 templates:

```text
standard
bugfix
architecture_change
documentation
devops
```

Проверить:

```text
state mutation
+ required domain event/outbox
```

в одной корректной transaction boundary там, где это требуется дизайном.

## 3.6. Scheduler

Scheduler должен быть единственным authority для dispatch.

Перед запуском он должен учитывать применимые:

```text
task readiness
dependencies
workflow stage
global capacity
project capacity
role capacity
resource locks
budget
approvals
pause state
permission/policy prerequisites
```

Проверить:

- single production Scheduler authority;
- нет fallback instance;
- persisted config fail-closed;
- reservation ownership;
- resource-lock ownership;
- stale state reconciliation;
- terminal reclaim;
- deterministic priority behavior.

## 3.7. Task / Epic semantics

Standalone:

```text
Development
→ Review
→ QA
→ Integration
→ final merge approval
```

Epic:

```text
planning
→ Epic branch
→ child Tasks
→ required children integrated
→ Epic Review
→ Architecture Review when required
→ Epic QA/E2E
→ integration with CURRENT master
→ final merge approval
→ real merge
→ Epic DONE
→ children RELEASED
```

Nested Epic не входит в V1.

Task внутри Epic target'ит Epic branch, не `master`.

Child Task становится `RELEASED` только после verified final Epic merge.

## 3.8. Git / Merge authority

Final integration должна быть реальной Git operation.

Ожидаемая семантика:

```text
STARTED
→ actual Git mutation
→ verification
→ VERIFIED
```

Проверить binding к:

```text
approval
integration record
source SHA
target SHA/current master
repository/worktree
```

Запрещён fake `VERIFIED`.

## 3.9. Persistence / migrations

Migrations:

```text
append-only / forward-only
```

Не изменять historical migration, которая уже могла быть применена.

Для новой schema correction создавать новую migration.

Проверить:

- fresh DB bootstrap;
- sequential upgrade;
- transactionality;
- migration order;
- schema constraints;
- migration integrity/checksum behavior;
- no data loss;
- scheduler reservation/lock migration semantics;
- owner/project preservation;
- collision fail-closed.

---

# 4. Известные исторические зоны риска, которые нужно ПЕРЕПРОВЕРИТЬ

Эти пункты не являются автоматическим утверждением, что проблема сейчас существует.

Они являются обязательным checklist текущего аудита.

## RISK-001 — PermissionEngine / ActionGateway

Документы исторически противоречат друг другу: одни snapshots считали SEC-003 unresolved, более поздний snapshot сообщает об интеграции.

Поэтому проверить фактический current code.

Требование:

```text
agent-facing mutation
→ ActionGateway / controlled application path
→ PermissionEngine evaluation
→ capability/policy decision
→ execution
```

Никакой mutation path не должен обходить server-side policy.

Если интеграция уже корректна:

- не переписывать её;
- добавить/исправить tests при пробелах;
- удалить stale documentation claims.

Если не корректна:

- исправить root cause;
- покрыть ALLOW/ASK/DENY/ABSOLUTE_DENY и capability behavior тестами.

## RISK-002 — Startup / migrations / recovery

Исторически фиксировалась проблема доступа к project/schema до migrations и неполного GitReconciler repository context.

Проверить реальный call graph `main.ts`/startup lifecycle.

Желаемый порядок:

```text
process bootstrap
→ acquire single-instance lock
→ open DB
→ run migrations
→ validate schema/config
→ construct services requiring schema
→ reconciliation
→ start workers
→ READY
```

Нельзя:

- читать таблицы до migrations;
- переходить в READY при critical reconciliation failure;
- запускать workers до required recovery;
- запускать migrations/reconciliation дважды через competing paths.

Git reconciliation должен иметь достаточный repository context и не «угадывать» repository path.

Добавить startup/restart tests, если отсутствуют.

## RISK-003 — Dirty worktree deletion

Исторически выявлялся риск:

```text
git worktree remove --force
```

или fallback recursive delete, способный уничтожить dirty user data.

Требование:

- default behavior fail-closed;
- dirty worktree не удаляется автоматически;
- data loss запрещён;
- force destructive removal возможен только если design явно предусматривает отдельное подтверждённое действие;
- отсутствие Git metadata не является основанием молча рекурсивно удалить пользовательские данные.

Добавить tests:

```text
clean managed worktree
dirty managed worktree
untracked files
modified files
missing/corrupt metadata
reconciliation after restart
```

## RISK-004 — GitHub durability

GitHub optional и не является workflow authority.

Проверить:

- sync state;
- polling failures;
- retry;
- restart;
- deduplication/idempotency.

Если важный sync state остаётся process-local и теряется при restart, исправить через существующую persistence/outbox модель.

Не превращать GitHub в source of truth для orchestration.

## RISK-005 — Hermes release gate

Исторически real Hermes E2E был opt-in/skipped.

Проверить актуальное состояние.

Нужно разделить:

```text
deterministic offline wiring verification
live Hermes integration verification
```

Default tests не должны ложно заявлять, что live Hermes проверен.

Если live Hermes требует credentials/model:

- сохранить explicit opt-in live gate;
- выполнить его, если environment доступен;
- иначе честно зафиксировать ENVIRONMENT_LIMITATION.

По возможности default suite должен иметь deterministic fixture, проверяющий production wiring без внешнего API.

## RISK-006 — Production server build/package gate

Исторически web production build существовал, а server production artifact gate отсутствовал.

Проверить текущие scripts.

V1 должен иметь понятный проверяемый ответ:

```text
Что является deployable server artifact?
Как его собрать?
Как его запустить без dev-only toolchain?
```

Если production server build всё ещё не определён:

1. изучить текущий TypeScript/server setup;
2. выбрать минимальный подход, совместимый с существующей architecture/toolchain;
3. не вводить новый framework/bundler без необходимости;
4. добавить canonical build/package/start gate;
5. проверить созданный artifact реальным запуском.

Документировать точную команду.

## RISK-007 — Final independent review

Исторически final reviewer не всегда выполнялся из-за environment/API-key limitation.

В этом проходе final independent review обязателен.

Если субагенты технически недоступны, нельзя возвращать полный PASS.

---

# 5. План работы Coordinator

## Phase A — Baseline

Выполнить:

```bash
git branch --show-current
git status --short
git log -1 --oneline
git worktree list
```

Не менять branch.

Если рабочее дерево содержит pre-existing изменения:

- записать их;
- не удалять;
- не переписывать;
- не включать в commit автоматически, если они не относятся к этой задаче.

## Phase B — Discover commands

Изучить реальные `package.json`.

Не придумывать script names.

Составить таблицу:

```text
install
lint
typecheck
test
build
server build
web build
start
dev
integration
e2e
migration
security
smoke
Hermes E2E
```

Для отсутствующего script:

```text
NOT_DEFINED
```

## Phase C — Baseline verification

До исправлений выполнить все реально существующие canonical gates.

Минимум:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Также:

```bash
pnpm --filter @ebb-orchestrator/web build
```

если script существует.

Запустить server/web по фактическим scripts.

Проверить startup + graceful shutdown.

Все результаты сохранить.

---

# 6. Волны субагентов

Не более двух одновременно.

## Wave 1

```text
Subagent A — Architecture / Domain
Subagent B — Scheduler / Runtime / Permissions
```

После завершения собрать оба отчёта.

## Wave 2

```text
Subagent C — Persistence / Migrations / Recovery
Subagent D — Git / Integration / Worktrees
```

## Wave 3

```text
Subagent E — API / Security
Subagent F — Testing / Startup / Build
```

## Wave 4

```text
Subagent G — Code Quality / Optimization
```

Не запускать ненужного второго агента только ради заполнения slot.

После каждой wave Coordinator:

```text
collect
→ deduplicate
→ classify
→ resolve contradictions
```

Никакой implementation wave не начинается до первичного consolidated findings list.

---

# 7. Формат finding

Каждый finding:

```markdown
### FINDING-ID — Название

Severity: CRITICAL | HIGH | MEDIUM | LOW
Status: CONFIRMED | SUSPECTED | FALSE_POSITIVE

Subsystem:
File / symbol:
Evidence:
Reproduction:
Expected invariant:
Actual behavior:
Impact:
Root cause:
Required fix:
Required tests:
```

Исправлять только `CONFIRMED`.

`SUSPECTED` сначала проверить.

---

# 8. Приоритет исправлений

Исправлять в порядке:

```text
1. data-loss / security / destructive behavior
2. startup / migration / recovery blockers
3. authority bypass / architectural invariants
4. Git / Merge / worktree correctness
5. Scheduler / runtime / permission correctness
6. persistence / outbox / audit / idempotency
7. API / application correctness
8. production build/release gate
9. maintainability with correctness impact
10. evidence-backed optimization
```

---

# 9. Правило исправления каждого дефекта

Для каждого confirmed finding:

```text
1. reproduce or prove
2. create failing regression test when practical
3. run test and confirm expected failure
4. implement smallest root-cause fix
5. update Russian JSDoc where contract/invariant changed
6. run focused test
7. run related subsystem tests
8. inspect diff
9. verify invariant manually
```

Не исправлять симптом, сохраняя неправильную architecture.

---

# 10. Правила implementation-субагентов

Implementation можно делегировать, но:

```text
MAX_ACTIVE_SUBAGENTS = 2
```

И дополнительно:

- overlapping files → sequential;
- overlapping subsystem → sequential;
- один implementation owner на finding cluster;
- Coordinator проверяет diff до следующего overlapping change;
- reviewer не должен автоматически исправлять собственный finding без отдельного implementation step.

Каждый implementation agent получает:

```text
finding
expected invariant
allowed files
tests to add
tests to run
JSDoc rule
forbidden shortcuts
```

---

# 11. Code quality и optimization

После correctness remediation проверить:

- duplicate code;
- duplicate service instances;
- accidental fallback paths;
- dead branches;
- needless process/Git calls;
- repeated database work;
- poor error propagation;
- too-large functions where split materially improves correctness/testability;
- contract inconsistencies;
- unnecessary compatibility code.

Оптимизировать только при доказуемой пользе.

Запрещено:

- cosmetic rewrite;
- huge rename;
- architecture rewrite без finding;
- новый framework;
- dependency churn;
- speculative micro-optimization.

Для каждой optimization:

```text
problem
measurable/obvious cost
change
behavior preserved
test/evidence
```

---

# 12. Full test/fix loop

После всех исправлений предыдущие green results считать устаревшими.

Снова выполнить:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Плюс все существующие:

```text
build
server build/package
web build
integration
e2e
migration
security
smoke
Hermes deterministic tests
Hermes live E2E if environment permits
```

## Любой failure

Цикл:

```text
capture exact failure
→ diagnose
→ reproduce
→ fix root cause
→ focused test
→ failed gate
→ continue full suite
```

Повторять до отсутствия project-controlled failures.

Нельзя завершать работу с известным падающим project-controlled test.

---

# 13. Реальный запуск проекта

После зелёных тестов обязательно снова попробовать реальный запуск.

Проверить:

```text
database open
migrations
service composition
Scheduler
PermissionEngine/ActionGateway wiring
RunService/runtime wiring
reconciliation
workers
HTTP server
Web UI where applicable
graceful shutdown
```

Если есть production artifact:

- собрать;
- запустить именно artifact;
- не подменять production verification запуском только dev server.

---

# 14. Final Independent Reviewer

После fixes + tests + startup создать новый субагент:

```text
Final Independent Reviewer
```

Он не должен быть implementer этих fixes.

Он работает read-only.

Проверяет:

```text
architecture
security
startup
migrations
recovery
permissions
Scheduler
runtime
Git
worktrees
MergeService
API
tests
build/package
JSDoc policy
documentation consistency
```

Особенно проверить RISK-001…RISK-007.

Verdict:

```text
PASS
CHANGES_REQUESTED
```

Если `CHANGES_REQUESTED`:

- Coordinator проверяет finding;
- confirmed blocker исправляется;
- выполняются regression tests;
- full gates повторяются;
- новый independent reviewer запускается только после этого.

Лимит двух субагентов сохраняется.

---

# 15. Documentation reconciliation

После PASS привести документы к одному фактическому состоянию.

Обязательно обновить:

```text
docs/PROJECT_STATE.md
```

Если repository использует другой canonical path — использовать его.

Нужно удалить stale/contradictory claims.

Особенно сверить:

```text
PermissionEngine integration
startup order
GitReconciler repository ownership
dirty worktree policy
GitHub durability
Hermes E2E
server production artifact
startup/shutdown status
final reviewer status
```

`PROJECT_STATE.md` не должен одновременно утверждать, что один finding и FIXED, и unresolved.

---

# 16. Что должно быть в PROJECT_STATE

Минимум:

```markdown
# Ebb Orchestrator — Project State

## Status
- Branch
- HEAD before final commit
- Date
- Verdict

## Purpose

## Architecture Overview

## Sources of Truth

## Core Workflow

## Authoritative Runtime Path

## Scheduler and Resource Ownership

## Permissions and Action Gateway

## Persistence and Migrations

## Recovery and Restart Safety

## Git / Worktrees / Integration

## Epic Semantics

## GitHub Integration

## Hermes Runtime

## Security Boundaries

## Production Build / Packaging

## Main Packages and Modules

## Install

## Build

## Run

## Test

## Verification Results

## Important Architectural Invariants

## Known Limitations

## Changes Made During This Pass

## Final Independent Review
```

Не включать secrets/tokens/passwords.

---

# 17. Финальный verification gate

После обновления документации снова выполнить:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
git status --short
```

И все canonical build/e2e/security/migration/smoke/Hermes gates, которые реально определены.

Затем:

```bash
git diff --stat
git diff
```

Проверить:

- нет accidental generated files;
- нет secret;
- нет disabled tests;
- lint/type rules не ослаблены;
- JSDoc policy не ослаблена;
- новые/изменённые comments на русском;
- historical migrations не переписаны;
- `PROJECT_STATE.md` соответствует current code.

---

# 18. Commit

Только после полного project-controlled PASS.

Сначала:

```bash
git status --short
```

Не включать unrelated pre-existing changes автоматически.

Stage только относящиеся к этому проходу файлы.

Проверить staged diff:

```bash
git diff --cached --stat
git diff --cached
```

Commit message:

```bash
git commit -m "fix: complete final v1 hardening"
```

После:

```bash
git status --short
git log -1 --oneline
```

Рабочее дерево должно быть чистым относительно изменений этого прохода.

Не push.

Не merge в `master`.

Не создавать tag/release.

---

# 19. Критерии итогового verdict

## PASS

Разрешён только если:

```text
all project-controlled blockers fixed
all canonical tests pass
lint pass
typecheck pass
build gates pass
startup verified
shutdown verified
migration/recovery verified
security boundaries verified
dirty worktree safety verified
PermissionEngine wiring verified
GitHub durability verified to declared scope
Hermes gate accurately verified/documented
production server artifact verified
JSDoc rules satisfied
final independent reviewer PASS
documentation consistent
final commit created
```

## PASS_WITH_ENVIRONMENT_LIMITATIONS

Только если project-controlled работа завершена, но конкретная внешняя среда не позволяет выполнить проверку, например live Hermes credentials/model unavailable.

Каждую limitation перечислить точно.

Environment limitation не может скрывать отсутствующий production code/test/build script, который проект обязан иметь.

## CHANGES_REQUIRED

Если остаётся любой project-controlled load-bearing defect.

---

# 20. Финальный отчёт Coordinator

Ответить на русском:

```markdown
# Итог

## Verdict

## Git
- Branch
- Commit
- Working tree

## Subagents
Указать waves и подтвердить, что одновременно никогда не работало >2.

## Confirmed Findings

## Fixed

## False Positives / Resolved Contradictions

## Optimizations

## JSDoc
- Russian comments policy
- JSDoc coverage
- lint result

## Tests and Builds
Команда → результат.

## Runtime Verification
Startup/shutdown/production artifact.

## Architecture
Подтверждённые invariants.

## Remaining Environment Limitations

## Documentation
Обновлённые файлы.

## Final Independent Review

## Commit
SHA + message.
```

---

# 21. Финальное напоминание слабой модели

Не пытайся решить весь проект одним reasoning step.

Работай маленькими проверяемыми блоками.

Всегда:

```text
read
→ inspect
→ test
→ prove
→ fix
→ verify
```

Никогда:

```text
assume
→ rewrite
→ declare success
```

Не более двух субагентов одновременно.

Все комментарии в production-коде — на русском языке.

Публичные и контрактные комментарии — строго качественный JSDoc по правилам проекта.

Технические идентификаторы не переводятся.

Главная цель — не количество изменений, а фактическая корректность, безопасность, надёжность, архитектурная согласованность и воспроизводимый PASS текущего Ebb Orchestrator V1.
