# План миграции процесса разработки Ebb Orchestrator с OpenCode на Hermes

> **Для агентного исполнителя:** выполняй этот план последовательно, задача за задачей. Не ограничивайся пересказом плана.
>
> **Цель:** полностью заменить OpenCode как внешнюю среду, через которую разрабатывается сам Ebb Orchestrator, на Hermes, сохранив существующий формат планов, дисциплину Git/worktree, независимые review-гейты, правила русского JSDoc и жёсткое ограничение не более двух одновременно работающих субагентов.
>
> **Архитектура:** production-runtime Ebb Orchestrator в этом плане не переносится. Сам продукт уже использует `AgentRuntime` / `HermesRuntimeAdapter`. Этот план изменяет только внешний процесс разработки, через который разработчики исполняют `docs/architecture/plans/*.md`. Репозиторные инструкции Hermes хранятся в `.hermes.md`, исходные версии skills — в `tools/hermes/skills/`, а `scripts/hermes-dev.mjs` синхронизирует их с активным профилем Hermes и предоставляет команды настройки, проверки и запуска планов.
>
> **Технологии:** Node.js 24+, pnpm, Git, Hermes Agent CLI/Desktop, Markdown `SKILL.md`, существующий проект TypeScript/React/Vitest.
>
> **Спецификация:** `docs/architecture/specs/2026-09-16-design.md`
>
> **Ключевое различие:** этот план не должен изменять production `HermesRuntimeAdapter`, если только тесты не докажут уже существующий дефект. Заменяется именно внешний workflow разработки:
>
> `OpenCode → /execute-plan`
>
> на:
>
> `Hermes → skills разработки Ebb Orchestrator`.
>
> **Основная ветка:** `master`.

---

# Глобальные ограничения

- Одновременно разрешено запускать **не более 2 субагентов**.
- Nested delegation в этом development-workflow запрещён.
- Hermes не должен самостоятельно создавать дополнительные вложенные worktree для субагентов.
- Нужный worktree заранее выбирает пользователь или Coordinator.
- Все новые или изменяемые комментарии production-кода должны быть на русском языке.
- Публичные и контрактные production API документируются русским JSDoc согласно действующему руководству проекта.
- Нельзя ослаблять lint, typecheck, tests, JSDoc rules, security checks, approvals или Git safeguards.
- Нельзя выполнять merge в `master`, push, tag, release, `reset --hard` или `git clean`.
- Существующие `docs/architecture/plans/*.md` остаются каноническим форматом implementation plans.
- Нельзя удалять `.opencode`, пока не пройдена реальная parity-проверка Hermes.
- В рамках миграции нельзя менять provider/model/API credentials.
- Нельзя менять production-архитектуру Ebb Orchestrator только ради удобства нового development-workflow.
- Необходимо сохранять все посторонние pre-existing изменения рабочего дерева.

---

# Ожидаемое конечное состояние

После выполнения плана структура development-tooling должна выглядеть примерно так:

```text
repo/
├── .hermes.md
├── package.json
├── scripts/
│   └── hermes-dev.mjs
├── tools/
│   └── hermes/
│       ├── README.md
│       ├── skills/
│       │   ├── ebb-execute-plan/
│       │   │   └── SKILL.md
│       │   ├── ebb-implement-task/
│       │   │   └── SKILL.md
│       │   ├── ebb-review-task/
│       │   │   └── SKILL.md
│       │   └── ebb-final-review/
│       │       └── SKILL.md
│       └── fixtures/
│           └── parity-plan.md
└── docs/
    └── development/
        └── hermes.md
```

Workflow пользователя должен стать таким:

```text
создать/открыть нужный worktree
→ pnpm hermes:setup
→ pnpm hermes:check
→ pnpm hermes:execute -- docs/architecture/plans/<plan>.md
→ Hermes исполняет план
→ максимум 2 субагента
→ implementation
→ task review
→ tests
→ final review
→ commit только в текущей feature-ветке
```

Миграция не считается завершённой, пока реальный plan не будет успешно выполнен через Hermes без участия OpenCode.

---

