# Cross-component plan review checklist

Используй только для применимых областей; `N/A` допустимо и не является дефектом.

| Область | Что доказать в plan | Типичный пробел |
|---|---|---|
| Auth/public API | routes, DTO, status/error, session/cookie/CSRF/TTL/revoke contracts | «уточним позже» |
| Persistence | owner транзакции/state, rollback, concurrency/idempotency, migration/upgrade paths | route пишет через чужой internal detail |
| Scheduler/runtime | preflight до side effects; все реальные entry paths | guard покрывает один путь |
| Browser/process | ports, readiness, shared state/restart, IPC, teardown, secret lifetime | mocked UI выдан за backend contract |
| Repository governance | реальные evidence, exact paths, naming/lifecycle, DAG, command ownership | будущий artifact указан как evidence |
| Verification | meaningful RED/GREEN, focused/neighboring/broader gates, original symptom | agent summary выдан за свежий output |

Дополнительно при применимости:

- Новая native/runtime dependency: exact version, lockfile/install impact и platform feasibility.
- Migration/catalog: cumulative state, upgrade/negative path и реальные consumers.
- Targeted tests: команда действительно выбирает заявленные files/tests; ожидаемые counts подтверждаемы.
- Concurrency: synchronization доказывает реальный порядок, а assertions покрывают полный durable state.
- Cleanup/move: disposition перечисляет реальные paths, а ссылки на старые пути ищутся по всему relevant tree.
