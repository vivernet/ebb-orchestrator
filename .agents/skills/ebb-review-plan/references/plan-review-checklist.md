# Cross-component plan review checklist

Используй только для применимых областей; `N/A` допустимо и не является дефектом.

| Область | Что доказать в plan | Типичный пробел |
|---|---|---|
| Auth/public API | routes, DTO, status/error, session/cookie/CSRF/TTL/revoke contracts | «уточним позже» |
| Database/persistence | owner state/transaction, desired schema/data state, migration/upgrade/fresh-install path, recovery/concurrency и `ebb-database-engineering` gates | migration file указан без data/upgrade contract |
| Scheduler/runtime | preflight до side effects; все реальные entry paths | guard покрывает один путь |
| Browser/process | ports, readiness, shared state/restart, IPC, teardown, secret lifetime | mocked UI выдан за backend contract |
| Repository governance | реальные evidence, exact paths, naming/lifecycle, DAG, command ownership | будущий artifact указан как evidence |
| Verification | meaningful RED/GREEN, focused/neighboring/broader gates, original symptom | agent summary выдан за свежий output |

Дополнительно при применимости:

- Новая native/runtime dependency: exact version, lockfile/install impact и platform feasibility.
- Database migration/catalog: cumulative state, production-history safety, upgrade/negative/fresh paths и реальные consumers.
- Targeted tests: команда действительно выбирает заявленные files/tests; ожидаемые counts подтверждаемы.
- Concurrency: synchronization доказывает реальный порядок, а assertions покрывают полный durable state.
- Cleanup/move: disposition перечисляет реальные paths, а ссылки на старые пути ищутся по всему relevant tree.
