# Architectural debugging checklist

Используй, когда symptom проходит через несколько компонентов или затрагивает auth, persistence, public API, scheduler/runtime, Web/E2E либо security boundary.

- Построй path: request/event source → validation/guards → state/transaction owner → side effects → response/event.
- Перечисли все реальные entry paths (HTTP, worker, runtime, CLI/direct-call) и проверь, где контракт расходится.
- До fix уточни load-bearing DTO/error semantics, transaction/rollback boundary, concurrency/idempotency и lifecycle transitions.
- Для process/browser пути проверь readiness/restart, real transport, worker-safe IPC, secret lifecycle и teardown/orphan processes.
- Для migration/projection/fixture проверь actual consumers, upgrade/negative paths и cumulative state; schema/migration/data/transaction contract сверяй с `ebb-database-engineering`.
- Сравни working/broken states и recent changes; одно отличие = одна проверяемая гипотеза.
- Regression обязана воспроизводить исходный symptom; общий зелёный unit suite не заменяет её.

Это investigation prompts, а не утверждение, что каждый механизм применим к любому bug.
