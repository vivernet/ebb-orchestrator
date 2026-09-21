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

## Skills, capabilities и provider

Канонический список и exact source/installed paths находится в
[`hermes-capabilities.md`](hermes-capabilities.md). Для explicit Inception Labs
development profile:

```bash
pnpm hermes:provider -- inception
```

Команда настраивает `custom:inception`, endpoint
`https://api.inceptionlabs.ai/v1`, alias `mercury-2` и `key_env:
INCEPTION_API_KEY`; значение ключа остаётся во внешнем окружении.

## Bounded provider smoke

Для ограниченной проверки provider transport используется:

```bash
pnpm hermes:smoke
```

Источник команды —
[`scripts/hermes-provider-smoke.mjs`](../../scripts/hermes-provider-smoke.mjs).
Smoke не запускает repository plan. Он создаёт disposable `HERMES_HOME`, пустой
workspace и synthetic prompt `Reply with exactly: SMOKE_OK` во временном каталоге.
В Hermes передаётся только явный environment allowlist: platform process keys,
temporary/home paths, `HERMES_MODEL` и `INCEPTION_API_KEY`; произвольные keys и
repository secrets не передаются. Запуск выполняется с `shell:false` и bounded
timeout.

Child stdout/stderr не публикуются. Результат ограничен fixed marker, exit code,
`redacted=true` и `cleanup_verified`; temporary workspace, profile и prompt
удаляются после завершения. Для smoke не подключаются реальный worktree, plan,
MCP toolset или repository-derived context.

Smoke подтверждает только provider reachability/auth и безопасную обработку
ответа. Он не заменяет provider-backed parity run: не проверяет выполнение
реального plan, delegation subagents, repository context transport или условие
удаления `.opencode`.

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
