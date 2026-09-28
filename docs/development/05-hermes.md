---
id: guideline-03
status: in_progress
kind: development
title: Разработка Ebb Orchestrator через Hermes
created: 2026-09-23
updated: 2026-09-23
---

# Разработка Ebb Orchestrator через Hermes

Этот документ описывает Hermes как внешний исполнитель разработки: координацию
планов, делегирование задач, независимый review и финальную проверку. Контракт
production `AgentRuntime` / `HermesRuntimeAdapter` задаётся архитектурной specification.

## Prerequisites

- Выполняйте repository-команды из корня выбранного Git worktree.
- Нужны Node.js и pnpm из требований корневого README, Git и доступный в `PATH`
  Hermes Agent с командами config и project trust.
- В worktree должны присутствовать `.hermes.md` и canonical source `.agents/skills/`.
- Полный актуальный набор из 19 Ebb skills находится в
  [единственном README inventory](../../README.md#hermes-development-skills).

## Первоначальная настройка

```bash
pnpm hermes:setup
pnpm hermes:check
```

Владельцы команд в корневом `package.json`: `hermes:setup` запускает
`node scripts/hermes-dev.mjs setup`, `hermes:check` — `node scripts/hermes-dev.mjs check`.

`hermes:setup` сначала запускает документационные inventory/check, определяет
Git root, проверяет поддержку `hermes skills trust`, добавляет выбранный repository
в trusted projects и включает `skills.project_discovery`. Затем выставляет
`delegation.max_concurrent_children=2`, `delegation.max_spawn_depth=1` и
`delegation.orchestrator_enabled=false`. Команда изменяет настройки выбранного
Hermes home и завершает успешную настройку маркером
`HERMES_CONFIG marker=SETUP_CONFIGURED trusted=true redacted=true`.

`hermes:check` проверяет `hermes --version`, `.hermes.md`, точный canonical
inventory с `SKILL.md` у всех 19 owners, trusted repository через
`skills.trusted_project_dirs`, `skills.project_discovery=true` и три значения
delegation выше. Успех — exit `0` и `All checks passed.`; ошибка — exit `1` и
`HERMES_CONFIG marker=CHECK_FAILED exit_code=1 redacted=true`.

Skills обнаруживаются непосредственно в `.agents/skills/`. Setup/check не копируют
profile assets, не синхронизируют capability registry и не перезаписывают
profile-local skills. Проверка подтверждает конфигурацию и inventory, но фактический
runtime skill index/provenance требует отдельной runtime acceptance проверки.

## Запуск implementation plan

```bash
pnpm hermes:execute -- docs/architecture/plans/<file>.md
```

## Интерактивный запуск

```bash
hermes --in "<worktree>" --tui
```

## Ограничение субагентов

Максимум 2 параллельных субагента, глубина делегирования 1, без вложенного делегирования.

## Worktrees

Человек/координатор выбирает worktree. Hermes не создаёт изолированные child worktrees автоматически.

## Обновление skills

```bash
# Edit .agents/skills
pnpm hermes:setup
pnpm hermes:check
```

`pnpm hermes:setup` настраивает Hermes project trust и prerequisites; skills
не устанавливаются и не копируются в Hermes profile.

Проверки source и repository instructions выполняются без реального Hermes profile:

```bash
pnpm skills:test
pnpm skills:dependencies:test
pnpm hermes:test
```

`skills:dependencies:test` проверяет весь Git-tracked source и новые canonical
skills до их commit; обязательные внешние workflow skills должны получить
подтверждённого Ebb owner, иначе проверка сообщает exact file/line.

## Русский JSDoc

Все публичные API и production-комментарии пишутся на русском. JSDoc должен описывать назначение, инварианты, границы доверия, побочные эффекты и семантику ошибок.

## Git safety

- Работа только в non-master worktree/branch
- Никакого push/merge/rebase/reset/clean из агентов
- Интеграция только после явного человеческого подтверждения

## Troubleshooting

**Hermes не найден:** установите Hermes Agent и убедитесь, что он в PATH.

**Проверка не проходит:** прочитайте failed check, проверьте выбранный Hermes home
и выполните `pnpm hermes:setup`. Для trust failure используйте также указанную
скриптом команду `hermes skills trust <repo-root>`.

**План не запускается:** убедитесь, что путь к плану корректен и он существует в репозитории.
