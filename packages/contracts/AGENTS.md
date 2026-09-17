# Ebb Orchestrator Contracts — Agent Instructions

Этот файл дополняет корневой `AGENTS.md` для `packages/contracts/**`.

Корневые правила имеют приоритет при любом конфликте.

## 1. Назначение package

`packages/contracts` содержит shared contracts, которые действительно нужны нескольким частям системы.

Это не место для server implementation details.

## 2. Dependency direction

`packages/contracts` не должен зависеть от:

- `apps/server`;
- `apps/web`;
- Hermes implementation;
- SQLite adapter;
- Git implementation;
- конкретного hosting provider.

Если тип нужен только одному backend-модулю, держать его рядом с этим модулем.

Не переносить внутренние типы в contracts только для устранения неудобного импорта.

## 3. Contract design

Shared contract должен быть:

- минимальным;
- стабильным;
- serializable, если он пересекает process/API boundary;
- независимым от implementation;
- явно versionable там, где это требуется.

Persistent IDs создаются системой, не AI.

Structured AI outputs не должны позволять модели произвольно задавать authoritative persistent IDs.

## 4. Compatibility

Изменение существующего shared contract считается cross-boundary изменением.

Перед изменением:

1. найти всех consumers;
2. определить compatibility impact;
3. обновить tests;
4. не делать silent breaking change.

## 5. Types

Предпочитать:

- explicit unions;
- enums/literals для domain states;
- discriminated unions для variant payloads;
- precise nullability;
- schema validation на trust boundaries.

Избегать:

- `any`;
- broad `Record<string, unknown>` вместо известной структуры;
- types, протекающих из ORM/DB driver;
- transport-specific types без необходимости.

## 6. Documentation

Exported domain contracts документировать русским JSDoc, если semantics, units, lifecycle или nullability неочевидны.

Не комментировать каждое поле, если имя и TypeScript полностью самодокументируемы.

## 7. Quality

Перед completion:

```bash
pnpm --filter @ebb-orchestrator/contracts typecheck
pnpm --filter @ebb-orchestrator/contracts test
pnpm lint
```

И затем полный repository gate, если изменение влияет на consumers.