# Задача 1 — Зафиксировать baseline и провести инвентаризацию OpenCode

**Файлы:**
- Читать: `.opencode/**`, если каталог существует.
- Читать: `package.json`.
- Читать: `README.md`.
- Читать: `.gitignore`.
- Читать: `AGENTS.md`, если существует.
- Читать: `.hermes.md` / `HERMES.md`, если уже существуют.
- Читать: `docs/architecture/plans/**`.
- Создать: `docs/audit/opencode-to-hermes-inventory.md`.

**Назначение:** точно определить, какие функции текущего development-workflow предоставляет OpenCode, чтобы при миграции не потерять ни одного важного правила.

- [ ] **Шаг 1. Зафиксировать Git baseline**

Выполнить:

```bash
git branch --show-current
git status --short
git log -1 --oneline
git worktree list
```

В inventory записать:

- текущую ветку;
- текущий HEAD;
- существующие до начала работы незакоммиченные изменения;
- текущие worktree.

- [ ] **Шаг 2. Найти все активные ссылки на OpenCode**

Выполнить поиск по репозиторию:

```text
.opencode
opencode
/execute-plan
sdd-orchestrator
implementer
reviewer
final-reviewer
```

Каждое найденное упоминание классифицировать:

```text
ACTIVE_CONFIG
ACTIVE_DOCUMENTATION
HISTORICAL_DOCUMENTATION
TEST_FIXTURE
UNRELATED
```

Исторические audit/plans нельзя удалять только потому, что в них упомянут OpenCode.

- [ ] **Шаг 3. Прочитать активные OpenCode agents/commands**

Для каждого активного файла `.opencode` зафиксировать:

```text
файл
назначение
входные данные
разрешённые действия
Git rules
правила субагентов
review rules
test gates
commit rules
специальный project context
```

- [ ] **Шаг 4. Создать inventory-документ**

Создать `docs/audit/opencode-to-hermes-inventory.md` со структурой:

```markdown
# Инвентаризация миграции OpenCode → Hermes

## Baseline
## Активные файлы OpenCode
## Поведение, которое необходимо сохранить
## Поведение, от которого можно отказаться
## Инструкции репозитория, которые переходят в .hermes.md
## Поведение, которое переходит в Hermes skills
## Ссылки из package/scripts
## Ссылки из документации
## Условия, при которых можно удалить OpenCode
```

- [ ] **Шаг 5. Проверить, что других изменений нет**

Выполнить:

```bash
git diff --check
git status --short
```

На этом этапе commit не выполнять.

---

# Задача 2 — Создать authoritative project-context для Hermes

**Файлы:**
- Создать или актуализировать: `.hermes.md`.
- Читать: `docs/architecture/specs/2026-09-16-ebb-orchestrator-design.md`.
- Читать: действующее руководство проекта по JSDoc.

**Результат:** Hermes получает единый versioned контекст разработки прямо из корня репозитория.

- [ ] **Шаг 1. Создать `.hermes.md`**

Использовать следующий смысл и структуру. Пути можно корректировать только если текущий репозиторий доказывает, что они отличаются.

