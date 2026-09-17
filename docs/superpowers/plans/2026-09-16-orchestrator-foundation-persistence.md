# Orchestrator Foundation & Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать запускаемый local backend foundation: monorepo, versioned config, SQLite migrations, transactional outbox, background jobs, artifact store, startup state и HTTP/SSE shell.

**Architecture:** Один Node.js process владеет SQLite и in-process workers. Все persistent writes идут через небольшой database adapter; domain events записываются в outbox в той же transaction, затем EventDispatcher доставляет их idempotent consumers.

**Tech Stack:** Node.js 24 LTS; TypeScript 7; pnpm 11.27; Fastify 5.12; Vitest 5; Zod 4; ESLint 10.10 + typescript-eslint 8.70; `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-16-local-ai-development-orchestrator-design.md`

## Global Constraints

- Backend bind по умолчанию только `127.0.0.1`.
- SQLite: WAL, foreign keys ON, busy timeout; workers не стартуют до migrations и startup reconciliation.
- Durable event delivery at-least-once; consumers обязаны быть idempotent.
- Persistent formats имеют явный `schema_version`.
- Artifact paths в БД относительны `ORCHESTRATOR_HOME`.
- Никаких AI/LLM вызовов в этом плане.

---

### Task 1: Bootstrap pnpm workspace and strict TypeScript

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/main.ts`
- Create: `apps/server/test/bootstrap.test.ts`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/testing/package.json`
- Create: `packages/testing/tsconfig.json`
- Create: `packages/testing/src/index.ts`

**Interfaces:**
- Produces: root commands `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Produces: workspace packages `@ebb-orchestrator/contracts`, `@ebb-orchestrator/testing`, `@ebb-orchestrator/server`.

- [ ] **Step 1: Create workspace manifests and the failing smoke test**

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

Each package `tsconfig.json` extends `../../tsconfig.base.json`, sets `rootDir` to `src` for library packages (server includes both `src/**/*.ts` and `test/**/*.ts` without a `rootDir`), and includes only its own TypeScript sources/tests. Create `packages/testing/src/index.ts` as `export {};` and leave `packages/contracts/src/index.ts` as `export {};` for the failing-test step.

Create `apps/server/test/bootstrap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SYSTEM_NAME } from "@ebb-orchestrator/contracts";

describe("workspace", () => {
  it("resolves shared packages", () => {
    expect(SYSTEM_NAME).toBe("ebb-orchestrator");
  });
});
```

- [ ] **Step 2: Install dependencies and verify the smoke test fails for the missing export**

Run:

```bash
pnpm install
pnpm --filter @ebb-orchestrator/server test -- bootstrap.test.ts
```

Expected: FAIL because `@ebb-orchestrator/contracts` does not export `SYSTEM_NAME`.

- [ ] **Step 3: Add the minimal shared contract export**

Replace `packages/contracts/src/index.ts` with:

```ts
export const SYSTEM_NAME = "ebb-orchestrator" as const;
```

- [ ] **Step 4: Run the complete workspace verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Expected: all commands PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.js apps packages
git commit -m "chore: bootstrap orchestrator workspace"
```

---

### Task 2: Orchestrator home paths and versioned configuration loader

**Files:**
- Create: `apps/server/src/platform/config/app-config.ts`
- Create: `apps/server/src/platform/config/project-config.ts`
- Create: `apps/server/src/platform/config/config-errors.ts`
- Create: `apps/server/src/platform/home/orchestrator-home.ts`
- Test: `apps/server/test/platform/config/project-config.test.ts`
- Test: `apps/server/test/platform/home/orchestrator-home.test.ts`

**Interfaces:**
- Produces: `resolveOrchestratorHome(env, platform): OrchestratorHomePaths`.
- Produces: `parseProjectConfig(input): ProjectConfigV1`.

- [ ] **Step 1: Write failing tests for paths and unknown config keys**

```ts
it("resolves an explicit ORCHESTRATOR_HOME", () => {
  const paths = resolveOrchestratorHome({ ORCHESTRATOR_HOME: "/tmp/orch" }, "linux");
  expect(paths.database).toBe("/tmp/orch/orchestrator.db");
  expect(paths.artifacts).toBe("/tmp/orch/artifacts");
});

it("rejects unknown project config fields", () => {
  expect(() => parseProjectConfig({ schema_version: 1, project: { name: "x", default_branch: "master" }, reocvery: {} }))
    .toThrow(/unrecognized/i);
});
```

- [ ] **Step 2: Verify tests fail**

```bash
pnpm --filter @ebb-orchestrator/server test -- project-config.test.ts orchestrator-home.test.ts
```

- [ ] **Step 3: Implement schemas and platform paths**

Use Zod strict objects. Minimum project schema:

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

- [ ] **Step 4: Run tests and typecheck**

```bash
pnpm --filter @ebb-orchestrator/server test -- project-config.test.ts orchestrator-home.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform apps/server/test/platform
git commit -m "feat: add versioned config and orchestrator home"
```

---

