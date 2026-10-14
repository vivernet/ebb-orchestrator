import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { SchedulerRunRequestRepository } from "../../../src/modules/scheduler/scheduler-run-request-repository.js";

describe("SchedulerRunRequestRepository", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let repository: SchedulerRunRequestRepository;
  let taskId: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-run-request-repository-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    taskId = randomUUID();
    const now = "2026-10-14T00:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'Project','Project',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId, now });
    repository = new SchedulerRunRequestRepository(db, () => new Date(now));
  }

  it("deduplicates identical payloads across status and rejects key reuse with changed payload", async () => {
    await setup();
    const input = { taskId, idempotencyKey: "client-key", role: "developer", model: "gpt-default", originType: "TASK_API" as const, originId: "dispatch-1" };
    const first = repository.enqueue(input);
    const retry = repository.enqueue(input);
    expect(retry).toEqual(first);

    db!.run("UPDATE scheduler_run_requests SET status='FAILED',failure_code='RUN_FAILED',updated_at='2026-10-14T00:01:00.000Z' WHERE id=$id", { id: first.id });
    expect(repository.enqueue(input)).toMatchObject({ id: first.id, status: "FAILED" });
    expect(() => repository.enqueue({ ...input, model: "changed-model" })).toThrowError("RUN_REQUEST_IDEMPOTENCY_CONFLICT");
  });

  it("rejects a second active request for the same Task and reads the durable request by identity", async () => {
    await setup();
    const first = repository.enqueue({ taskId, idempotencyKey: "key-1", role: "developer", model: "default", originType: "TASK_API", originId: "dispatch-1" });
    expect(() => repository.enqueue({ taskId, idempotencyKey: "key-2", role: "reviewer", model: "default", originType: "TASK_API", originId: "dispatch-2" }))
      .toThrowError("RUN_REQUEST_ALREADY_PENDING");
    expect(repository.get(taskId, first.id)).toEqual(first);
    expect(repository.get(randomUUID(), first.id)).toBeUndefined();
  });
});
