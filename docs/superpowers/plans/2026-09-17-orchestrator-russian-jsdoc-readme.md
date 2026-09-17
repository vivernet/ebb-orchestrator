# Ebb AI Development Orchestrator — Russian JSDoc & README Documentation Pass

> **Для agentic workers:** ОБЯЗАТЕЛЬНО использовать `superpowers:subagent-driven-development`. Для независимых непересекающихся модулей допускается `superpowers:dispatching-parallel-agents`. Каждый субагент получает эксклюзивный набор файлов. Финальный review выполняет отдельный агент, который не писал документацию.

**Цель:** После завершения Plans 1–6 и Final V1 Audit & Hardening привести весь first-party код Ebb AI Development Orchestrator к единому стандарту русскоязычного JSDoc, закрепить этот стандарт через `eslint-plugin-jsdoc` и полностью переписать корневой `README.md` как полноценную техническую документацию проекта.

**Архитектура:** Это documentation-only milestone. Он не меняет поведение приложения, публичные контракты, workflow, БД, security model или архитектуру. Работа выполняется в отдельном worktree; Coordinator сначала подключает lint-policy и строит карту файлов, затем раздаёт непересекающиеся области специализированным documentation-субагентам. Отдельный README-субагент переписывает только `README.md`. После этого независимый reviewer проверяет точность комментариев по реализации и спецификации, а финальный этап переводит JSDoc lint-rules из migration-mode в обязательные ошибки.

**Tech Stack:** TypeScript, JavaScript, ESLint flat config, `eslint-plugin-jsdoc`, pnpm, Markdown.

**Основные источники истины:**
- `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`
- `docs/superpowers/plans/2026-09-16-orchestrator-v1-roadmap.md`
- канонические Plans 1–6;
- итоговый Final V1 Audit & Hardening report;
- текущий код после всех исправлений аудита.

## Глобальные ограничения

- Запускать этот milestone только после того, как Plans 1–6 и Final V1 Audit & Hardening интегрированы в `master`.
- Работать только в отдельной ветке/worktree, не на `master`.
- Все пользовательские ответы, промежуточные отчёты, review findings и финальный отчёт писать на русском языке.
- Все новые JSDoc-комментарии писать на грамотном русском языке.
- Имена классов, методов, API, полей, enum, Git refs, команды, пути, протоколы и другие технические идентификаторы не переводить.
- Не изменять runtime-поведение ради документации.
- Не переименовывать публичные API, классы, функции, типы или поля.
- Не менять сигнатуры, domain states, migrations, SQL, workflow transitions, security policy или permissions.
- Не выполнять unrelated refactoring.
- Не исправлять найденные функциональные баги в рамках JSDoc-прохода. Зафиксировать их как finding и продолжить документацию.
- Разрешены только минимальные технические изменения, необходимые непосредственно для lint/JSDoc-инфраструктуры и исправления комментариев.
- Не удалять существующие полезные комментарии без понимания их назначения.
- Не добавлять JSDoc, который просто дословно повторяет имя функции или TypeScript-сигнатуру.
- Не описывать поведение, которого нельзя доказать по коду, спецификации или тестам.
- Если назначение/invariant неясны, оформить finding вместо выдумывания объяснения.
- Не использовать AI-generated комментарии как источник истины: каждый комментарий должен быть проверен по реализации.
- Не документировать generated/vendor code как first-party API.
- Tests не требуют тотального JSDoc; документировать только reusable test helpers/fixtures с действительно неочевидным контрактом.
- В конце milestone `pnpm lint`, `pnpm typecheck`, `pnpm test`, build-команды проекта и `git diff --check` должны проходить.
- После финального commit `git status --short` должен быть пустым.

---

# Стандарт русского JSDoc

## Что обязательно документировать

JSDoc обязателен для:

- exported classes;
- exported functions;
- exported React components/hooks;
- exported interfaces;
- exported type aliases, если они описывают domain/public contract;
- exported enums;
- публичных методов сервисов и адаптеров;
- методов/функций с важными side effects;
- security-sensitive кода;
- Permission Engine / Action Gateway;
- Git/worktree/merge/reconciliation операций;
- workflow/state transition logic;
- recovery/retry/loop-detection;
- budget/concurrency/resource-lock logic;
- persistence operations с неочевидной transaction boundary;
- Hermes/runtime/context/MCP integration;
- функций с важными preconditions/postconditions;
- функций, которые намеренно выбрасывают значимые ошибки;
- сложных внутренних helpers, где без комментария трудно понять алгоритм или invariant.

