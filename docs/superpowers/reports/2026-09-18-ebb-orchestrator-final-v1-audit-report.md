# Ebb Orchestrator — итоговый отчёт аудита и укрепления V1

Дата: 2026-09-18
Ветка: `audit/final-v1-hardening`
Базовый commit: `ca4a6ae`
Финальный remediation commit на момент отчёта: `5bd9be7`

## Резюме для руководства

Аудит подтвердил и исправил автоматически устранимые дефекты безопасности, выполнения, MCP и Web UI/API. Исправления прошли целевую проверку, повторную проверку в заданной области и полный набор проверок test/lint/typecheck.

Статус релиза: **NOT_READY** для полной интеграции V1.

Причина: остаются критически важные архитектурные решения, которые нельзя безопасно внедрить без явного решения по владению запуском и восстановлением, подключению PermissionEngine, надёжной синхронизации GitHub, политике очистки worktree, реальному release gate Hermes и production packaging.

## Результаты проверки

- `pnpm install --frozen-lockfile`: PASS (`pnpm v12.4.2`).
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS (`packages/contracts`, `packages/testing`, `apps/server`).
- `pnpm test`: PASS — server: 60 files, 612 passed, 2 skipped; web: 6 files, 65 passed; contracts/testing завершились через `--passWithNoTests`.
- `pnpm --filter @ebb-orchestrator/web build`: PASS — production-сборка Vite, преобразовано 39 модулей.
- `git diff --check`: PASS.
- Целевые наборы тестов безопасности и MCP: PASS; все целевые проверки исправлений завершились со статусом `ADDRESSED`.

Два пропущенных теста server — это opt-in-тесты реального Hermes, требующие `RUN_HERMES_E2E=1` и настроенных Hermes/model; они не считаются доказательством рабочего production wiring Hermes.

## ИСПРАВЛЕНО

- F-002/F-003/F-007: envelope/field/status mapping для Approval Inbox, авторизованное действие только approve, видимые и допускающие повторную попытку ошибки загрузки/изменения, состояния ошибок/повторной попытки dashboard, удаление неиспользуемых действий, структурированные ошибки API. Commits: `acfd7aa`, `9867669`.
- SEC-001: `GitTools` с подстановкой shell заменён на выполнение через argv.
- SEC-002: containment путей теперь работает в режиме fail-closed для предков symlink/junction, dangling symlink и symlink корня workspace; корректные новые файлы внутри workspace сохранены.
- SEC-004: подавление hook при managed commit через `--no-verify`.
- EXEC-005: ограниченный timeout, лимиты вывода, передача AbortSignal и обработка уже прерванного сигнала.
- GIT-007: валидация Git ref, защита end-of-options и валидация сгенерированной ветки.
- MCP-001: runtime-валидация аргументов MCP tool, включая рекурсивную item-level валидацию для `workspace.patch.patches`; некорректные payload отклоняются до изменения handler. Commits: `137ce0c`, `5bd9be7`.

## ПРИНЯТЫЕ ОГРАНИЧЕНИЯ / ТРЕБУЮТ РЕШЕНИЯ ЧЕЛОВЕКА

Следующие findings подтверждены независимым review всей ветки и намеренно не исправлялись молча:

- **SEC-003 / Critical:** `PermissionEngine` не подключён к agent-facing mutation paths; capability allowlist остаётся отдельной проверкой. Требуется архитектурное решение о server-side policy context и подключении через Action Gateway.
- **F-001 / GIT-006 / Critical:** `main.ts` обращается к `projects` до migrations, GitReconciler не инициализируется с repository path, ошибки reconciliation могут быть залогированы до перехода в READY. Требуется решение по владению startup/project repository и fail-closed recovery state.
- **GIT-008 / Critical:** `worktree remove --force` и fallback `rmSync(..., recursive:true, force:true)` могут удалить dirty data. Требуется lifecycle policy для dirty worktrees, retention и recovery.
- **F-004 / Important:** GitHub sync state по умолчанию process-local, polling errors не durable/retriable. Требуется persistent outbox/sync-record design.
- **F-005 / Important:** real Hermes E2E opt-in/skipped by default. Требуется deterministic Hermes fixture либо обязательный отдельный release gate.
- **F-006 / Important:** отсутствует production server build/package gate; web build существует отдельно. Требуется определить deployable artifact/package contract.

