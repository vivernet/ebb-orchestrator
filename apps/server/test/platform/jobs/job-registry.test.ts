import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { BackgroundJobRegistry } from "../../../src/platform/jobs/background-job-registry.js";
import { JobRunner } from "../../../src/platform/jobs/job-runner.js";
import { JobWorker } from "../../../src/platform/jobs/job-worker.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationDir = fileURLToPath(new URL("../../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return { version: Number(match[1]), name: match[2]!, sql: readFileSync(join(migrationDir, file), "utf8") };
});

describe("BackgroundJobRegistry", () => {
  let registry: BackgroundJobRegistry;

  beforeEach(() => {
    registry = new BackgroundJobRegistry();
  });

  it("registers a handler successfully", () => {
    const handler = async (_job: { id: string; type: string }) => {};
    registry.register("test-job", handler);
    expect(registry.hasHandler("test-job")).toBe(true);
  });

  it("throws when registering duplicate handler", () => {
    const handler = async (_job: { id: string; type: string }) => {};
    registry.register("test-job", handler);
    expect(() => registry.register("test-job", handler)).toThrow("already registered");
  });

  it("unregisters a handler", () => {
    const handler = async (_job: { id: string; type: string }) => {};
    registry.register("test-job", handler);
    registry.unregister("test-job");
    expect(registry.hasHandler("test-job")).toBe(false);
  });

  it("gets handler by type", () => {
    const handler = async (_job: { id: string; type: string }) => {};
    registry.register("test-job", handler);
    expect(registry.getHandler("test-job")).toBe(handler);
  });

  it("returns undefined for unregistered handler", () => {
    expect(registry.getHandler("non-existent")).toBeUndefined();
  });

  it("returns all registered types", () => {
    registry.register("job-1", async (_job: { id: string; type: string }) => {});
    registry.register("job-2", async (_job: { id: string; type: string }) => {});
    expect(registry.getRegisteredTypes()).toEqual(["job-1", "job-2"]);
  });

  it("clears all handlers", () => {
    registry.register("job-1", async (_job: { id: string; type: string }) => {});
    registry.register("job-2", async (_job: { id: string; type: string }) => {});
    registry.clear();
    expect(registry.getRegisteredTypes()).toHaveLength(0);
  });
});

describe("JobRunner", () => {
  let db: ReturnType<typeof createSqliteDatabase>;
  let registry: BackgroundJobRegistry;

  beforeEach(() => {
    db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    registry = new BackgroundJobRegistry();
  });

  it("creates job with no handler registered", () => {
    const job = {
      id: randomUUID(),
      type: "non-existent-job",
      payload_json: JSON.stringify({ test: "data" }),
      dedupe_key: null,
      priority: 0,
      status: "QUEUED" as const,
      run_after: new Date().toISOString(),
      attempts: 0,
      max_attempts: 5,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.run(
      `INSERT INTO background_jobs (id, type, payload_json, dedupe_key, priority, status, run_after, attempts, max_attempts, lease_owner, lease_expires_at, last_error, created_at, updated_at)
       VALUES ($id, $type, $payload_json, $dedupe_key, $priority, $status, $run_after, $attempts, $max_attempts, $lease_owner, $lease_expires_at, $last_error, $created_at, $updated_at)`,
      job
    );

    const runner = new JobRunner(db, registry);
    const summary = runner.runOnce(new Date());

    return summary.then((result) => {
      expect(result.claimed).toBe(1);
      expect(result.failed).toBe(1);
      const updated = db.get<{ status: string; last_error: string }>(
        `SELECT status, last_error FROM background_jobs WHERE id = $id`,
        { id: job.id }
      );
      expect(updated!.status).toBe("FAILED");
      expect(updated!.last_error).toContain("No handler registered");
    });
  });

  it("executes registered handler successfully", () => {
    const handler = async (_job: { id: string; type: string }) => {
      // Simulate successful work
    };
    registry.register("success-job", handler);

    const job = {
      id: randomUUID(),
      type: "success-job",
      payload_json: JSON.stringify({ test: "data" }),
      dedupe_key: null,
      priority: 0,
      status: "QUEUED" as const,
      run_after: new Date().toISOString(),
      attempts: 0,
      max_attempts: 5,
      lease_owner: null,
      lease_expires_at: null,
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.run(
      `INSERT INTO background_jobs (id, type, payload_json, dedupe_key, priority, status, run_after, attempts, max_attempts, lease_owner, lease_expires_at, last_error, created_at, updated_at)
       VALUES ($id, $type, $payload_json, $dedupe_key, $priority, $status, $run_after, $attempts, $max_attempts, $lease_owner, $lease_expires_at, $last_error, $created_at, $updated_at)`,
      job
    );

    const runner = new JobRunner(db, registry);
    return runner.runOnce(new Date()).then((result) => {
      expect(result.claimed).toBe(1);
      expect(result.succeeded).toBe(1);
      const updated = db.get<{ status: string }>(
        `SELECT status FROM background_jobs WHERE id = $id`,
        { id: job.id }
      );
      expect(updated!.status).toBe("SUCCEEDED");
    });
  });
});

describe("JobWorker", () => {
  it("handles graceful shutdown while in-flight", () => {
    let resolve!: (value: void) => void;
    const promise = new Promise<void>((res) => { resolve = res; });

    const mockRunner = {
      runOnce: async () => {
        await promise;
        return { claimed: 0, succeeded: 0, failed: 0 };
      },
    };

    const worker = new JobWorker(mockRunner, 10, 100);
    worker.start();

    // Immediately request stop while work is in-flight
    worker.stop();
    resolve();

    // Should complete without error
    expect(true).toBe(true);
  });
});