JSDoc обычно не требуется для:

- очевидных private getters/setters;
- trivial mappers;
- коротких локальных helpers с полностью самодокументируемым названием;
- простых test-local variables;
- generated files;
- fixture data без reusable contract;
- импортов/экспортов;
- кода, где комментарий лишь перефразирует одну строку реализации.

## Что должен объяснять хороший комментарий

Приоритет:

1. назначение;
2. почему этот компонент существует;
3. важные invariants;
4. side effects;
5. границы доверия/security;
6. preconditions;
7. ошибки;
8. неочевидный результат.

Комментарий не должен пересказывать TypeScript.

Плохо:

```ts
/**
 * Возвращает проект.
 *
 * @param id ID проекта.
 * @returns Проект.
 */
```

Хорошо:

```ts
/**
 * Загружает проект как текущий authoritative orchestration context.
 *
 * Метод не доверяет репозиторному `.orchestrator`-конфигу автоматически:
 * trust level проекта должен быть определён до использования локальных правил.
 *
 * @param id Идентификатор проекта в локальном состоянии Orchestrator.
 * @returns Текущая запись проекта с вычисленным trust level.
 * @throws {ProjectNotFoundError} Если проект отсутствует в локальном состоянии.
 */
```

## Правила тегов

- Не дублировать TypeScript-типы в `{Type}` внутри `@param`/`@returns`.
- Для публичного callable API использовать `@param` для параметров, если их назначение не тривиально.
- `@returns` использовать, когда смысл результата требует пояснения.
- `@throws` указывать только для значимых документированных исключений.
- `@example` использовать только там, где пример действительно упрощает использование API.
- `@deprecated` использовать только для реально deprecated API.
- Не добавлять фиктивные `@returns`, `@throws` или `@example` ради прохождения lint.
- Описание тега должно быть полноценным русским объяснением, если тег присутствует.

## Особые требования по подсистемам

### Security
Комментарий должен пояснять trust boundary, недоверенный ввод, смысл ALLOW/ASK/DENY/ABSOLUTE_DENY и проверки, которые нельзя обходить.

### Git
Комментарий должен пояснять target repository/worktree, hooks, network side effects, journal/reconciliation semantics и postconditions.

### Workflow
Комментарий должен пояснять допустимый исходный state, target state, guards/approvals и сохраняемый invariant.

### Persistence
Комментарий должен пояснять transaction/idempotency boundary, если она неочевидна.

### Hermes / Agent Runtime
Комментарий должен отличать scoped session, profile, context, capability, authoritative structured result и диагностический stdout/stderr.

---

# Task 1 — Создать documentation worktree и baseline

**Ветка:** `docs/russian-jsdoc-readme`

**Worktree:** `../orchestrator-russian-jsdoc`

- [ ] **Step 1: Проверить master**

```bash
git status --short
git branch --show-current
```

Ожидается `master` и пустой status.

- [ ] **Step 2: Создать worktree**

```bash
git worktree add ../orchestrator-russian-jsdoc -b docs/russian-jsdoc-readme master
```

- [ ] **Step 3: Установить зависимости и снять baseline**

