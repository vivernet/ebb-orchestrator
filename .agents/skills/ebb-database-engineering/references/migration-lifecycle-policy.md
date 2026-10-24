# Migration lifecycle policy

## Unpublished development history

До первой поддерживаемой production installation migration history может считаться mutable development history, **только если project authority и фактическая publication/installation history подтверждают отсутствие published upgrade contract**. Первая поддерживаемая production installation может быть `0.x`; номер `v1.0` не является границей безопасности.

Разрешены verified correction/consolidation/squash/rebaseline, если это не ломает базу, которую обязаны поддерживать.

Dedicated rebaseline до первого published upgrade contract выполняется только в отдельном approved database scope, когда schema release-ready и production safety gate ниже доказан:

```text
empty database -> approved canonical baseline -> target schema
```

Baseline описывает конечное состояние, а не археологию `create -> rename -> alter -> drop`. Предпочитай одну initial migration, если framework естественно это поддерживает; не ломай conventions ради ровно одного физического файла.

## Production safety gate

Перед rewrite history докажи: существуют ли installations/staging/production databases, которые обязаны продолжать upgrade через текущие migration IDs/history? Если да — destructive squash блокируется до отдельного compatibility design.

## Published upgrade contract, including 0.x

Published migration IDs/history, которые являются supported installation/upgrade contract или могли быть применены к production installation, immutable уже до `v1.0`. Не переписывай, не удаляй, не renumber и не меняй их meaning ради чистоты. Новые schema changes идут новыми forward migrations.

Если история позже станет большой, fresh-install baseline/snapshot может быть добавлен отдельной стратегией **без потери legacy upgrade path**.

Release publication withdrawal не откатывает deployment, данные или применённые migrations и не делает опубликованные IDs снова mutable. Recovery/data rollback требует отдельного database/deployment design и authority. Изменение Git branch/release policy не является trigger нового DB baseline или переписывания migration history.

## Canonical source of truth

Не поддерживай две независимые схемы:

```text
fresh DB -> ORM auto-create
existing DB -> migrations
```

если обе отдельно определяют structure. ORM models могут выражать application expectations/validation, но migration architecture остаётся canonical schema-evolution path, если approved design не говорит иначе.
