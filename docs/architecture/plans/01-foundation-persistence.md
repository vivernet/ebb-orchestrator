---
id: plan-01
kind: plan
roadmap: 01
stage: 01
status: in_progress
title: Plan Document
created: 2026-09-23
updated: 2026-09-23
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence: []
---
# План реализации Foundation и Persistence Orchestrator

> **Для агентных исполнителей:** ОБЯЗАТЕЛЬНЫЙ SUB-SKILL: Использовать superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации этого плана по задачам. Для отслеживания шаги используют синтаксис флажков (`- [ ]`).

**Цель:** Создать запускаемый основу локального backend: monorepo, версионированную конфигурацию, SQLite migrations, transactional outbox, background jobs, artifact store, startup state и HTTP/SSE shell.

**Архитектура:** Один Node.js process владеет SQLite и in-process workers. Все persistent writes идут через небольшой database adapter; domain events записываются в outbox в той же transaction, затем EventDispatcher доставляет их idempotent consumers.

**Технологический стек:** Node.js 24 LTS; TypeScript 7; pnpm 11.27; Fastify 5.12; Vitest 5; Zod 4; ESLint 10.10 + typescript-eslint 8.70; `node:sqlite`.

**Спецификация:** `docs/architecture/specs/01-system-design.md`

## Глобальные ограничения

- Backend bind по умолчанию только `127.0.0.1`.
- SQLite: WAL, foreign keys ON, busy timeout; workers не стартуют до migrations и startup reconciliation.
- Durable event delivery at-least-once; consumers обязаны быть idempotent.
- Persistent formats имеют явный `schema_version`.
- Artifact paths в БД относительны `EBB_ORCHESTRATOR_HOME`.
- Никаких AI/LLM вызовов в этом плане.

---

### Задача 1: Инициализация pnpm workspace и строгого TypeScript

****Файлы:****
- Создать: `package.json`
- Создать: `pnpm-workspace.yaml`
- Создать: `tsconfig.base.json`
- Создать: `eslint.config.js`
- Создать: `apps/server/package.json`
- Создать: `apps/server/tsconfig.json`
- Создать: `apps/server/src/main.ts`
- Создать: `apps/server/test/bootstrap.test.ts`
- Создать: `packages/contracts/package.json`
- Создать: `packages/contracts/tsconfig.json`
- Создать: `packages/contracts/src/index.ts`
- Создать: `packages/testing/package.json`
- Создать: `packages/testing/tsconfig.json`
- Создать: `packages/testing/src/index.ts`