### Task 3: SQLite adapter and restart-safe migration runner

**Files:**
- Create: `apps/server/src/platform/database/database.ts`
- Create: `apps/server/src/platform/database/sqlite-database.ts`
- Create: `apps/server/src/platform/database/migrator.ts`
- Create: `apps/server/src/platform/database/migrations/001_system.sql`
- Test: `apps/server/test/platform/database/migrator.test.ts`

**Interfaces:**
- Produces: `Database.transaction<T>(fn: (tx: DatabaseTx) => T): T`.
- Produces: `Database.run/get/all/exec` with bound parameters.
- Produces: `runMigrations(db, migrations): MigrationResult`.

- [ ] **Step 1: Write migration test**

The test must open a temp DB, run migrations twice, and assert exactly one migration record and required pragmas:

```ts
expect(db.get<{ mode: string }>("PRAGMA journal_mode")?.mode.toLowerCase()).toBe("wal");
expect(db.all("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }]);
```

Also inject a failing migration and assert its partial table is absent after rollback.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts
```

- [ ] **Step 3: Implement adapter and first migration**

`001_system.sql` contains the complete initial infrastructure schema:

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

Never interpolate values into SQL; use prepared statements.

- [ ] **Step 4: Run migration tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/database apps/server/test/platform/database
git commit -m "feat: add sqlite persistence and migrations"
```

---

### Task 4: Transactional outbox and idempotent event dispatcher

**Files:**
- Create: `apps/server/src/platform/events/domain-event.ts`
- Create: `apps/server/src/platform/events/outbox-repository.ts`
- Create: `apps/server/src/platform/events/event-bus.ts`
- Create: `apps/server/src/platform/events/event-dispatcher.ts`
- Test: `apps/server/test/platform/events/outbox.test.ts`

**Interfaces:**
- Produces: `DomainEvent<TType, TPayload>`.
- Produces: `appendOutboxEvent(tx, event)`.
- Produces: `EventBus.subscribe(type, consumerName, handler)`.
- Produces: `EventDispatcher.dispatchBatch(limit): Promise<number>`.

- [ ] **Step 1: Write transaction/idempotency tests**

Test A: state write and event are rolled back together when callback throws:

```ts
expect(() => db.transaction((tx) => {
  tx.run("INSERT INTO system_state(key,value_json,updated_at) VALUES (?,?,?)", ["x", "{}", now]);
  appendOutboxEvent(tx, event);
  throw new Error("rollback");
})).toThrow("rollback");
expect(db.get("SELECT key FROM system_state WHERE key = ?", ["x"])).toBeUndefined();
expect(db.get("SELECT id FROM outbox_events WHERE id = ?", [event.id])).toBeUndefined();
```

Test B: register consumer `audit`, call `dispatchBatch()` twice for the same event, and assert the handler counter remains `1`; `processed_events` must contain exactly one `(consumer_name,event_id)` row.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- outbox.test.ts
```

- [ ] **Step 3: Implement durable delivery**

Use `event_id` as ULID/string UUID generated by application code. Dispatcher flow:

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

If a handler throws, leave event pending and increment `attempts`; do not mark other consumers as unprocessed if they already committed their idempotency record.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- outbox.test.ts
```

Expected: PASS including duplicate delivery test.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/events apps/server/test/platform/events
git commit -m "feat: add transactional outbox dispatcher"
```

---

### Task 5: Background jobs, leases and dead-letter state

**Files:**
- Create: `apps/server/src/platform/jobs/job-types.ts`
- Create: `apps/server/src/platform/jobs/job-repository.ts`
- Create: `apps/server/src/platform/jobs/job-runner.ts`
- Test: `apps/server/test/platform/jobs/job-runner.test.ts`

**Interfaces:**
- Produces: `enqueueJob({ type, payload, priority, runAfter, dedupeKey })`.
- Produces: `JobRunner.runOnce(now): Promise<JobRunSummary>`.

- [ ] **Step 1: Write retry and dedupe tests**

Cases:

```text
same dedupeKey twice -> one runnable job
transient error -> RETRY_WAIT with later run_after
permanent error after max attempts -> DEAD_LETTER
expired lease -> another runner can claim
```

- [ ] **Step 2: Verify tests fail**

```bash
pnpm --filter @ebb-orchestrator/server test -- job-runner.test.ts
```

- [ ] **Step 3: Implement claim/update loop**

Statuses:

```ts
type JobStatus = "QUEUED" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER" | "CANCELLED";
```

Claim jobs in a DB transaction, assign `lease_owner` + `lease_expires_at`; use deterministic backoff schedule `[60,120,300,900,1800]` seconds plus bounded jitter.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- job-runner.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/jobs apps/server/test/platform/jobs
git commit -m "feat: add persistent background job runner"
```

---

### Task 6: Crash-safe artifact store

**Files:**
- Create: `apps/server/src/platform/artifacts/artifact-store.ts`
- Create: `apps/server/src/platform/artifacts/artifact-repository.ts`
- Test: `apps/server/test/platform/artifacts/artifact-store.test.ts`

