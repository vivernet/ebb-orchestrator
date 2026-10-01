# Database verification

Выбирай только затронутые gates, но не подменяй один другим.

## Fresh database invariant

```text
empty DB -> canonical migrations -> current schema -> application startup -> relevant DB flows/tests
```

Проверь migration bookkeeping и применимые constraints/indexes. Existing developer DB не доказывает bootstrap.

## Upgrade invariant

```text
supported previous DB state -> new migrations -> current schema -> existing data valid -> application works
```

Используй репрезентативные legacy/data states, включая negative/ambiguous conversion path при наличии.

## Schema equivalence

При squash/rebaseline/schema-generation change сравни logical schema: tables, columns/types/defaults/nullability, primary/foreign keys, unique/check constraints, indexes, triggers/views и runtime-significant engine metadata. Предпочитай reliable introspection/schema diff. Любое необъяснённое отличие считается finding.

## Data integrity

Для data migration проверь counts/relationships/invariants, conversion failures, idempotency/retry semantics и отсутствие silent truncation/loss. Для destructive conversion сначала докажи target representation, затем удаляй legacy state.

## Failure/recovery

Если migration failure могла оставить неизвестное состояние: останови destructive continuation, определи фактическую schema/version/data state, выясни committed operations и проектируй recovery от наблюдаемого состояния. Не rerun вслепую.

## Evidence handoff

Возвращай exact commands/inspection, database starting state, fresh result, affected schema/data scope и limitations. Старый CI output или agent summary не заменяют свежую проверку current tree.