```bash
cd ../orchestrator-russian-jsdoc
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Все baseline-команды должны проходить до изменения документации. Если нет — зафиксировать как pre-existing finding и не маскировать.

- [ ] **Step 4: Зафиксировать baseline в execution ledger**

Записать SHA `master`, версии Node/pnpm, количество test suites/tests и результат quality gates.

---

# Task 2 — Подключить eslint-plugin-jsdoc в migration-mode

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `eslint.config.js`
- Create: `docs/development/jsdoc-style-guide.md`

**Interfaces:**
- Produces: единая JSDoc-policy для всех следующих documentation agents.
- Does not change: runtime code.

## Версия

На момент подготовки плана актуальна `eslint-plugin-jsdoc@64.5.1`.

Если к моменту исполнения эта версия несовместима с фактическими Node/ESLint constraints репозитория, использовать newest compatible release и явно зафиксировать deviation в ledger. Не выполнять major toolchain migration ради JSDoc.

- [ ] **Step 1: Установить plugin**

```bash
pnpm add -D eslint-plugin-jsdoc@64.5.1
```

- [ ] **Step 2: Настроить TypeScript-aware flat config**

Использовать TypeScript-aware flat config `eslint-plugin-jsdoc`.

Migration-mode должен:
- проверять корректность JSDoc;
- проверять соответствие имён `@param`;
- требовать непустые descriptions;
- обнаруживать отсутствующий JSDoc у first-party exported API;
- на этапе migration выдавать новые coverage-проблемы как `warn`, а не как финальный `error`.

Scope first-party production code:

```text
apps/server/src/**/*.{ts,tsx}
apps/web/src/**/*.{ts,tsx}
packages/*/src/**/*.{ts,tsx}
```

Исключить:

```text
**/node_modules/**
**/dist/**
**/build/**
**/coverage/**
**/generated/**
apps/server/test/e2e/fixtures/**
```

Tests не включать в обязательный `require-jsdoc`.

Для `require-jsdoc` ограничить проверку публичным/exported API (`publicOnly` для ESM) и TypeScript declarations, а не всеми локальными функциями.

- [ ] **Step 3: Не требовать избыточные TypeScript type annotations в JSDoc**

Не вводить policy, которая заставляет писать `@param {string} id`, если `id: string` уже указан TypeScript.

- [ ] **Step 4: Написать style guide**

`docs/development/jsdoc-style-guide.md` должен содержать:
- scope;
- обязательные/необязательные случаи;
- правила русского языка;
- правила tags;
- хорошие/плохие примеры;
- security/Git/workflow/persistence/Hermes examples;
- правило «не выдумывать поведение»;
- правило findings;
- правило для новых exported API.

- [ ] **Step 5: Проверить plugin на representative files**

Убедиться, что undocumented exported API обнаруживается, корректный русский JSDoc принимается, TypeScript syntax работает, а tests/fixtures не получают массовые false positives.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml eslint.config.js docs/development/jsdoc-style-guide.md
git commit -m "chore: establish russian jsdoc policy"
```

---

# Task 3 — Построить карту покрытия и безопасно разбить работу

**Owner:** Coordinator only.

Никакой production-файл на этом шаге не изменять.

- [ ] Инвентаризировать `apps/server/src/`, `apps/web/src/`, `packages/*/src/`.
- [ ] Для каждого файла определить: `PUBLIC_API`, `DOMAIN_LOGIC`, `SECURITY_SENSITIVE`, `COMPLEX_INTERNAL`, `TRIVIAL_INTERNAL`, `GENERATED_OR_EXTERNAL`.
- [ ] Сформировать exclusive ownership map.

Рекомендуемая разбивка:

```text
Agent A — Work / Workflow / Scheduler / Recovery / Usage
Agent B — Git / Execution / Permissions / Security / Process
Agent C — Hermes / Runtime / Context / MCP / Role Contracts
Agent D — Projects / Persistence / Events / Jobs / API / Platform
Agent E — Web UI / GitHub integration
Agent F — packages/contracts + reusable packages/testing API
Agent G — README.md only
```

Если реальная структура после Plan 6 отличается — использовать текущие module boundaries.

Shared files (`eslint.config.js`, `package.json`, `pnpm-lock.yaml`, `README.md`, shared barrels) не отдавать нескольким агентам.

Assignment map записать в execution ledger.

---

# Task 4 — Domain / Workflow / Scheduler / Recovery / Usage

**Owner:** fresh documentation subagent.

**Scope only:** соответствующие first-party server modules.

- [ ] Прочитать design sections и код целиком.
- [ ] Добавить русский JSDoc согласно style guide.
- [ ] Особенно документировать state transitions, dependencies, scheduler priority/resource locks, recovery/no-progress и budget invariants.
- [ ] Не менять поведение.
- [ ] Функциональный дефект → finding, не исправление.
- [ ] Targeted ESLint.
- [ ] Server typecheck.
- [ ] Связанные unit/scenario tests.
- [ ] Self-review diff.
- [ ] Commit: `docs: document domain workflow and recovery`

---

# Task 5 — Git / Execution / Permissions / Security

**Owner:** fresh documentation subagent.

**Scope only:** Git, execution, permissions, security и process modules.

- [ ] Изучить security model и Git design.
- [ ] Документировать trust boundaries, Action Gateway, Permission Engine, path containment, shell classification, environment isolation.
- [ ] Для Git описывать hooks/network/journal/reconciliation semantics.
- [ ] Не писать security guarantees, которых код не обеспечивает.
- [ ] Расхождение с design → finding.
- [ ] Targeted ESLint.
- [ ] Typecheck.
- [ ] Git/security tests.
- [ ] Commit: `docs: document git execution and security`

---

# Task 6 — Hermes / Runtime / Context / MCP

**Owner:** fresh documentation subagent.

- [ ] Отличать `AgentRuntime` abstraction от Hermes implementation.
- [ ] Документировать session/profile/context/capability lifecycle.
- [ ] Документировать `submit_result` как authoritative structured output boundary.
- [ ] Пояснить bounded repair attempts и validation semantics.
- [ ] Не описывать stdout как authoritative result, если это не так.
- [ ] Targeted ESLint.
- [ ] Typecheck.
- [ ] Hermes/runtime/context tests.
- [ ] Commit: `docs: document hermes runtime and context`

---

# Task 7 — Projects / Persistence / Events / Jobs / API

**Owner:** fresh documentation subagent.

- [ ] Документировать transaction/idempotency boundaries.
- [ ] Документировать startup `STARTING → RECOVERING → READY`.
- [ ] Документировать authoritative ownership между Git/SQLite/repo config.
- [ ] Не добавлять JSDoc внутрь SQL только ради покрытия.
- [ ] Targeted ESLint.
- [ ] Typecheck.
- [ ] Persistence/startup/API tests.
- [ ] Commit: `docs: document platform persistence and api`

---

# Task 8 — Web UI / GitHub Integration

**Owner:** fresh documentation subagent.

- [ ] Документировать exported React components/hooks/services только там, где JSDoc добавляет смысл.
- [ ] Для UI actions пояснять backend authority, если frontend не является security boundary.
- [ ] Для GitHub adapter описать optional integration, sync/idempotency и credential boundary.
- [ ] Не описывать GitHub как обязательный для local workflow.
- [ ] Targeted ESLint.
- [ ] Web typecheck/build/tests.
- [ ] GitHub adapter tests.
- [ ] Commit: `docs: document web and github integration`

---

# Task 9 — Shared contracts and reusable packages

**Owner:** fresh documentation subagent.

- [ ] Документировать exported domain contracts.
- [ ] Для union/enums описывать смысл состояний, а не literal values.
- [ ] Для interfaces документировать поля только если semantics/units/nullability неочевидны.
- [ ] Не перегружать очевидные поля комментариями.
- [ ] Targeted ESLint.
- [ ] Package typecheck/tests.
- [ ] Commit: `docs: document shared contracts`

---

# Task 10 — Полностью переписать README.md

**Owner:** отдельный README documentation agent.

**Exclusive ownership:** только `README.md`.

README Agent не изменяет source code, package scripts или config.

## Источники

Перед написанием прочитать:
- design specification;
- final v1 audit report;
- root `package.json`;
- workspace structure;
- `.env.example`, если существует;
- actual configuration schema;
- server/bootstrap commands;
- Web UI commands;
- Hermes integration;
- GitHub adapter behavior;
- current directory structure.

Не копировать старый README как основу. Старый README — только один из источников фактов.

## Язык

Основной `README.md` — на русском языке. Technical names, commands, package names и identifiers оставлять в исходном виде.

## Обязательные разделы README

1. `# Ebb AI Development Orchestrator`
2. Краткое описание продукта.
3. Ключевые реально реализованные возможности.
4. Архитектурные принципы: deterministic-first, modular monolith, Ports & Adapters, local-first, Git/SQLite ownership, worktrees, Action Gateway/Permission Engine, Reviewer/QA, approvals, recovery.
5. High-level архитектура; Mermaid только если соответствует реальному wiring.
6. Роли агентов и реальная ответственность.
7. Требования: фактические Node.js/pnpm/Git/Hermes/OS requirements.
8. Быстрый старт с реально существующими командами.
9. Запуск backend и Web UI.
10. Структура репозитория.
11. Lifecycle standalone Task.
12. Lifecycle Epic.
13. Hermes Runtime: profiles/sessions/MCP/structured result/isolation.
14. Security Model, включая явное предупреждение: Local Mode — policy isolation, не OS sandbox.
15. Git и worktrees.
16. Конфигурация и precedence только по реальным keys.
17. Локальные данные и Orchestrator home layout.
18. GitHub integration и её optional/failure semantics.
19. Quality/Testing с реальными командами.
20. Troubleshooting по реальным failure modes.
21. Ограничения v1.
22. Development/Contributing: tests, Russian JSDoc, lint, workflow/security rules.
23. License — только если лицензия реально есть.

