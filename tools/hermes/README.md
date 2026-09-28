# Инструменты разработки Hermes

Каталог содержит настройки Hermes для Ebb Orchestrator. Единственный
Git-tracked source of truth Ebb skills — `.agents/skills/` в корне репозитория.
Codex и Hermes обнаруживают эти project-local skills непосредственно; установка
или копирование Ebb skills в `HERMES_HOME` не выполняется.

## Структура

- `.agents/skills/` — канонический набор из 13 навыков Ebb: `ebb-curate-skills`,
  `ebb-debug-issue`, `ebb-execute-plan`, `ebb-final-review`,
  `ebb-implement-task`, `ebb-quality-gates`, `ebb-repository-context`,
  `ebb-repository-maintenance`, `ebb-review-plan`, `ebb-review-task`,
  `ebb-security-review`, `ebb-web-e2e` и `ebb-write-plan`.
- `capabilities.yaml` — реестр разрешённых capability.
- `fixtures/` — если присутствуют, тестовые фикстуры и материалы проверок.

## Настройка и проверка

Выполняйте из корня репозитория:

```bash
pnpm hermes:setup
pnpm hermes:check
```

`pnpm hermes:setup` feature-detects `hermes skills trust`, доверяет текущий
репозиторий для project-skill discovery, включает `skills.project_discovery`,
настраивает `delegation.max_concurrent_children`, `delegation.max_spawn_depth`
и `delegation.orchestrator_enabled`, синхронизирует только capabilities.
Команда не копирует и не перезаписывает skills в `HERMES_HOME` и не меняет
`skills.create_dir`.

`pnpm hermes:check` проверяет точный inventory и наличие `SKILL.md` у всех 13
канонических skills, trust текущего проекта, включённый `skills.project_discovery`,
наличие Hermes, совпадение capabilities и значения delegation-конфигурации.
Эта команда проверяет настройки и inventory файлов, но не подтверждает фактический
runtime skill index или provenance каждого обнаруженного навыка; для этого требуется
отдельная runtime acceptance проверка.
Profile-local копии Ebb не являются критерием проверки: они могут оставаться
устаревшими и не удаляются.
Если проект не trusted, проверка предлагает выполнить `pnpm hermes:setup` либо
`hermes skills trust <repo-root>`.

Автоматические тесты скриптов запускаются так:

```bash
pnpm hermes:test
```

## Выполнение плана

Команда требует существующий путь к плану внутри текущего worktree и запускает
Hermes для выполнения плана. Она изменяет внешнее состояние; не запускайте её без
явного одобрения и подходящего изолированного worktree.
