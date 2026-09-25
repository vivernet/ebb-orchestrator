# Architectural debugging checklist

Используй только когда симптом проходит через несколько компонент или затрагивает auth, persistence, public API, scheduler/runtime, Web/E2E или security boundary.

- Карта: источник запроса → проверки → владельцы состояния/транзакции → side effects → ответ/событие.
- Отдельно проверь все entry paths: HTTP, worker, runtime и direct-call, если они существуют для этой функции.
- До фикса согласуй load-bearing DTO/error semantics, transaction/rollback boundary, concurrency/idempotency и lifecycle transitions.
- Для browser/process сценария проверь реальный transport, readiness/restart, worker-safe IPC, secret lifecycle и teardown/orphan processes.
- Миграции, projections и fixtures должны быть проверены реальными consumers и upgrade/negative paths.
- Тестируй исходный симптом и регрессию; общий зелёный unit suite не заменяет их.

Это вопросы расследования, а не утверждения, что все перечисленные механизмы применимы в любом баге.