## Запрещено в README

- выдуманные badges/CI links;
- несуществующие команды;
- неподтверждённые performance claims;
- future features как current;
- fake screenshots;
- fake package names;
- secrets/tokens;
- выдуманная лицензия.

- [ ] Проверить каждую команду Quick Start/Development по `package.json` и config.
- [ ] Сверить архитектурные утверждения с кодом.
- [ ] Commit: `docs: rewrite project readme`

---

# Task 11 — Documentation Findings Pass

**Owner:** Coordinator.

Собрать findings от всех documentation agents:

```text
ID
Module
Severity
Observed behavior
Conflicting spec/design expectation
Evidence
Why documentation could not be written confidently
Suggested follow-up
```

Documentation branch не исправляет functional defects. Blocker security/data-loss finding немедленно сообщается пользователю; остальные сохраняются для отдельного repair milestone.

---

# Task 12 — Независимый Documentation Review

**Owner:** fresh reviewer, не писавший документацию.

Reviewer читает полный diff `master...HEAD`.

Проверить:

- точность JSDoc по implementation;
- особенно Security/Git/Workflow/Recovery/Budget/Persistence/Hermes/Context/GitHub;
- грамотный технический русский;
- отсутствие шаблонных и бесполезных комментариев;
- exported API coverage;
- отсутствие runtime changes;
- README по фактам и реальным командам.