```markdown
# Ebb Orchestrator — инструкции разработки через Hermes

## Область действия

Эти инструкции управляют разработкой САМОГО Ebb Orchestrator через Hermes.

Они не заменяют внутреннюю production-архитектуру `AgentRuntime` / `HermesRuntimeAdapter`.

## Git

- Основная ветка проекта — `master`.
- Работать только в worktree/ветке, переданной пользователем.
- Никогда не выполнять merge в `master` без явного подтверждения пользователя.
- Никогда не выполнять push, force-push, tag, release, `reset --hard` или `git clean`, если пользователь явно этого не запросил.
- Сохранять посторонние pre-existing изменения.
- До редактирования выполнять:
  - `git branch --show-current`;
  - `git status --short`;
  - `git log -1 --oneline`.

## Планы

- Канонические implementation plans находятся в `docs/architecture/plans/`.
- Перед изменением кода читать plan полностью.
- Выполнять задачи с учётом зависимостей.
- Не менять требования плана молча.
- Если текущий код опровергает предположение плана, сначала зафиксировать доказательство, затем выбрать минимальную корректировку, сохраняющую утверждённую архитектуру.

## Субагенты

- ЖЁСТКИЙ ЛИМИТ: одновременно может работать не более 2 субагентов.
- Если активны два — остальные ждут.
- Nested subagents запрещены.
- Нельзя обходить лимит через дочерних orchestrator-агентов.
- Если задачи затрагивают одни файлы или один subsystem, выполнять их последовательно.
- Review-субагенты работают read-only, если им отдельно не назначена implementation-задача.

## Дисциплина разработки

Использовать цикл:

inspect → prove → test → fix → focused verify → full verify → review

Для дефектов:
1. воспроизвести или доказать;
2. добавить regression test, если это практически возможно;
3. внести минимальное root-cause исправление;
4. запустить focused tests;
5. запустить соседние проверки;
6. запустить repository gates.

Запрещено ослаблять проверки ради зелёного результата.

## Архитектурные инварианты

Сохранять утверждённую архитектуру Ebb Orchestrator:
- deterministic-first;
- modular monolith + Ports & Adapters;
- Git — source of truth для кода;
- SQLite — source of truth для orchestration state;
- Workflow Engine владеет state transitions;
- Scheduler — authority для dispatch/capacity/reservations;
- durable runtime path проходит через RunService до AgentRuntime;
- permissions/executable actions проходят через утверждённую ActionGateway/PermissionEngine boundary;
- final merge — реальная проверяемая Git operation после required approval;
- после restart сначала reconciliation, затем новая AI-работа;
- migration history append-only/forward-only.

Не добавлять post-v1 scope без отдельного утверждённого плана.

## Комментарии и JSDoc

- Все новые или изменяемые комментарии production-кода пишутся на грамотном русском языке.
- Технические идентификаторы не переводятся.
- Экспортируемые, публичные и контрактные production API получают полезный русский JSDoc.
- В JSDoc описывать назначение, invariants, trust boundaries, side effects, preconditions, transaction/idempotency semantics и значимые ошибки, когда это применимо.
- Не добавлять фиктивные `@returns`, `@throws` или `@example`.
- Не ослаблять JSDoc ESLint rules.

## Проверки

Реальные команды определять по `package.json`; ничего не придумывать.

Минимальные финальные gates, когда они определены:

pnpm lint
pnpm typecheck
pnpm test
git diff --check

Дополнительно запускать затронутые canonical build/integration/e2e/security/migration/smoke gates.

## Завершение

Перед отчётом о завершении:
- проверить полный diff;
- убедиться, что нет secrets и посторонних изменений;
- убедиться, что заявленные проверки реально запускались;
- для значимых изменений выполнить independent final review;
- явно перечислить ограничения.

Зелёный test suite сам по себе не является доказательством архитектурной корректности.
```

- [ ] **Шаг 2. Не создавать дублирующий контекст**

Если `.hermes.md` выбран как канонический repository context, не создавать второй независимый `HERMES.md` с теми же правилами.

- [ ] **Шаг 3. Проверить согласованность**

Сверить `.hermes.md` с:

- design specification;
- текущим `AGENTS.md`;
- JSDoc guide;
- Git policy;
- текущими audit findings.

---

# Задача 3 — Добавить repository-owned Hermes skills

**Файлы:**
- Создать: `tools/hermes/skills/ebb-execute-plan/SKILL.md`.
- Создать: `tools/hermes/skills/ebb-implement-task/SKILL.md`.
- Создать: `tools/hermes/skills/ebb-review-task/SKILL.md`.
- Создать: `tools/hermes/skills/ebb-final-review/SKILL.md`.

**Контракты:**
- `ebb-execute-plan` — оркестрация полного implementation plan.
- `ebb-implement-task` — выполнение одной изолированной задачи/finding cluster.
- `ebb-review-task` — независимый read-only review завершённой задачи.
- `ebb-final-review` — независимый read-only review полного diff перед завершением.

## Шаг 1 — `ebb-execute-plan/SKILL.md`

Создать skill со следующим поведением:

```markdown
---
name: ebb-execute-plan
description: Безопасно исполняет implementation plan проекта Ebb Orchestrator.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, development, implementation-plan]
---

# Выполнение плана Ebb Orchestrator

Используй этот skill только при разработке Ebb Orchestrator.

## Вход

Repository-relative путь к implementation plan, обычно внутри:

`docs/architecture/plans/`

## Жёсткие правила

- Сначала прочитать `.hermes.md`.
- Прочитать plan полностью до редактирования.
- Работать только в текущем worktree/branch.
- Никогда не запускать более 2 субагентов одновременно.
- Не создавать nested subagents.
- Не включать автоматическое child-worktree isolation.
- Сохранять посторонние изменения.
- Не выполнять merge/push/tag/release без явного указания пользователя.
- Все новые/изменяемые production-комментарии — русский JSDoc там, где он требуется.

## Процедура

1. Зафиксировать branch, HEAD и working-tree status.
2. Прочитать весь plan.
3. Прочитать specs/files, на которые он ссылается.
4. Сформировать task ledger:
   - WAITING;
   - READY;
   - RUNNING;
   - REVIEW;
   - DONE;
   - BLOCKED.
5. Определить зависимости и пересекающееся владение файлами.
6. Запускать максимум две независимые задачи одновременно.
7. Для каждой implementation-задачи:
   - использовать процедуру `ebb-implement-task`;
   - получить результат;
   - проверить diff;
   - выполнить focused verification;
   - до принятия результата провести `ebb-review-task`.
8. Не разрешать двум агентам одновременно менять пересекающиеся файлы.
9. После всех задач:
   - выполнить gates плана;
   - выполнить repository gates;
   - проверить полный diff.
10. Выполнить `ebb-final-review`.
11. Если final review находит подтверждённый blocker:
   - воспроизвести;
   - исправить root cause;
   - повторить focused tests;
   - повторить полный verification;
   - запустить нового final reviewer.
12. Делать commit только если plan этого требует и все применимые gates прошли.
13. Вернуть отчёт:
   - branch;
   - HEAD/commit;
   - выполненные задачи;
   - tests/builds;
   - reviewer verdict;
   - ограничения;
   - состояние рабочего дерева.

## Запрещённые сокращения

Нельзя:
- skip'ать падающие тесты;
- ослаблять assertions;
- отключать lint/type/JSDoc/security rules;
- скрывать ошибки;
- придумывать PASS;
- переписывать historical migrations;
- расширять scope за пределы plan.
```

## Шаг 2 — `ebb-implement-task/SKILL.md`

Создать skill со следующим смыслом:

```markdown
---
name: ebb-implement-task
description: Выполняет одну изолированную задачу implementation plan Ebb Orchestrator.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, implementation, tdd]
---

# Реализация одной задачи Ebb Orchestrator

Выполняй только одну назначенную задачу plan или один подтверждённый finding cluster.

## До редактирования

1. Прочитать `.hermes.md`.
2. Прочитать назначенную задачу.
3. Прочитать связанные spec/code/tests.
4. Подтвердить набор разрешённых файлов.
5. Выполнить focused baseline tests, если они существуют.

## Цикл реализации

Для каждого изменения поведения:

1. доказать или воспроизвести проблему;
2. написать/обновить regression test;
3. по возможности подтвердить ожидаемый failure;
4. внести минимальное корректное исправление;
5. обновить русский JSDoc, если изменился публичный contract/invariant;
6. выполнить focused test;
7. выполнить соседние tests;
8. выполнить `git diff --check`;
9. проверить собственный diff.

## Ограничения

- Не менять посторонние файлы.
- Не менять файлы другой задачи без эскалации Coordinator.
- Не выполнять merge/push/tag/release.
- Не запускать собственных субагентов.
- Не объявлять completion без доказательств тестами.

Вернуть:
- изменённые файлы;
- запущенные тесты;
- результат;
- оставшиеся риски.
```

## Шаг 3 — `ebb-review-task/SKILL.md`

Создать read-only reviewer:

```markdown
---
name: ebb-review-task
description: Независимо проверяет diff одной задачи Ebb Orchestrator.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, review]
---

# Review одной задачи

Работай read-only.

Не редактируй файлы, если Coordinator отдельно не переназначил тебя как implementer.

Проверяй:
- соответствие plan/spec;
- архитектурные invariants;
- correctness;
- error handling;
- persistence/restart semantics;
- security boundaries;
- tests и negative cases;
- русскую JSDoc/comment policy;
- scope creep;
- случайные изменения migration history.

Классификация:
- BLOCKER;
- IMPORTANT;
- MINOR;
- FALSE_POSITIVE.

Каждый существенный finding должен содержать:
- file/symbol;
- evidence;
- expected behavior;
- actual behavior;
- concrete impact.

`PASS` допускается только при отсутствии blocker/important correctness findings.
```

## Шаг 4 — `ebb-final-review/SKILL.md`

Создать независимый final reviewer:

```markdown
---
name: ebb-final-review
description: Выполняет независимый финальный review изменений Ebb Orchestrator.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, final-review]
---

# Финальный review

Ты независимый read-only reviewer.

Прочитай:
- `.hermes.md`;
- implementation plan;
- соответствующий approved spec;
- полный current diff;
- результаты tests/builds.

Твоя задача — попытаться опровергнуть готовность изменений.

Особенно проверяй:
- architecture authority boundaries;
- state transitions;
- Scheduler/RunService/runtime path;
- permissions;
- persistence/migrations/recovery;
- Git/worktree safety;
- integration/merge verification;
- security;
- startup/shutdown;
- tests;
- Russian JSDoc policy;
- consistency документации.

Не создавай cosmetic review churn.

Verdict:
- `PASS`;
- `CHANGES_REQUESTED`.

При `CHANGES_REQUESTED` перечисляй только доказанные load-bearing findings.
```

- [ ] **Шаг 5. Проверить skills**

Проверить:

- YAML frontmatter корректен;
- `name` уникальны;
- отсутствуют placeholders;
- нигде не разрешено более двух параллельных субагентов;
- implementer/reviewer не могут создавать children;
- комментарии/instructions согласованы с `.hermes.md`.

Выполнить:

```bash
git diff --check
```

---

# Задача 4 — Создать воспроизводимый setup/check/execute runner для Hermes

**Файлы:**
- Создать: `scripts/hermes-dev.mjs`.
- Изменить: `package.json`.

**Результат:**

```text
pnpm hermes:setup
pnpm hermes:check
pnpm hermes:execute -- <plan>
```

## Шаг 1 — Реализовать `scripts/hermes-dev.mjs`

Скрипт должен поддерживать три команды:

```text
setup
check
execute
```

Использовать только Node built-ins:

```text
node:child_process
node:crypto
node:fs
node:os
node:path
```

Не добавлять новую npm dependency.

### Команда `setup`

Должна:

1. определить текущий Git worktree root;
2. определить `HERMES_HOME`:
   - сначала `process.env.HERMES_HOME`;
   - иначе `~/.hermes`;
3. взять repository-owned skills из:
   - `tools/hermes/skills/`;
4. синхронизировать их в отдельный namespace активного Hermes home;
5. не трогать пользовательские skills, не относящиеся к Ebb Orchestrator;
6. настроить delegation:

```text
delegation.max_concurrent_children = 2
delegation.max_spawn_depth = 1
delegation.orchestrator_enabled = false
delegation.worktree_isolation = false
```

7. не изменять:
   - provider;
   - model;
   - API keys;
   - unrelated Hermes settings.

При настройке использовать Hermes CLI:

```bash
hermes config set delegation.max_concurrent_children 2
hermes config set delegation.max_spawn_depth 1
hermes config set delegation.orchestrator_enabled false
hermes config set delegation.worktree_isolation false
```

### Команда `check`

Должна проверить:

```text
hermes --version
.hermes.md exists
source skills exist
installed skill copies exist
source/installed hashes match
delegation.max_concurrent_children == 2
delegation.max_spawn_depth == 1
delegation.orchestrator_enabled == false
delegation.worktree_isolation == false
```

Для config использовать:

```bash
hermes config get delegation.max_concurrent_children
hermes config get delegation.max_spawn_depth
hermes config get delegation.orchestrator_enabled
hermes config get delegation.worktree_isolation
```

При ошибке вернуть non-zero exit code.

### Команда `execute <plan>`

Должна:

1. требовать путь к plan;
2. определить current Git worktree root;
3. разрешать только файл внутри этого worktree;
4. отклонять path traversal;
5. отклонять отсутствующий файл;
6. создавать временный prompt file;
7. prompt должен явно потребовать:
   - прочитать `.hermes.md`;
   - использовать `ebb-execute-plan`;
   - именно выполнить plan, а не пересказать его;
8. запускать Hermes примерно так:

```bash
hermes --in <current-worktree-root> chat --query-file <temp-file>
```

9. передавать stdin/stdout/stderr пользователю;
10. удалять временный prompt в `finally`;
11. возвращать exit code Hermes.

## Шаг 2 — Добавить package scripts

В существующий root `package.json` добавить, не удаляя другие scripts:

```json
{
  "scripts": {
    "hermes:setup": "node scripts/hermes-dev.mjs setup",
    "hermes:check": "node scripts/hermes-dev.mjs check",
    "hermes:execute": "node scripts/hermes-dev.mjs execute"
  }
}
```

## Шаг 3 — Проверить валидацию путей

Выполнить:

```bash
pnpm hermes:execute
```

Ожидание: non-zero + сообщение об использовании.

Выполнить:

```bash
pnpm hermes:execute -- does-not-exist.md
```

Ожидание: non-zero.

Выполнить:

```bash
pnpm hermes:execute -- ../outside.md
```

Ожидание: non-zero.

На этом этапе реальный implementation plan ещё не запускать.

---

# Задача 5 — Документировать новый процесс разработки

**Файлы:**
- Создать: `tools/hermes/README.md`.
- Создать: `docs/development/hermes.md`.
- При необходимости дополнить `README.md` короткой ссылкой на development guide.

## Шаг 1 — `tools/hermes/README.md`

Документ должен объяснять:

- `tools/hermes/skills/` — канонический repository source;
- копии в `HERMES_HOME` считаются генерируемыми;
- installed copy нельзя редактировать вручную;
- после изменения skill выполнять:

```bash
pnpm hermes:setup
pnpm hermes:check
```

Перечислить четыре skill и их роли.

## Шаг 2 — `docs/development/hermes.md`

Обязательные разделы:

```markdown
# Разработка Ebb Orchestrator через Hermes

## Что именно заменяет Hermes
OpenCode как внешний development executor.

## Что не меняется
Production `AgentRuntime` / `HermesRuntimeAdapter`.

## Первоначальная настройка
pnpm hermes:setup
pnpm hermes:check

## Запуск implementation plan
pnpm hermes:execute -- docs/architecture/plans/<file>.md

## Интерактивная сессия
hermes --in "<worktree>" --tui
или
hermes --in "<worktree>" chat

## Субагенты
Максимум 2 одновременно.
Depth = 1.
Nested delegation запрещён.

## Worktrees
Worktree выбирает пользователь/Coordinator.
Child worktree isolation отключён.

## Обновление skills
Редактировать tools/hermes/skills/
Затем hermes:setup + hermes:check.

## Русский JSDoc

## Git safety

## Диагностика
hermes --version
hermes config get ...
pnpm hermes:check
```

Current docs больше не должны рекомендовать OpenCode как основной способ исполнения планов после успешной миграции.

---

# Задача 6 — Выполнить setup и проверить Hermes

На этом этапе repository edits не ожидаются.

- [ ] **Шаг 1. Выполнить setup**

```bash
pnpm hermes:setup
```

Проверить:

- skills синхронизированы;
- delegation settings установлены;
- provider/model/API credentials не изменились.

- [ ] **Шаг 2. Выполнить check**

```bash
pnpm hermes:check
```

Ожидание: PASS.

- [ ] **Шаг 3. Проверить вручную**

```bash
hermes --version
hermes config get delegation.max_concurrent_children
hermes config get delegation.max_spawn_depth
hermes config get delegation.orchestrator_enabled
hermes config get delegation.worktree_isolation
hermes skills list
```

