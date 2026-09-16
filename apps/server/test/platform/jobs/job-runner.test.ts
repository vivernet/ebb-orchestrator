import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { enqueueJob } from "../../../src/platform/jobs/job-repository.js";
import { JobRunner } from "../../../src/platform/jobs/job-runner.js";

const migration001 = await readFile(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
];

describe("background job runner", () => {
  let db: Database | undefined;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-job-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  it("same dedupeKey twice results in one runnable job", async () => {
    db = await setupDb();

    const job1Id = enqueueJob(db, {
      type: "test.task",
      payload: { value: 1 },
      dedupeKey: "unique-1",
    });

    const job2Id = enqueueJob(db, {
      type: "test.task",
      payload: { value: 2 },
      dedupeKey: "unique-1",
    });

    // Both calls return a UUID but only one row should exist
    expect(job1Id).toBeDefined();
    expect(job2Id).toBeDefined();

    const rows = db.all<{ id: string; status: string }>(
      "SELECT id, status FROM background_jobs WHERE dedupe_key = $dk",
      { dk: "unique-1" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("QUEUED");
  });

  it("transient error places job in RETRY_WAIT with later run_after", async () => {
    db = await setupDb();

    const jobRunner = new JobRunner(db, {
      testTask: async () => {
        throw new Error("transient failure");
      },
    });

    const job1Id = enqueueJob(db, {
      type: "testTask",
      payload: {},
    });

    const now = new Date();
    const result = await jobRunner.runOnce(now);

    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(0);
    // A retry is not a terminal failure – only DEAD_LETTER / FAILED count
    expect(result.failed).toBe(0);

    const row = db.get<{ status: string; run_after: string; attempts: number }>(
      "SELECT status, run_after, attempts FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe("RETRY_WAIT");
    expect(row!.attempts).toBe(1);
    // run_after should be in the future (at least ~54 seconds from now accounting for ±10% jitter)
    const runAfter = new Date(row!.run_after);
    expect(runAfter.getTime()).toBeGreaterThan(now.getTime() + 53_000);
  });

  it("permanent error after max attempts goes to DEAD_LETTER", async () => {
    db = await setupDb();

    const jobRunner = new JobRunner(db, {
      testTask: async () => {
        throw new Error("permanent failure");
      },
    });

    enqueueJob(db, {
      type: "testTask",
      payload: {},
      maxAttempts: 3,
    });

    // Run 3 times, advancing enough time past the backoff each iteration.
    // Backoff schedule: [60, 120, …] seconds.
    // Each iteration advances 300 s which exceeds the previous backoff.
    for (let i = 0; i < 3; i++) {
      const futureNow = new Date(Date.now() + (i + 1) * 300_000);
      const result = await jobRunner.runOnce(futureNow);
      expect(result.claimed).toBe(1);
    }

    const row = db.get<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM background_jobs WHERE type = 'testTask'",
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe("DEAD_LETTER");
    expect(row!.attempts).toBe(3);
  });

  it("expired lease allows another runner to claim the job", async () => {
    db = await setupDb();

    let callCount = 0;
    const jobRunner = new JobRunner(db, {
      testTask: async () => {
        callCount++;
        if (callCount === 1) {
          // Simulate long-running work that causes a transient error
          throw new Error("lease expired during work");
        }
        // Second attempt succeeds
      },
    });

    const job1Id = enqueueJob(db, {
      type: "testTask",
      payload: {},
      maxAttempts: 3,
    });

    const now = new Date();

    // First run – transient failure → RETRY_WAIT
    const result1 = await jobRunner.runOnce(now);
    expect(result1.claimed).toBe(1);

    const afterFirst = db.get<{ status: string; run_after: string }>(
      "SELECT status, run_after FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(afterFirst!.status).toBe("RETRY_WAIT");

    // Second run with time advanced past retry → should succeed
    const futureNow = new Date(Date.now() + 70_000);
    const result2 = await jobRunner.runOnce(futureNow);
    expect(result2.claimed).toBe(1);
    expect(result2.succeeded).toBe(1);

    const afterSecond = db.get<{ status: string }>(
      "SELECT status FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(afterSecond!.status).toBe("SUCCEEDED");
  });

  it("runOnce returns 0 claimed when no jobs are runnable", async () => {
    db = await setupDb();

    const jobRunner = new JobRunner(db, {});

    const result = await jobRunner.runOnce(new Date());
    expect(result.claimed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("successful job is marked SUCCEEDED", async () => {
    db = await setupDb();

    const jobRunner = new JobRunner(db, {
      testTask: async () => {
        // success
      },
    });

    const job1Id = enqueueJob(db, {
      type: "testTask",
      payload: { hello: "world" },
    });

    const result = await jobRunner.runOnce(new Date());
    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);

    const row = db.get<{ status: string }>(
      "SELECT status FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(row!.status).toBe("SUCCEEDED");
  });

  it("no handler for job type marks job as FAILED", async () => {
    db = await setupDb();

    const jobRunner = new JobRunner(db, {});

    const job1Id = enqueueJob(db, {
      type: "unknownType",
      payload: {},
    });

    const result = await jobRunner.runOnce(new Date());
    expect(result.claimed).toBe(1);
    expect(result.failed).toBe(1);

    const row = db.get<{ status: string }>(
      "SELECT status FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(row!.status).toBe("FAILED");
  });

  it("jobs are claimed in priority order", async () => {
    db = await setupDb();

    const executedOrder: string[] = [];

    const jobRunner = new JobRunner(db, {
      testTask: async (job) => {
        executedOrder.push(job.id);
      },
    });

    // Low priority first, then high
    const lowId = enqueueJob(db, {
      type: "testTask",
      payload: {},
      priority: 1,
    });
    const highId = enqueueJob(db, {
      type: "testTask",
      payload: {},
      priority: 10,
    });

    // runOnce claims one job per call – call twice
    const r1 = await jobRunner.runOnce(new Date());
    expect(r1.claimed).toBe(1);
    const r2 = await jobRunner.runOnce(new Date());
    expect(r2.claimed).toBe(1);

    // High priority should have been processed first
    expect(executedOrder[0]).toBe(highId);
    expect(executedOrder[1]).toBe(lowId);
  });

  it("dedupe key allows re-enqueue after job succeeds", async () => {
    db = await setupDb();

    const jobRunner = new JobRunner(db, {
      testTask: async () => {
        // success
      },
    });

    const id1 = enqueueJob(db, {
      type: "testTask",
      payload: {},
      dedupeKey: "re-usable-key",
    });

    // First run succeeds
    await jobRunner.runOnce(new Date());
    const row1 = db.get<{ status: string }>(
      "SELECT status FROM background_jobs WHERE id = $id",
      { id: id1 },
    );
    expect(row1!.status).toBe("SUCCEEDED");

    // Now we can enqueue again with the same dedupe key
    const id2 = enqueueJob(db, {
      type: "testTask",
      payload: {},
      dedupeKey: "re-usable-key",
    });
    expect(id2).not.toBe(id1);

    const allRows = db.all<{ id: string }>(
      "SELECT id FROM background_jobs WHERE dedupe_key = $dk",
      { dk: "re-usable-key" },
    );
    expect(allRows).toHaveLength(2);
  });
});