Для production diff:

```bash
git diff master...HEAD -- '*.ts' '*.tsx' '*.js'
```

Изменения source должны быть документационными, кроме заранее разрешённой lint infrastructure.

Исправить все load-bearing findings и повторить review после существенных исправлений.

---

# Task 13 — Перевести JSDoc lint-policy в обязательный режим

**Owner:** lint-policy agent/Coordinator.

После завершения документации перевести migration warnings в `error`.

Минимальный постоянный набор:

```text
jsdoc/require-jsdoc
jsdoc/require-description
jsdoc/check-param-names
jsdoc/check-tag-names
jsdoc/check-syntax
```

Parameter/return description rules включать как `error` там, где они не заставляют дублировать TypeScript.

Сохранить `publicOnly` scope; не требовать JSDoc для каждой локальной arrow function.

Запустить `pnpm lint`. Не добавлять blanket source excludes ради зелёного результата.

Commit: `chore: enforce jsdoc documentation policy`

---

# Task 14 — Полный финальный quality gate

Запустить:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Запустить все production build scripts, которые реально существуют.

Проверить:

```bash
git status --short
git diff --stat master...HEAD
git log --oneline master..HEAD
```

После всех commit `git status --short` должен быть пустым.

За исключением `eslint.config.js`, `package.json`, `pnpm-lock.yaml` и documentation files изменения `src/**` должны быть только JSDoc/комментариями. Runtime change нужно вернуть или вынести в отдельный approved bugfix.

---

# Task 15 — Финальный отчёт

Ответ пользователю — на русском языке.

Отчёт должен содержать:

## Покрытие
- production files reviewed;
- files changed;
- exported APIs documented;
- осознанные exclusions.

## ESLint
- установленная версия `eslint-plugin-jsdoc`;
- включённые rules;
- scope/exclusions;
- результат `pnpm lint`.

## README
- подтверждение полного rewrite;
- разделы;
- проверенные команды;
- найденные несоответствия старого README.

## Findings

```text
FUNCTIONAL FINDINGS
SECURITY FINDINGS
DOCUMENTATION AMBIGUITIES
```

Если нет — указать явно.

## Verification

Точные результаты:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
build
git diff --check
git status --short
```

## Git
- branch;
- final commit SHA;
- commit list;
- diff stat.

## Статус

Использовать только:

```text
DOCUMENTATION_PASS_COMPLETE
DOCUMENTATION_PASS_COMPLETE_WITH_FINDINGS
DOCUMENTATION_PASS_BLOCKED
```

Не merge в `master`.
Не push.
Остановиться и дождаться решения пользователя.

---

# Финальный acceptance gate

Milestone завершён только если:

- `eslint-plugin-jsdoc` установлен и закреплён в lockfile;
- постоянные JSDoc rules работают как errors;
- exported/public first-party API покрыт русским JSDoc;
- risk-sensitive internal logic имеет полезную документацию;
- комментарии проверены по реализации;
- runtime behavior не изменён;
- `README.md` полностью переписан и соответствует текущему проекту;
- README commands проверены;
- independent documentation review завершён;
- `pnpm lint` PASS;
- `pnpm typecheck` PASS;
- `pnpm test` PASS;
- production builds PASS;
- `git diff --check` PASS;
- working tree clean;
- функциональные проблемы вынесены как findings, а не замаскированы документационными изменениями.
