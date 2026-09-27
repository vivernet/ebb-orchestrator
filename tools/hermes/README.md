# Инструменты разработки Hermes

Каталог содержит исходные файлы локальных skills проекта и настройки Hermes для
Ebb Orchestrator. Установленные копии синхронизируются в `HERMES_HOME`; их не
следует редактировать вручную.

## Структура

- `skills/` — исходные `SKILL.md` для 11 навыков Ebb:
  `ebb-debug-issue`, `ebb-execute-plan`, `ebb-final-review`,
  `ebb-implement-task`, `ebb-quality-gates`, `ebb-repository-context`,
  `ebb-review-plan`, `ebb-review-task`, `ebb-security-review`, `ebb-web-e2e` и
  `ebb-write-plan`.
- `providers/` — локальные настройки провайдеров проекта.
- `capabilities.yaml` — реестр разрешённых capability.
- `fixtures/` — если присутствуют, тестовые фикстуры и материалы проверок.

## Синхронизация и проверка

После изменения исходных skills или capability выполните из корня репозитория:
```bash
pnpm hermes:setup
pnpm hermes:check
```

`pnpm hermes:setup` изменяет конфигурацию Hermes и файлы в `HERMES_HOME`.
`pnpm hermes:check` проверяет наличие `hermes`, исходных skills, capability,
provider-файлов, совпадение хэшей и четыре значения delegation-конфигурации.

Автоматические тесты скриптов запускаются так:

```bash
pnpm hermes:test
```

## Выполнение плана

Команда требует существующий путь к плану внутри текущего worktree и запускает
Hermes для выполнения плана. Она изменяет внешнее состояние; не запускайте её без
явного одобрения и подходящего изолированного worktree.
