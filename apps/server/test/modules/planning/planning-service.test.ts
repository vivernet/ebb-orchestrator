import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { DEFAULT_PLANNING_APPROVAL_POLICY } from "../../../src/modules/planning/planning-policy.js";

describe("PlanningService", () => {
  let db: Database | undefined;
  let dir = "";
  afterEach(async () => { db?.close(); db = undefined; if (dir) await rm(dir, { recursive: true, force: true }); });

  async function setup(): Promise<{ service: PlanningService; projectId: string }> {
    dir = await mkdtemp(join(tmpdir(), "orch-planning-test-"));
    db = createSqliteDatabase(join(dir, "test.db"));
    const names = ["001_system", "002_work_domain", "003_work_control", "010_planning"];
    const migrations: Migration[] = names.map((name, i) => ({ version: i === 3 ? 10 : i + 1, name, sql: readFileSync(join(import.meta.dirname, `../../../src/platform/database/migrations/${name}.sql`), "utf8") }));
    runMigrations(db, migrations);
    const projectId = randomUUID();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now: new Date().toISOString() });
    return { service: new PlanningService(db), projectId };
  }

  it("uses the required approval defaults", () => {
    expect(DEFAULT_PLANNING_APPROVAL_POLICY).toEqual({ standalone_task: false, multi_task_plan: true, epic: true, architecture_change: true });
  });

  it("materializes a simple standalone task without approval", async () => {
    const { service, projectId } = await setup();
    const plan = service.preparePlan({ projectId, tasks: [{ ref: "task_1", title: "Small task", acceptanceCriteria: ["works"], role: "developer", workflow: "standard" }] });
    expect(plan.status).toBe("APPROVED");
    expect(plan.approvalRequired).toBe(false);
    expect(plan.temporaryIdMap.task_1).toBe("TASK-1");
  });

  it("keeps an Epic pending and materializes all refs atomically on approval", async () => {
    const { service, projectId } = await setup();
    const plan = service.preparePlan({ projectId, epic: { title: "Feature" }, tasks: [
      { ref: "task_1", title: "Foundation", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
      { ref: "task_2", title: "Follow-up", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_1"] },
    ] });
    expect(plan.status).toBe("PENDING");
    const approved = service.approvePlan(plan.id, "user");
    expect(approved.temporaryIdMap).toEqual({ task_1: "TASK-1", task_2: "TASK-2" });
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM dependencies")?.count).toBe(1);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM outbox_events WHERE type='PlanApproved'")?.count).toBe(1);

    const tasks = db?.all<{ id: string; display_id: string; contract_json: string }>("SELECT id, display_id, contract_json FROM tasks ORDER BY display_id");
    expect(JSON.parse(tasks![1]!.contract_json).dependencies).toEqual([tasks![0]!.id]);
    const dependency = db?.get<{ task_id: string; depends_on_task_id: string }>("SELECT task_id, depends_on_task_id FROM dependencies");
    expect(dependency).toEqual({ task_id: tasks![1]!.id, depends_on_task_id: tasks![0]!.id });
    const event = db?.get<{ aggregate_id: string; payload_json: string }>("SELECT aggregate_id, payload_json FROM outbox_events WHERE type='DependencyCreated'");
    expect(event?.aggregate_id).toBe(tasks![1]!.id);
    expect(JSON.parse(event!.payload_json)).toEqual({ taskId: tasks![1]!.id, dependsOnTaskId: tasks![0]!.id });
  });

  it("rolls back work and outbox state when materialization fails", async () => {
    const { service, projectId } = await setup();
    const plan = service.preparePlan({ projectId, epic: { title: "Feature" }, tasks: [
      { ref: "task_1", title: "Foundation", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
      { ref: "task_2", title: "Follow-up", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_1"] },
    ] });
    db?.exec("CREATE TRIGGER fail_task_materialization BEFORE INSERT ON tasks WHEN NEW.title = 'Follow-up' BEGIN SELECT RAISE(ABORT, 'forced materialization failure'); END");

    expect(() => service.approvePlan(plan.id, "user")).toThrow(/forced materialization failure/);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM dependencies")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM outbox_events")?.count).toBe(0);
    expect(db?.get<{ status: string }>("SELECT status FROM planning_plans WHERE id=$id", { id: plan.id })?.status).toBe("PENDING");
  });

  it("rejects invalid plans before creating any work", async () => {
    const { service, projectId } = await setup();
    expect(() => service.preparePlan({ projectId, tasks: [
      { ref: "task_1", title: "bad", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_2"] },
      { ref: "task_2", title: "bad", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_1"] },
    ], epic: { title: "bad" } })).toThrow(/cyclic/i);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(0);
  });
});
