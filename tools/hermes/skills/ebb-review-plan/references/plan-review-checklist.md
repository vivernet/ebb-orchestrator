# Cross-component plan review checklist

Применяй только при соответствующем scope. Отсутствие применимости отмечай как N/A, не как дефект.

| Область | Проверить, если затронута | Типичный пробел |
|---|---|---|
| Auth/public API | routes, DTO, status/error, cookies/CSRF, TTL, rotation, revoke/idempotency | «DTO уточним потом» |
| Persistence/transactions | владелец транзакции, predicates, rollback, concurrency, migrations | route пишет в чужую persistence detail |
| Scheduler/runtime | preflight до side effects; HTTP, worker, runtime и direct-call paths | guard покрывает только один путь |
| Browser/process E2E | ports, process config, readiness, shared DB/restart, IPC, teardown/orphans, secret lifecycle | mocked UI выдан за backend contract |
| Plan governance | существующие evidence, Create/Modify scope, valid metadata, DAG, команды | будущий artifact указан как evidence |
| Verification | RED/GREEN, focused/related/full, исходный симптом, security/browser evidence | summary агента выдан за свежий output |

Дополнительные условные проверки:

- Новая криптографическая/runtime dependency: exact version, install/lockfile change и platform feasibility test.
- Migration/catalog changes: fixtures отражают применённые версии и cumulative state; проверены upgrade/negative paths.
- Выборочные тесты: команда действительно запускает заявленные test files; проверь фактический command output, а не предполагаемое поведение package script.
- Конкурентный сценарий: тест синхронизирует и подтверждает фактический порядок операций; проверяет полное durable state до/после, если это часть контракта.

Для каждого load-bearing contract или side-effect path должен быть понятен owner, тест и ожидаемый результат.
