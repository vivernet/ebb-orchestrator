# Разработка Ebb Orchestrator через Hermes

## Что именно заменяет Hermes

OpenCode как внешний исполнитель разработки. Hermes выполняет те же функции: координация планов, делегирование задач, независимый ревью и финальная проверка.

## Что НЕ меняется

Архитектура AgentRuntime/HermesRuntimeAdapter в продакшен-коде остаётся без изменений. Этот документ описывает только workflow разработки.

## Первоначальная настройка

```bash
pnpm hermes:setup
pnpm hermes:check
```

## Запуск implementation plan

```bash
pnpm hermes:execute -- docs/superpowers/plans/<file>.md
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
# Edit tools/hermes/skills
pnpm hermes:setup
pnpm hermes:check
```

## Русский JSDoc

Все публичные API и production-комментарии пишутся на русском. JSDoc должен описывать назначение, инварианты, границы доверия, побочные эффекты и семантику ошибок.

## Git safety

- Работа только в non-master worktree/branch
- Никакого push/merge/rebase/reset/clean из агентов
- Интеграция только после явного человеческго подтверждения

## Troubleshooting

**Hermes не найден:** установите Hermes Agent и убедитесь, что он в PATH.

**Проверка не проходит:** запустите `pnpm hermes:setup` заново и проверьте HERMES_HOME.

**План не запускается:** убедитесь, что путь к плану корректен и он существует в репозитории.