## Покрытие архитектуры

- Границы modular monolith: **PARTIAL** — отдельные modules/services присутствуют, но PermissionEngine boundary не подключена к agent mutation path.
- Подход с приоритетом детерминированности: **PASS** в проверенных scheduler/budget/Git/approval paths; нерешённые startup/GitHub policy decisions перечислены выше.
- Границы source of truth: **PARTIAL** — SQLite/Git/repository config разделены, но startup Git reconciliation не завершает надёжный ownership flow.
- Абстракция AgentRuntime: **PASS**.
- Границы ролей и submit_result: **PASS/PARTIAL** — fake/runtime unit coverage зелёная; real Hermes path opt-in.
- Persistence/migrations: **PARTIAL** — migrations, FK/WAL и transactional migration tests проходят; production startup читает schema до migration.
- Recovery/scheduler/budget: **PARTIAL** — unit/crash/budget suites проходят; production reconciliation jobs/artifacts и fail-closed startup wiring не завершены.
- Web UI/API: **PASS** для исправленных v1 flows, покрытых тестами.
- Интеграция GitHub: **PARTIAL** — optional adapter существует, durable restart-safe sync не решена.
- Build/reproducibility: **PARTIAL** — frozen install/lint/typecheck/web build проходят; server production artifact gate не решён.
- Документация: **PARTIAL** — этот отчёт фиксирует ограничения; operator README всё ещё требует отдельного прохода по operational documentation.

## Резюме по безопасности

- Обход Action Gateway: **PARTIAL / unresolved SEC-003** — интеграция PermissionEngine не объявляется исправленной молча.
- Containment путей: **PASS** для проверенных случаев lexical, symlink, dangling symlink и root symlink; покрытие Windows junction остаётся защищённым проверкой платформы.
- Политика shell/process: **PASS** для исправленных путей GitTools/CommandTools: argv, `shell:false`, timeout, ограниченный вывод и отмена.
- Git hooks: **PASS** для managed commit path; обычные пользовательские Git-операции не входят в эту managed policy.
- Секреты/окружение: существующий allowlist окружения и локальная привязка к loopback проверены.
- Enforcement подтверждений: проверки финального merge approval по-прежнему покрыты; UI показывает только реализованное действие approve.
- Граница prompt injection: в проверенных путях автоматического authority repository instructions не обнаружено.

## Резюме по надёжности

- Порядок миграций и транзакционность: проверены и проходят.
- Восстановление при запуске: **NOT_READY**, поскольку production wiring зависит от schema до migrations, а reconciliation может завершиться с открытым доступом.
- Git journal/reconciliation: **PARTIAL**; инициализация и политика dirty-worktree не решены.
- Idempotency/concurrency/budget reservation: покрыты проходящими наборами тестов, но перечисленные выше production integration gaps не решены.
- GitHub retry/durability: не решены.

## Резюме тестов

- Итоговый набор workspace: server — 60 test files / 612 passed / 2 skipped; web — 6 test files / 65 passed.
- Целевые security tests покрывают argv commit messages, подавление hook, валидацию ref, containment symlink/dangling/root, timeout/output limits и отмену.
- Целевые MCP tests покрывают required/type/additionalProperties и рекурсивную patch-item validation.
- Real Hermes E2E tests остаются явно opt-in и пропускаются в наборе по умолчанию.

## Итоговая рекомендация

**NOT_READY**.

Ветка подходит как прошедшая review ветка укрепления с явно обозначенными архитектурными блокерами, но не как утверждение о полной готовности V1 к выпуску. Не выполняйте merge в `master`, push или работу над функциями post-v1, пока перечисленные решения человека не приняты, а соответствующие проверки startup/recovery, PermissionEngine, GitHub durability, worktree safety, Hermes gate и packaging не реализованы и не пройдут повторный аудит.