**Interfaces:**
- Produces: `writeArtifact(input): Promise<ArtifactRecord>`.
- Produces: `openArtifact(id): Promise<Readable>`.
- Produces: `ArtifactRecord.storagePath` mapped to DB column `relative_path`; absolute paths are never persisted.

- [ ] **Step 1: Write atomic-write test**

Write an artifact to a temp home and assert:

```ts
expect(record.storagePath.startsWith("/")).toBe(false);
expect(await fs.readFile(path.join(home, record.storagePath), "utf8")).toBe("hello");
```

Inject a failure before rename and assert no final file/DB row exists.

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @ebb-orchestrator/server test -- artifact-store.test.ts
```

- [ ] **Step 3: Implement staged temp-file + rename flow**

Use a two-phase artifact state so a process crash never makes an unverified file look active:

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

Store SHA-256, size and media type before inserting the `STAGING` row. Add `reconcileStagingArtifacts()` with exact rules: final file exists + hash matches → `ACTIVE`; final file missing → delete stale DB row and leftover temp file; hash mismatch → `MISSING` and preserve evidence for diagnostics. `openArtifact()` only serves `ACTIVE` records.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ebb-orchestrator/server test -- artifact-store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/artifacts apps/server/test/platform/artifacts
git commit -m "feat: add crash-safe artifact storage"
```

---

### Task 7: Fastify app, local session auth, health and SSE

**Files:**
- Create: `apps/server/src/app/create-app.ts`
- Create: `apps/server/src/app/routes/health.ts`
- Create: `apps/server/src/app/routes/events.ts`
- Create: `apps/server/src/platform/security/local-session.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/test/app/health.test.ts`
- Test: `apps/server/test/app/security.test.ts`

**Interfaces:**
- Produces: `createApp(deps): FastifyInstance`.
- Produces: `GET /api/v1/health`.
- Produces: `GET /api/v1/events` SSE, authenticated.

- [ ] **Step 1: Write HTTP security tests**

Use Fastify inject:

```ts
expect((await app.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
expect((await app.inject({ method: "POST", url: "/api/v1/protected-test" })).statusCode).toBe(401);
```

Add Origin mismatch test returning 403.

- [ ] **Step 2: Verify tests fail**

```bash
pnpm --filter @ebb-orchestrator/server test -- health.test.ts security.test.ts
```

- [ ] **Step 3: Implement loopback server and auth hook**

Generate a random local session token at startup, keep it outside repo config, require it for mutating/protected API routes. Default listen:

```ts
await app.listen({ host: "127.0.0.1", port: config.port });
```

SSE sends only ephemeral UI events; reconnecting UI must re-fetch projections for authoritative state.

- [ ] **Step 4: Run tests and start smoke server**

```bash
pnpm --filter @ebb-orchestrator/server test -- health.test.ts security.test.ts
pnpm --filter @ebb-orchestrator/server dev
```

Expected: health reachable only on configured loopback listener.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app apps/server/src/platform/security apps/server/src/main.ts apps/server/test/app
git commit -m "feat: add local api shell and event stream"
```

---

### Task 8: Startup state machine, single-instance lock and reconciliation shell

**Files:**
- Create: `apps/server/src/platform/process/system-lifecycle.ts`
- Create: `apps/server/src/platform/process/single-instance-lock.ts`
- Create: `apps/server/src/platform/process/startup-reconciler.ts`
- Modify: `apps/server/src/main.ts`
- Test: `apps/server/test/platform/process/startup.test.ts`

**Interfaces:**
- Produces: `SystemStatus = STARTING|RECOVERING|READY|PAUSED|DEGRADED|SHUTTING_DOWN`.
- Produces: `StartupReconciler.run(): Promise<StartupReport>`.

- [ ] **Step 1: Write startup order test**

Assert call order:

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

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @ebb-orchestrator/server test -- startup.test.ts
```

- [ ] **Step 3: Implement lifecycle orchestration**

Keep startup order explicit in one function:

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

Expose `registerStartupReconciler()` and `registerBackgroundWorker()` for later plans; do not introduce Scheduler logic here. Graceful shutdown sets `SHUTTING_DOWN`, prevents new dispatch, stops workers, flushes dispatcher/jobs within a configured timeout, closes DB, then releases the instance lock.

- [ ] **Step 4: Run full Plan 1 suite**

```bash
pnpm typecheck
pnpm test
```

Expected: PASS, zero network/LLM requirements.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/platform/process apps/server/src/main.ts apps/server/test/platform/process
git commit -m "feat: add startup reconciliation lifecycle"
```

## Plan 1 acceptance gate

Run:

```bash
pnpm typecheck
pnpm test
```

Then manually kill/restart the server while an outbox event and retryable job are pending. After restart:

- DB migrates exactly once;
- pending event remains deliverable;
- expired job lease is recoverable;
- system transitions `STARTING → RECOVERING → READY`;
- second backend instance is rejected;
- no AI runtime exists yet.