Ожидаемые значения:

```text
2
1
false
false
```

Убедиться, что Ebb skills доступны Hermes.

---

# Задача 7 — Создать parity-plan для реальной проверки нового workflow

**Файл:**
- Создать: `tools/hermes/fixtures/parity-plan.md`.

Содержание:

```markdown
# План parity-проверки Hermes development workflow

## Цель

Доказать, что Hermes способен исполнить Ebb repository plan от начала до конца без OpenCode.

## Жёсткие правила

- Прочитать `.hermes.md`.
- Использовать не более 2 субагентов одновременно.
- Nested delegation запрещён.
- Production-код не изменять.
- Не выполнять merge/push/tag/release.

## Задача 1 — Независимые context checks

Запустить ровно два read-only субагента одновременно.

Subagent A проверяет:
- `.hermes.md` доступен и непротиворечив;
- `master` указан основной веткой;
- есть правило русского JSDoc;
- есть лимит максимум 2 субагента.

Subagent B проверяет:
- `tools/hermes/skills/` содержит ожидаемые skills;
- active Hermes config содержит:
  - concurrency=2;
  - depth=1;
  - orchestrator disabled;
  - child worktree isolation disabled.

Оба возвращают только evidence.

## Задача 2 — Repository verification

Выполнить:
- `pnpm lint`;
- `pnpm typecheck`;
- `pnpm test`;
- `git diff --check`.

Не изменять код только ради устранения baseline failure.
Если есть pre-existing failure — точно описать его.

## Задача 3 — Создать parity report

Создать/обновить:

`docs/audit/hermes-development-workflow-parity.md`

Включить:
- дату;
- branch;
- HEAD;
- context verification;
- подтверждение concurrency;
- delegation config;
- commands/results;
- verdict `PASS` или `FAIL`.

## Задача 4 — Commit

Только если verdict = PASS:

`git add docs/audit/hermes-development-workflow-parity.md`

Проверить staged diff.

Commit:

`docs: verify Hermes development workflow parity`

Не включать посторонние файлы.
```

---

# Задача 8 — Зафиксировать инфраструктуру миграции до parity-run

**Важно:** `.opencode` пока не удалять.

- [ ] **Шаг 1. Выполнить gates**

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

- [ ] **Шаг 2. Проверить diff**

```bash
git status --short
git diff --stat
git diff
```

Убедиться:

- нет credentials;
- нет secrets;
- production runtime не менялся без причины;
- `.opencode` ещё не удалён.

- [ ] **Шаг 3. Commit**

Закоммитить только migration infrastructure:

```bash
git commit -m "build: add Hermes development workflow"
```

---

# Задача 9 — Выполнить parity-plan через Hermes

Это главный acceptance test миграции.

- [ ] **Шаг 1. Запустить новый runner**

```bash
pnpm hermes:execute -- tools/hermes/fixtures/parity-plan.md
```

- [ ] **Шаг 2. Проверить результат**

После возврата Hermes:

```bash
git status --short
git log -3 --oneline
```

Прочитать:

```text
docs/audit/hermes-development-workflow-parity.md
```

Acceptance criteria:

- verdict = PASS;
- использовано ровно два параллельных read-only субагента;
- нет признаков >2 одновременных children;
- nested delegation отсутствует;
- repository gates прошли;
- parity report создан и закоммичен отдельно;
- production-код не изменён.

Если verdict = FAIL:

- `.opencode` не удалять;
- исправить migration tooling;
- повторить `hermes:setup`;
- повторить `hermes:check`;
- снова выполнить parity-plan.

---

# Задача 10 — Удалить активный OpenCode workflow только после parity PASS

**Файлы:**
- Удалить: только активную `.opencode/**` конфигурацию, выявленную в Task 1.
- Изменить: текущие development docs/scripts/package references, которые требуют OpenCode.
- Сохранить: исторические audit/plan документы.

- [ ] **Шаг 1. Повторно прочитать inventory**

Использовать:

```text
docs/audit/opencode-to-hermes-inventory.md
```

