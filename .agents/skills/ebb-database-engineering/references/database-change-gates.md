# Database change gates

Перед нетривиальным persistence change ответь только на применимые вопросы и передай ответы в plan/task evidence.

## Schema and data

- Каков desired final schema/state: tables, columns/types/defaults/nullability, PK/FK, unique/check constraints, indexes, triggers/views?
- Какие существующие rows/states должны остаться валидными?
- Нужны ли backfill/data conversion или required bootstrap/seed/system records? Что делать с invalid/ambiguous legacy values?
- Есть ли irreversible information loss или staged migration безопаснее?

## Install and upgrade

- Меняется ли путь `empty DB -> current schema`?
- Какие реально поддерживаемые previous states должны upgrade до нового состояния?
- Нужна ли mixed-version/rolling compatibility, или deployment гарантированно single-version?

## Transactions, concurrency, recovery

- Какова atomicity boundary и isolation/concurrency assumption?
- Что произойдёт при failure halfway; какие statements реально transactional для данного engine/framework?
- Безопасен ли retry? Может ли startup увидеть partial state?
- Rollback действительно восстанавливает данные или backup/rebuild safer?

## Engine semantics

- Используется ли SQLite/PostgreSQL/другая engine-specific semantic?
- Является ли зависимость temporary implementation detail или deliberate architectural dependency?
- Протекает ли она в domain/API contract и создаёт ли реальный blocker для вероятной future engine migration?

SQLite-specific behavior не запрещено. Запрещено вводить его случайно и выдавать как portable semantics.

## Query/index changes

Для material performance change: зафиксируй реальный query, baseline, relevant query plan/indexes, correctness before performance и write/storage cost. Не добавляй index только потому, что column участвует в filter.

## Destructive gate

Drop/rename/incompatible type/identifier rewrite/data deletion требует: preservation decision, conversion proof, recovery/backup plan и explicit approval, если action затрагивает non-disposable data или выходит за approved plan.