****Интерфейсы:****
- Создаёт: root commands `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Создаёт: workspace packages `@ebb-orchestrator/contracts`, `@ebb-orchestrator/testing`, `@ebb-orchestrator/server`.

- [ ] **Шаг 1: Создать манифесты workspace и падающий smoke test**

Root `package.json`:

```json
{
  "name": "ebb-orchestrator",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.27.0",
  "engines": { "node": ">=24.15 <25" },
  "scripts": {
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "lint": "eslint ."
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^24.13.4",
    "eslint": "^10.10.0",
    "typescript": "^7.0.0",
    "tsx": "^4.23.13",
    "typescript-eslint": "^8.70.0",
    "vitest": "^5.0.0"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

`eslint.config.js`:

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`apps/server/package.json`:

```json
{
  "name": "@ebb-orchestrator/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@ebb-orchestrator/contracts": "workspace:*",
    "fastify": "^5.12.4",
    "zod": "^4.6.0"
  }
}
```

`packages/contracts/package.json`:

```json
{
  "name": "@ebb-orchestrator/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  }
}
```

`packages/testing/package.json`:

```json
{
  "name": "@ebb-orchestrator/testing",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  }
}
```

Каждый `tsconfig.json` package расширяет `../../tsconfig.base.json`, задаёт `rootDir` равным `src` для library packages (server включает `src/**/*.ts` и `test/**/*.ts` без `rootDir`) и включает только собственные TypeScript sources/tests. Создать `packages/testing/src/index.ts` как `export {};`, а `packages/contracts/src/index.ts` оставить как `export {};` для шага с падающим тестом.

Создать `apps/server/test/bootstrap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SYSTEM_NAME } from "@ebb-orchestrator/contracts";

describe("workspace", () => {
  it("resolves shared packages", () => {
    expect(SYSTEM_NAME).toBe("ebb-orchestrator");
  });
});
```

- [ ] **Шаг 2: Установить зависимости и проверить, что smoke test завершается ошибкой из-за отсутствующего экспорта**

Запустить:

```bash
pnpm install
pnpm --filter @ebb-orchestrator/server test -- bootstrap.test.ts
```

Ожидается: FAIL, потому что `@ebb-orchestrator/contracts` не экспортирует `SYSTEM_NAME`.

- [ ] **Шаг 3: Добавить минимальный общий экспорт контракта**

Заменить `packages/contracts/src/index.ts` на:

```ts
export const SYSTEM_NAME = "ebb-orchestrator" as const;
```

- [ ] **Шаг 4: Запустить полную проверку workspace**

Запустить:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Ожидается: все команды PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.js apps packages
git commit -m "chore: bootstrap orchestrator workspace"
```

---

### Задача 2: Пути Orchestrator home и версионированную конфигурациюuration loader

****Файлы:****
- Создать: `apps/server/src/platform/config/app-config.ts`
- Создать: `apps/server/src/platform/config/project-config.ts`
- Создать: `apps/server/src/platform/config/config-errors.ts`
- Создать: `apps/server/src/platform/home/orchestrator-home.ts`
- Тест: `apps/server/test/platform/config/project-config.test.ts`
- Тест: `apps/server/test/platform/home/orchestrator-home.test.ts`

****Интерфейсы:****
- Создаёт: `resolveOrchestratorHome(env, platform): OrchestratorHomePaths`.
- Создаёт: `parseProjectConfig(input): ProjectConfigV1`.

- [ ] **Шаг 1: Написать не проходящие тесты для paths и неизвестных ключей конфигурации**

```ts
it("resolves an explicit EBB_ORCHESTRATOR_HOME", () => {
  const paths = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: "/tmp/orch" }, "linux");
  expect(paths.database).toBe("/tmp/orch/orchestrator.db");
  expect(paths.artifacts).toBe("/tmp/orch/artifacts");
});

it("rejects unknown project config fields", () => {
  expect(() => parseProjectConfig({ schema_version: 1, project: { name: "x", default_branch: "master" }, reocvery: {} }))
    .toThrow(/unrecognized/i);
});
```

- [ ] **Шаг 2: Проверить, что тесты не проходят**

```bash
pnpm --filter @ebb-orchestrator/server test -- project-config.test.ts orchestrator-home.test.ts
```

- [ ] **Шаг 3: Реализовать schemas и platform paths**

Использовать Zod strict objects. Minimum project schema:

```ts
export const ProjectConfigV1Schema = z.strictObject({
  schema_version: z.literal(1),
  project: z.strictObject({
    name: z.string().min(1),
    default_branch: z.string().min(1),
  }),
  execution: z.strictObject({
    mode: z.literal("local").default("local"),
  }).default({ mode: "local" }),
});
```

`OrchestratorHomePaths` includes `root`, `database`, `artifacts`, `runtime`, `logs`, `backups`, `worktrees`.

- [ ] **Шаг 4: Запустить тесты и typecheck**

```bash
pnpm --filter @ebb-orchestrator/server test -- project-config.test.ts orchestrator-home.test.ts
pnpm typecheck
```

Ожидается: PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/platform apps/server/test/platform
git commit -m "feat: add versioned config and orchestrator home"
```

---

### Задача 3: SQLite adapter и безопасный при перезапуске migration runner

****Файлы:****
- Создать: `apps/server/src/platform/database/database.ts`
- Создать: `apps/server/src/platform/database/sqlite-database.ts`
- Создать: `apps/server/src/platform/database/migrator.ts`
- Создать: `apps/server/src/platform/database/migrations/001_system.sql`
- Тест: `apps/server/test/platform/database/migrator.test.ts`

****Интерфейсы:****
- Создаёт: `Database.transaction<T>(fn: (tx: DatabaseTx) => T): T`.
- Создаёт: `Database.run/get/all/exec` с bound parameters.
- Создаёт: `runMigrations(db, migrations): MigrationResult`.

- [ ] **Шаг 1: Написать тест миграций**

Тест должен открыть временную БД, дважды запустить миграции и проверить наличие ровно одной записи миграции и требуемых pragmas:

