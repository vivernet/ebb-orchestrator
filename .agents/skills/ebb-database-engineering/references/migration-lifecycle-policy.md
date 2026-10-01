# Migration lifecycle policy

## Pre-v1 development history

До первого стабильного production release migration history считается mutable development history, **пока project authority явно не объявила её production contract**.

Разрешены verified correction/consolidation/squash/rebaseline, если это не ломает базу, которую обязаны поддерживать.

Перед `v1.0` выполни dedicated rebaseline, когда schema release-ready:

```text
empty database -> canonical v1.0 baseline -> v1.0 schema
```

Baseline описывает конечное состояние, а не археологию `create -> rename -> alter -> drop`. Предпочитай одну initial migration, если framework естественно это поддерживает; не ломай conventions ради ровно одного физического файла.

## Production safety gate

Перед rewrite history докажи: существуют ли installations/staging/production databases, которые обязаны продолжать upgrade через текущие migration IDs/history? Если да — destructive squash блокируется до отдельного compatibility design.

## From v1.0 onward

Migration, которая могла быть применена к production installation, является immutable production upgrade contract. Не переписывай, не удаляй, не renumber и не меняй её meaning ради чистоты. Новые schema changes идут новыми forward migrations.

Если история позже станет большой, fresh-install baseline/snapshot может быть добавлен отдельной стратегией **без потери legacy upgrade path**.

## Canonical source of truth

Не поддерживай две независимые схемы:

```text
fresh DB -> ORM auto-create
existing DB -> migrations
```

если обе отдельно определяют structure. ORM models могут выражать application expectations/validation, но migration architecture остаётся canonical schema-evolution path, если approved design не говорит иначе.