Удалять только элементы категории:

```text
ACTIVE_CONFIG
```

- [ ] **Шаг 2. Удалить OpenCode-only dependencies/scripts**

Если `package.json` или другие active tooling files содержат зависимости, нужные исключительно старому executor:

1. доказать отсутствие других consumers;
2. удалить dependency/script;
3. обновить lockfile нормальной pnpm-командой.

Не удалять сущность с названием OpenCode, если она используется реальной функцией продукта.

- [ ] **Шаг 3. Обновить текущую документацию**

Current workflow должен показывать:

```bash
pnpm hermes:setup
pnpm hermes:check
pnpm hermes:execute -- docs/architecture/plans/<plan>.md
```

Исторические документы сохраняют историческую правду.

- [ ] **Шаг 4. Повторить поиск stale instructions**

Искать:

```text
.opencode
opencode
/execute-plan
```

В актуальной документации/конфигурации не должно остаться OpenCode как обязательного development executor.

---

# Задача 11 — Финальная проверка и независимый review

- [ ] **Шаг 1. Повторно синхронизировать skills**

```bash
pnpm hermes:setup
pnpm hermes:check
```

- [ ] **Шаг 2. Полные gates**

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Также выполнить реальные canonical build gates из `package.json`.

- [ ] **Шаг 3. Независимый read-only final review**

Использовать `ebb-final-review`.

Reviewer должен отдельно проверить:

- OpenCode больше не требуется текущему development workflow;
- `.hermes.md` достаточно для project context;
- setup не удаляет посторонние Hermes skills;
- setup не меняет provider/model credentials;
- execute защищён от path traversal;
- concurrency = 2;
- nested delegation запрещён;
- child worktree isolation disabled;
- русский JSDoc policy сохранён;
- production `HermesRuntimeAdapter` не стал зависеть от development tooling;
- документация описывает фактический workflow.

- [ ] **Шаг 4. Исправить только подтверждённые blockers**

Если verdict = `CHANGES_REQUESTED`:

1. подтвердить finding;
2. исправить root cause;
3. повторить tests;
4. повторить `hermes:check`;
5. запустить нового final reviewer.

---

# Задача 12 — Финальный commit миграции

- [ ] **Шаг 1. Проверить diff**

```bash
git status --short
git diff --stat
git diff
```

- [ ] **Шаг 2. Stage только cleanup миграции**

Не включать pre-existing unrelated changes.

- [ ] **Шаг 3. Commit**

```bash
git commit -m "chore: retire OpenCode development workflow"
```

- [ ] **Шаг 4. Финальная проверка**

```bash
git status --short
git log -3 --oneline
pnpm hermes:check
```

Ожидание:

- OpenCode больше не является active development dependency;
- parity report = PASS;
- Hermes setup/check = PASS;
- branch остаётся feature-веткой;
- merge/push/tag/release не выполнялись.

---

# Workflow пользователя после миграции

Из любого отдельного Ebb Orchestrator worktree:

```powershell
pnpm hermes:setup
pnpm hermes:check
pnpm hermes:execute -- docs/architecture/plans/2026-09-XX-example.md
```

Для интерактивной Hermes-сессии:

```powershell
hermes --in "C:\path\to\worktree" --tui
```

Project rules загружаются из `.hermes.md`.

Повторно используемые development procedures берутся из Ebb Hermes skills.

---

# Критерии полного завершения

План считается завершённым только если одновременно выполнены все условия:

- `.hermes.md` существует и является project context;
- repository-owned skills находятся под version control;
- skills воспроизводимо синхронизируются в active `HERMES_HOME`;
- provider/model/secrets не изменялись;
- concurrency строго равен 2;
- nested delegation отключён;
- child worktree isolation отключён;
- `pnpm hermes:check` проходит;
- реальный plan выполнен через `pnpm hermes:execute`;
- parity report = PASS;
- OpenCode удалён из active workflow только после parity PASS;
- полные project gates проходят;
- independent final review = PASS;
- current documentation описывает Hermes как development executor;
- production-runtime архитектура не была необоснованно изменена.
