import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { WorkService } from "../../../src/modules/work/work-service.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";
import type { TaskContract } from "../../../src/modules/work/work-types.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migration003 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/003_work_control.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
];

function contract(goal: string): TaskContract {
  return {
    version: 1,
    goal,
    context: `Context for ${goal}`,
    requirements: ["req-1"],
    acceptanceCriteria: ["ac-1"],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: ["done-1"],
  };
}

describe("ApprovalService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let work: WorkService;
  let approvals: ApprovalService;
  const projectId = randomUUID();

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
    tmpDir = await mkdtemp(join(tmpdir(), "orch-approval-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setupWithProject(): Promise<void> {
    db = await setupDb();
    db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.run(
        "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)",
        {
          id: projectId,
          name: "test-project",
          display_name: "Test Project",
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
    });
    work = new WorkService(db);
    approvals = new ApprovalService(db);
  }

  it("requests an approval and sets status to PENDING", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    expect(approval.status).toBe("PENDING");
    expect(approval.type).toBe("FINAL_MERGE");
    expect(approval.subjectId).toBe(task.id);
    expect(approval.subjectType).toBe("TASK");
    expect(approval.requestedBy).toBe("user-1");
  });

  it("approves a pending approval", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    const resolved = approvals.approve(approval.id, "reviewer-1", "Looks good");
    expect(resolved.status).toBe("APPROVED");
    expect(resolved.resolvedBy).toBe("reviewer-1");
    expect(resolved.resolutionNote).toBe("Looks good");
    expect(resolved.resolvedAt).toBeDefined();
  });

  it("rejects a pending approval", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    const resolved = approvals.reject(approval.id, "reviewer-1", "Needs work");
    expect(resolved.status).toBe("REJECTED");
    expect(resolved.resolvedBy).toBe("reviewer-1");
    expect(resolved.resolutionNote).toBe("Needs work");
  });

  it("cancels a pending approval", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    const cancelled = approvals.cancel(approval.id, "user-1");
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("throws when approving an already resolved approval", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    approvals.approve(approval.id, "reviewer-1");
    expect(() => approvals.approve(approval.id, "reviewer-2")).toThrow(/already resolved/i);
  });

  it("throws when rejecting an already resolved approval", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    approvals.reject(approval.id, "reviewer-1", "No");
    expect(() => approvals.reject(approval.id, "reviewer-2", "Also no")).toThrow(/already resolved/i);
  });

  it("throws when cancelling an already resolved approval", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    approvals.approve(approval.id, "reviewer-1");
    expect(() => approvals.cancel(approval.id, "user-1")).toThrow(/already resolved/i);
  });

  it("appends ApprovalRequested event to outbox", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    const events = db!.all<{ type: string }>(
      "SELECT type FROM outbox_events WHERE aggregate_id = $id",
      { id: task.id },
    );
    expect(events.some((e) => e.type === "ApprovalRequested")).toBe(true);
  });

  it("appends ApprovalApproved event to outbox", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    approvals.approve(approval.id, "reviewer-1");
    const events = db!.all<{ type: string }>(
      "SELECT type FROM outbox_events WHERE aggregate_id = $id",
      { id: task.id },
    );
    expect(events.some((e) => e.type === "ApprovalApproved")).toBe(true);
  });

  it("appends ApprovalRejected event to outbox", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    approvals.reject(approval.id, "reviewer-1", "Nope");
    const events = db!.all<{ type: string }>(
      "SELECT type FROM outbox_events WHERE aggregate_id = $id",
      { id: task.id },
    );
    expect(events.some((e) => e.type === "ApprovalRejected")).toBe(true);
  });

  it("lists pending approvals for a subject", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    const pending = approvals.listPendingBySubject(task.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("PENDING");
  });

  it("does not list resolved approvals as pending", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const approval = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    approvals.approve(approval.id, "reviewer-1");
    const pending = approvals.listPendingBySubject(task.id);
    expect(pending).toHaveLength(0);
  });

  it("gets approval by id", async () => {
    await setupWithProject();
    const task = work.createStandaloneTask(projectId, contract("task-a"));
    const created = approvals.request({
      type: "FINAL_MERGE",
      subjectId: task.id,
      subjectType: "TASK",
      requestedBy: "user-1",
    });
    const fetched = approvals.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it("returns undefined for non-existent approval", async () => {
    await setupWithProject();
    const fetched = approvals.getById(randomUUID());
    expect(fetched).toBeUndefined();
  });
});
