import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { enqueueJob } from "../../../src/platform/jobs/job-repository.js";
import { JobRunner } from "../../../src/platform/jobs/job-runner.js";
import { BackgroundJobRegistry } from "../../../src/platform/jobs/background-job-registry.js";
import { randomUUID } from "node:crypto";

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

    // Оба вызова возвращают UUID, но строка должна быть только одна.
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

    const registry = new BackgroundJobRegistry();
    registry.register("testTask", async () => {
      throw new Error("transient failure");
    });

    const jobRunner = new JobRunner(db, registry);

    const job1Id = enqueueJob(db, {
      type: "testTask",
      payload: {},
    });

    const now = new Date();
    const result = await jobRunner.runOnce(now);

    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(0);
    // Повторная попытка не является окончательной ошибкой — учитываются только DEAD_LETTER / FAILED.
    expect(result.failed).toBe(0);

    const row = db.get<{ status: string; run_after: string; attempts: number }>(
      "SELECT status, run_after, attempts FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe("RETRY_WAIT");
    expect(row!.attempts).toBe(1);
    // run_after должен быть в будущем, минимум примерно через 54 секунды с учётом дрожания ±10%.
    const runAfter = new Date(row!.run_after);
    expect(runAfter.getTime()).toBeGreaterThan(now.getTime() + 53_000);
  });

  it("permanent error after max attempts goes to DEAD_LETTER", async () => {
    db = await setupDb();

    const registry = new BackgroundJobRegistry();
    registry.register("testTask", async () => {
      throw new Error("permanent failure");
    });

    const jobRunner = new JobRunner(db, registry);

    enqueueJob(db, {
      type: "testTask",
      payload: {},
      maxAttempts: 3,
    });

    // Выполняем три раза, каждый раз перемещая время за пределы backoff.
    // Расписание backoff: [60, 120, …] секунд.
    // Каждая итерация продвигает время на 300 s, что превышает предыдущую задержку.
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

    const registry = new BackgroundJobRegistry();
    registry.register("testTask", async () => {
      // успех
    });

    const jobRunner = new JobRunner(db, registry);

    const job1Id = enqueueJob(db, {
      type: "testTask",
      payload: {},
    });

    // Имитируем сбой: переводим задачу непосредственно в RUNNING с истёкшей арендой
    // (как если бы worker захватил её и завершился до окончания работы).
    const pastLeaseExpiry = new Date(Date.now() - 60_000).toISOString();
    db.run(
      `UPDATE background_jobs
       SET status = 'RUNNING', lease_owner = $owner, lease_expires_at = $lease_expires_at
       WHERE id = $id`,
      { owner: "dead-worker", lease_expires_at: pastLeaseExpiry, id: job1Id },
    );

    const stuck = db.get<{ status: string; lease_owner: string }>(
      "SELECT status, lease_owner FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(stuck!.status).toBe("RUNNING");
    expect(stuck!.lease_owner).toBe("dead-worker");

    // Следующий runOnce должен восстановить задачу с истёкшей арендой и выполнить её снова.
    const futureNow = new Date(Date.now() + 1_000);
    const result = await jobRunner.runOnce(futureNow);
    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);

    const afterSecond = db.get<{ status: string }>(
      "SELECT status FROM background_jobs WHERE id = $id",
      { id: job1Id },
    );
    expect(afterSecond!.status).toBe("SUCCEEDED");
  });

  it("runOnce returns 0 claimed when no jobs are runnable", async () => {
    db = await setupDb();

    const registry = new BackgroundJobRegistry();
    const jobRunner = new JobRunner(db, registry);

    const result = await jobRunner.runOnce(new Date());
    expect(result.claimed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("successful job is marked SUCCEEDED", async () => {
    db = await setupDb();

    const registry = new BackgroundJobRegistry();
    registry.register("testTask", async () => {
      // успех
    });

    const jobRunner = new JobRunner(db, registry);

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

    const registry = new BackgroundJobRegistry();
    const jobRunner = new JobRunner(db, registry);

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

    const registry = new BackgroundJobRegistry();
    registry.register("testTask", async (job) => {
      executedOrder.push(job.id);
    });

    const jobRunner = new JobRunner(db, registry);

    // Сначала низкий приоритет, затем высокий.
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

    // runOnce захватывает одну задачу за вызов — вызываем дважды.
    const r1 = await jobRunner.runOnce(new Date());
    expect(r1.claimed).toBe(1);
    const r2 = await jobRunner.runOnce(new Date());
    expect(r2.claimed).toBe(1);

    // Сначала должна быть обработана задача с высоким приоритетом.
    expect(executedOrder[0]).toBe(highId);
    expect(executedOrder[1]).toBe(lowId);
  });

  it("dedupe key allows re-enqueue after job succeeds", async () => {
    db = await setupDb();

    const registry = new BackgroundJobRegistry();
    registry.register("testTask", async () => {
      // успех
    });

    const jobRunner = new JobRunner(db, registry);

    const id1 = enqueueJob(db, {
      type: "testTask",
      payload: {},
      dedupeKey: "re-usable-key",
    });

    // Первый запуск успешен.
    await jobRunner.runOnce(new Date());
    const row1 = db.get<{ status: string }>(
      "SELECT status FROM background_jobs WHERE id = $id",
      { id: id1 },
    );
    expect(row1!.status).toBe("SUCCEEDED");

    // Теперь можно снова поставить задачу в очередь с тем же dedupe key.
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