```ts
expect(db.get<{ mode: string }>("PRAGMA journal_mode")?.mode.toLowerCase()).toBe("wal");
expect(db.all("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }]);
```

Также добавить падающую миграцию и проверить, что её частично созданная таблица отсутствует после rollback.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts
```

- [ ] **Шаг 3: Реализовать adapter и первую миграцию**

`001_system.sql` содержит полную начальную infrastructure schema:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  processed_at TEXT
);

CREATE TABLE processed_events (
  consumer_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (consumer_name, event_id),
  FOREIGN KEY (event_id) REFERENCES outbox_events(id) ON DELETE RESTRICT
);

CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')),
  run_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  content_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STAGING' CHECK (status IN ('STAGING','ACTIVE','EXPIRED','MISSING')),
  project_id TEXT,
  task_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX idx_outbox_pending
  ON outbox_events(processed_at, available_at, created_at);
CREATE INDEX idx_jobs_runnable
  ON background_jobs(status, run_after, priority DESC, created_at);
CREATE UNIQUE INDEX idx_jobs_active_dedupe
  ON background_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING','RETRY_WAIT');
CREATE INDEX idx_artifacts_scope
  ON artifacts(project_id, task_id, run_id);
```

Enable:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

Никогда не подставлять значения в SQL; использовать prepared statements.

- [ ] **Шаг 4: Запустить тесты миграций**

```bash
pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts
pnpm typecheck
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/platform/database apps/server/test/platform/database
git commit -m "feat: add sqlite persistence and migrations"
```

---

### Задача 4: Transactional outbox и idempotent event dispatcher

****Файлы:****
- Создать: `apps/server/src/platform/events/domain-event.ts`
- Создать: `apps/server/src/platform/events/outbox-repository.ts`
- Создать: `apps/server/src/platform/events/event-bus.ts`
- Создать: `apps/server/src/platform/events/event-dispatcher.ts`
- Тест: `apps/server/test/platform/events/outbox.test.ts`

****Интерфейсы:****
- Создаёт: `DomainEvent<TType, TPayload>`.
- Создаёт: `appendOutboxEvent(tx, event)`.
- Создаёт: `EventBus.subscribe(type, consumerName, handler)`.
- Создаёт: `EventDispatcher.dispatchBatch(limit): Promise<number>`.

- [ ] **Шаг 1: Написать тесты transaction/idempotency**

Тест A: запись состояния и событие откатываются вместе, если callback выбрасывает исключение:

```ts
expect(() => db.transaction((tx) => {
  tx.run("INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?)", ["x", "{}", now]);
  appendOutboxEvent(tx, event);
  throw new Error("rollback");
})).toThrow("rollback");
expect(db.get("SELECT key FROM system_state WHERE key = ?", ["x"])).toBeUndefined();
expect(db.get("SELECT id FROM outbox_events WHERE id = ?", [event.id])).toBeUndefined();
```

Тест B: зарегистрировать consumer `audit`, дважды вызвать `dispatchBatch()` для одного события и проверить, что счётчик обработчика остаётся равен `1`; `processed_events` должен содержать ровно одну строку `(consumer_name,event_id)`.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- outbox.test.ts
```

- [ ] **Шаг 3: Реализовать надёжную доставку**

Использовать `event_id` как ULID/string UUID, сгенерированный кодом приложения. Поток Dispatcher:

```ts
for (const event of pendingEvents) {
  for (const subscription of bus.subscriptionsFor(event.type)) {
    if (!processedEvents.has(subscription.name, event.id)) {
      await subscription.handler(event);
      processedEvents.mark(subscription.name, event.id);
    }
  }
  outbox.markProcessed(event.id);
}
```

Если handler выбрасывает исключение, оставить event в состоянии pending и увеличить `attempts`; не помечать других consumers как необработанных, если они уже зафиксировали свою idempotency record.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- outbox.test.ts
```

Ожидается: PASS включая тест дублирующейся доставки.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/platform/events apps/server/test/platform/events
git commit -m "feat: add transactional outbox dispatcher"
```

---

### Задача 5: Background jobs, leases и состояние dead-letter

****Файлы:****
- Создать: `apps/server/src/platform/jobs/job-types.ts`
- Создать: `apps/server/src/platform/jobs/job-repository.ts`
- Создать: `apps/server/src/platform/jobs/job-runner.ts`
- Тест: `apps/server/test/platform/jobs/job-runner.test.ts`

****Интерфейсы:****
- Создаёт: `enqueueJob({ type, payload, priority, runAfter, dedupeKey })`.
- Создаёт: `JobRunner.runOnce(now): Promise<JobRunSummary>`.

- [ ] **Шаг 1: Написать тесты retry и dedupe**

Случаи:

```text
same dedupeKey twice -> one runnable job
transient error -> RETRY_WAIT with later run_after
permanent error after max attempts -> DEAD_LETTER
expired lease -> another runner can claim
```

- [ ] **Шаг 2: Проверить, что тесты не проходят**

```bash
pnpm --filter @ebb-orchestrator/server test -- job-runner.test.ts
```

- [ ] **Шаг 3: Реализовать цикл claim/update**

Statuses:

```ts
type JobStatus = "QUEUED" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER" | "CANCELLED";
```

Забирать jobs в DB transaction, назначать `lease_owner` + `lease_expires_at`; использовать детерминированное расписание backoff `[60,120,300,900,1800]` секунд с bounded jitter.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- job-runner.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/platform/jobs apps/server/test/platform/jobs
git commit -m "feat: add persistent background job runner"
```

---

### Задача 6: Crash-safe artifact store

****Файлы:****
- Создать: `apps/server/src/platform/artifacts/artifact-store.ts`
- Создать: `apps/server/src/platform/artifacts/artifact-repository.ts`
- Тест: `apps/server/test/platform/artifacts/artifact-store.test.ts`

****Интерфейсы:****
- Создаёт: `writeArtifact(input): Promise<ArtifactRecord>`.
- Создаёт: `openArtifact(id): Promise<Readable>`.
- Создаёт: `ArtifactRecord.storagePath` отображается в колонку БД `relative_path`; абсолютные пути никогда не сохраняются.

- [ ] **Шаг 1: Написать тест атомарной записи**

Записать artifact во временный home и проверить:

```ts
expect(record.storagePath.startsWith("/")).toBe(false);
expect(await fs.readFile(path.join(home, record.storagePath), "utf8")).toBe("hello");
```

Внедрить сбой перед rename и проверить отсутствие итогового файла/строки БД.

- [ ] **Шаг 2: Проверить, что тест завершается ошибкой**

```bash
pnpm --filter @ebb-orchestrator/server test -- artifact-store.test.ts
```

- [ ] **Шаг 3: Реализовать поток с временным файлом в STAGING и переименованием**

Использовать двухфазное состояние artifact so a process crash never makes an unverified file look active:

```ts
const tempPath = `${absoluteFinalPath}.${randomUUID()}.tmp`;
const handle = await fs.open(tempPath, "wx");
try {
  await handle.writeFile(input.bytes);
  await handle.sync();
} finally {
  await handle.close();
}

repository.insert({ ...record, status: "STAGING" });
await fs.rename(tempPath, absoluteFinalPath);
repository.markActive(record.id);
```

Сохранить SHA-256, size и media type перед вставкой строки `STAGING`. Добавить `reconcileStagingArtifacts()` с точными правилами: итоговый файл существует и hash совпадает → `ACTIVE`; итоговый файл отсутствует → удалить устаревшую строку БД и оставшийся временный файл; hash не совпадает → `MISSING` и сохранить evidence для диагностики. `openArtifact()` обслуживает только записи `ACTIVE`.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- artifact-store.test.ts
```

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/platform/artifacts apps/server/test/platform/artifacts
git commit -m "feat: add crash-safe artifact storage"
```

---

### Задача 7: Fastify app, local session auth, health и SSE

****Файлы:****
- Создать: `apps/server/src/app/create-app.ts`
- Создать: `apps/server/src/app/routes/health.ts`
- Создать: `apps/server/src/app/routes/events.ts`
- Создать: `apps/server/src/platform/security/local-session.ts`
- Изменить: `apps/server/src/main.ts`
- Тест: `apps/server/test/app/health.test.ts`
- Тест: `apps/server/test/app/security.test.ts`

****Интерфейсы:****
- Создаёт: `createApp(deps): FastifyInstance`.
- Создаёт: `GET /api/v1/health`.
- Создаёт: `GET /api/v1/events` SSE, authenticated.

- [ ] **Шаг 1: Написать тесты HTTP-безопасности**

Использовать Fastify inject:

```ts
expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
expect((await app.inject({ method: "POST", url: "/api/v1/protected-test" })).statusCode).toBe(401);
```

Добавить тест несовпадения Origin, возвращающий 403.

- [ ] **Шаг 2: Проверить, что тесты не проходят**

```bash
pnpm --filter @ebb-orchestrator/server test -- health.test.ts security.test.ts
```

- [ ] **Шаг 3: Реализовать loopback-сервер и auth hook**

Сгенерировать при запуске случайный local session token, хранить его вне конфигурации repo и требовать его для изменяющих/protected API routes. Слушать по умолчанию:

```ts
await app.listen({ host: "127.0.0.1", port: config.port });
```

SSE отправляет только ephemeral UI events; после переподключения UI должен повторно получить projections для authoritative state.

- [ ] **Шаг 4: Запустить тесты и стартовый smoke server**

```bash
pnpm --filter @ebb-orchestrator/server test -- health.test.ts security.test.ts
pnpm --filter @ebb-orchestrator/server dev
```

Ожидается: health доступен только на настроенном loopback listener.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/app apps/server/src/platform/security apps/server/src/main.ts apps/server/test/app
git commit -m "feat: add local api shell and event stream"
```

---

### Задача 8: State machine запуска, single-instance lock и reconciliation shell

****Файлы:****
- Создать: `apps/server/src/platform/process/system-lifecycle.ts`
- Создать: `apps/server/src/platform/process/single-instance-lock.ts`
- Создать: `apps/server/src/platform/process/startup-reconciler.ts`
- Изменить: `apps/server/src/main.ts`
- Тест: `apps/server/test/platform/process/startup.test.ts`

****Интерфейсы:****
- Создаёт: `SystemStatus = STARTING|RECOVERING|READY|PAUSED|DEGRADED|SHUTTING_DOWN`.
- Создаёт: `StartupReconciler.run(): Promise<StartupReport>`.

- [ ] **Шаг 1: Написать тест порядка запуска**

Проверить порядок вызовов:

```text
acquire lock
→ open DB
→ migrations
→ status RECOVERING
→ reconcile outbox/jobs/stale leases
→ status READY
→ workers start
```

And assert second instance cannot acquire lock.

- [ ] **Шаг 2: Проверить отказ**

```bash
pnpm --filter @ebb-orchestrator/server test -- startup.test.ts
```

- [ ] **Шаг 3: Реализовать orchestration жизненного цикла**

Сохранить явный порядок запуска в одной функции:

```ts
export async function startSystem(deps: SystemLifecycleDeps): Promise<void> {
  await deps.instanceLock.acquire();
  await deps.database.open();
  await deps.migrator.run();
  await deps.status.set("RECOVERING");
  await deps.reconcileOutbox();
  await deps.reconcileJobs();
  await deps.reconcileArtifacts();
  for (const reconcile of deps.additionalReconcilers) await reconcile();
  await deps.status.set("READY");
  for (const worker of deps.workers) await worker.start();
}
```

Предоставить `registerStartupReconciler()` и `registerBackgroundWorker()` для последующих планов; не добавлять здесь логику Scheduler. При graceful shutdown установить `SHUTTING_DOWN`, запретить новый dispatch, остановить workers, завершить dispatcher/jobs в пределах настроенного timeout, закрыть БД, затем освободить instance lock.

- [ ] **Шаг 4: Запустить полный набор тестов Plan 1**

```bash
pnpm typecheck
pnpm test
```

Ожидается: PASS, отсутствие требований к network/LLM.

- [ ] **Шаг 5: Коммит**

```bash
git add apps/server/src/platform/process apps/server/src/main.ts apps/server/test/platform/process
git commit -m "feat: add startup reconciliation lifecycle"
```

## Plan 1 критерии приёмки

Запустить:

```bash
pnpm typecheck
pnpm test
```

Затем вручную завершить/перезапустить server, пока ожидаются outbox event и retryable job. После перезапуска:

- DB мигрируется ровно один раз;
- pending event остаётся доступным для доставки;
- истёкший job lease можно восстановить;
- system transitions `STARTING → RECOVERING → READY`;
- второй экземпляр backend отклоняется;
- no AI runtime exists yet.
