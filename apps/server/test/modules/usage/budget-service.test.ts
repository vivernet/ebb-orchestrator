import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { BudgetService } from "../../../src/modules/usage/budget-service.js";

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
const migration005 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/005_scheduler.sql"),
  "utf-8",
);
const migration017 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/017_usage.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
  { version: 5, name: "005_scheduler", sql: migration005 },
  { version: 17, name: "017_usage", sql: migration017 },
];

describe("BudgetService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let budgetService: BudgetService;
  let projectId: string;

  beforeEach(() => {
    tmpDir = "";
    projectId = randomUUID();
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-budget-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setup(budgetLimit?: number): Promise<void> {
    db = await setupDb();
    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
         VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)`,
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
    if (budgetLimit !== undefined) {
      const now2 = new Date().toISOString();
      db.run(
        "INSERT INTO budget_configs (id, scope, scope_id, limit_cost, soft_limit_cost, policy, created_at, updated_at) VALUES ($id, 'project', $scopeId, $limit, $softLimit, 'hard', $now, $now)",
        { id: randomUUID(), scopeId: projectId, limit: budgetLimit, softLimit: budgetLimit * 0.8, now: now2 },
      );
    }
    budgetService = new BudgetService(db);
  }

  // ─── Parallel reservation tests ─────────────────────────────────────────

  it("allows reservations within budget", async () => {
    await setup(10);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");
    expect(d1.reservationId).toBeDefined();
  });

  it("denies reservation when hard budget exceeded", async () => {
    await setup(5);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");
    const d2 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d2.decision).toBe("ALLOW");
    // Third: 2+2+2=6 > 5
    const d3 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d3.decision).toBe("DENY");
  });

  it("three concurrent $2 reservations on $5 budget: only two succeed", async () => {
    await setup(5);
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        budgetService.reserve({
          projectId,
          estimateCost: 2,
          role: "developer",
          model: "default",
          triggerReason: "DEVELOPMENT",
        }),
      );
    }
    const allowed = results.filter((r) => r.decision === "ALLOW");
    const denied = results.filter((r) => r.decision !== "ALLOW");
    expect(allowed.length).toBe(2);
    expect(denied.length).toBe(1);
    expect(denied[0]!.decision).toBe("DENY");
  });

  it("returns ASK on soft limit breach", async () => {
    await setup(10);
    db!.run(
      "UPDATE budget_configs SET soft_limit_cost = $softLimit WHERE scope = 'project' AND scope_id = $scopeId",
      { softLimit: 3, scopeId: projectId },
    );
    budgetService = new BudgetService(db!);

    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");
    // $2 + $2 = $4 > soft limit $3
    const d2 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d2.decision).toBe("ASK");
  });

  // ─── Hierarchical budget resolution ─────────────────────────────────────

  it("uses most restrictive budget across global/project/epic/task scopes", async () => {
    await setup(100);
    const epicId = randomUUID();
    const taskId = randomUUID();

    const now3 = new Date().toISOString();
    db!.run(
      "INSERT INTO budget_configs (id, scope, scope_id, limit_cost, soft_limit_cost, policy, created_at, updated_at) VALUES ($id, 'global', 'global', $limit, $soft, 'hard', $now, $now)",
      { id: randomUUID(), limit: 20, soft: 16, now: now3 },
    );
    db!.run(
      "INSERT INTO budget_configs (id, scope, scope_id, limit_cost, soft_limit_cost, policy, created_at, updated_at) VALUES ($id, 'epic', $scopeId, $limit, $soft, 'hard', $now, $now)",
      { id: randomUUID(), scopeId: epicId, limit: 50, soft: 40, now: now3 },
    );
    db!.run(
      "INSERT INTO budget_configs (id, scope, scope_id, limit_cost, soft_limit_cost, policy, created_at, updated_at) VALUES ($id, 'task', $scopeId, $limit, $soft, 'hard', $now, $now)",
      { id: randomUUID(), scopeId: taskId, limit: 10, soft: 8, now: now3 },
    );

    budgetService = new BudgetService(db!);

    const d1 = budgetService.reserve({
      projectId,
      epicId,
      taskId,
      estimateCost: 5,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");

    const d2 = budgetService.reserve({
      projectId,
      epicId,
      taskId,
      estimateCost: 6,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d2.decision).toBe("DENY");
  });

  it("allows when no budget config exists", async () => {
    await setup();
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 999,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");
  });

  // ─── Reconcile tests ────────────────────────────────────────────────────

  it("reconciles reservation with actual cost", async () => {
    await setup(10);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 3,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");
    expect(d1.reservationId).toBeDefined();

    const recResult = budgetService.reconcile(d1.reservationId!, 2.5);
    expect(recResult.status).toBe("RECONCILED");
    expect(recResult.actualCost).toBe(2.5);

    const config = db!.get<{ spent_cost: number; reserved_cost: number }>(
      "SELECT spent_cost, reserved_cost FROM budget_configs WHERE scope = 'project' AND scope_id = $scopeId",
      { scopeId: projectId },
    );
    expect(config?.spent_cost).toBe(2.5);
    expect(config?.reserved_cost).toBe(0);
  });

  it("reconciles with zero actual cost for failed runs", async () => {
    await setup(10);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 3,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");

    const recResult = budgetService.reconcile(d1.reservationId!, 0);
    expect(recResult.status).toBe("RECONCILED");
    expect(recResult.actualCost).toBe(0);
  });

  it("reconciles across epic and task scope budget configs", async () => {
    await setup(100);
    const epicId = randomUUID();
    const taskId = randomUUID();
    const now3 = new Date().toISOString();

    db!.run(
      "INSERT INTO budget_configs (id, scope, scope_id, limit_cost, soft_limit_cost, policy, created_at, updated_at) VALUES ($id, 'epic', $scopeId, $limit, $soft, 'hard', $now, $now)",
      { id: randomUUID(), scopeId: epicId, limit: 50, soft: 40, now: now3 },
    );
    db!.run(
      "INSERT INTO budget_configs (id, scope, scope_id, limit_cost, soft_limit_cost, policy, created_at, updated_at) VALUES ($id, 'task', $scopeId, $limit, $soft, 'hard', $now, $now)",
      { id: randomUUID(), scopeId: taskId, limit: 10, soft: 8, now: now3 },
    );

    budgetService = new BudgetService(db!);

    const d1 = budgetService.reserve({
      projectId,
      epicId,
      taskId,
      estimateCost: 3,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");

    // Verify reserved_cost was incremented on all scopes
    const epicConfig = db!.get<{ reserved_cost: number }>(
      "SELECT reserved_cost FROM budget_configs WHERE scope = 'epic' AND scope_id = $scopeId",
      { scopeId: epicId },
    );
    expect(epicConfig?.reserved_cost).toBe(3);
    const taskConfig = db!.get<{ reserved_cost: number }>(
      "SELECT reserved_cost FROM budget_configs WHERE scope = 'task' AND scope_id = $scopeId",
      { scopeId: taskId },
    );
    expect(taskConfig?.reserved_cost).toBe(3);

    // Reconcile with actual cost
    const recResult = budgetService.reconcile(d1.reservationId!, 2.5);
    expect(recResult.status).toBe("RECONCILED");

    // Verify reserved_cost decremented and spent_cost incremented on all scopes
    const epicAfter = db!.get<{ reserved_cost: number; spent_cost: number }>(
      "SELECT reserved_cost, spent_cost FROM budget_configs WHERE scope = 'epic' AND scope_id = $scopeId",
      { scopeId: epicId },
    );
    expect(epicAfter?.reserved_cost).toBe(0);
    expect(epicAfter?.spent_cost).toBe(2.5);
    const taskAfter = db!.get<{ reserved_cost: number; spent_cost: number }>(
      "SELECT reserved_cost, spent_cost FROM budget_configs WHERE scope = 'task' AND scope_id = $scopeId",
      { scopeId: taskId },
    );
    expect(taskAfter?.reserved_cost).toBe(0);
    expect(taskAfter?.spent_cost).toBe(2.5);
  });

  it("returns ALREADY_RECONCILED for unknown reservation", async () => {
    await setup(10);
    const recResult = budgetService.reconcile("non-existent-id", 1);
    expect(recResult.status).toBe("ALREADY_RECONCILED");
  });

  it("returns ALREADY_RECONCILED for double reconcile", async () => {
    await setup(10);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 3,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    budgetService.reconcile(d1.reservationId!, 2);
    const rec2 = budgetService.reconcile(d1.reservationId!, 3);
    expect(rec2.status).toBe("ALREADY_RECONCILED");
    const config = db!.get<{ spent_cost: number }>(
      "SELECT spent_cost FROM budget_configs WHERE scope = 'project' AND scope_id = $scopeId",
      { scopeId: projectId },
    );
    expect(config?.spent_cost).toBe(2);
  });

  // ─── No oversubscription race ───────────────────────────────────────────

  it("prevents oversubscription under concurrent access", async () => {
    await setup(5);
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        budgetService.reserve({
          projectId,
          estimateCost: 2,
          role: "developer",
          model: "default",
          triggerReason: "DEVELOPMENT",
        }),
      );
    }
    const allowed = results.filter((r) => r.decision === "ALLOW");
    expect(allowed.length).toBe(2);
    const config = db!.get<{ reserved_cost: number }>(
      "SELECT reserved_cost FROM budget_configs WHERE scope = 'project' AND scope_id = $scopeId",
      { scopeId: projectId },
    );
    expect(config!.reserved_cost).toBeLessThanOrEqual(5);
  });

  // ─── Historical p90 estimation ──────────────────────────────────────────

  it("estimates cost from historical p90 by role/model", async () => {
    await setup(50);
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      db!.run(
        "INSERT INTO usage_records (id, run_id, project_id, role, model, trigger_reason, input_tokens, output_tokens, total_tokens, estimated_cost, actual_cost, created_at) VALUES ($id, $runId, $projectId, $role, $model, $reason, $in, $out, $total, $est, $actual, $at)",
        {
          id: randomUUID(),
          runId: randomUUID(),
          projectId,
          role: "developer",
          model: "default",
          reason: "DEVELOPMENT",
          in: 1000,
          out: 500,
          total: 1500,
          est: i < 8 ? 1 : 5, // 8 at $1, 2 at $5
          actual: i < 8 ? 1 : 5,
          at: now,
        },
      );
    }

    budgetService = new BudgetService(db!);
    const estimate = budgetService.estimateCost(projectId, "developer", "default");
    // p90 of [1,1,1,1,1,1,1,1,5,5] → 10 values, p90 index = ceil(10*0.9)-1 = 8 → value = 5
    // With 1.25 safety floor: 5 * 1.25 = 6.25
    expect(estimate).toBe(6.25);
  });

  it("uses default floor estimate when no history exists", async () => {
    await setup(50);
    const estimate = budgetService.estimateCost(projectId, "developer", "default");
    expect(estimate).toBe(1); // default floor
  });

  // ─── Trigger reason persistence ─────────────────────────────────────────

  it("persists trigger reason on reservation", async () => {
    await setup(10);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "RECOVERY",
    });
    expect(d1.decision).toBe("ALLOW");

    const row = db!.get<{ trigger_reason: string }>(
      "SELECT trigger_reason FROM budget_reservations WHERE id = $id",
      { id: d1.reservationId! },
    );
    expect(row?.trigger_reason).toBe("RECOVERY");
  });

  it("persists rework category on reservation", async () => {
    await setup(10);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 2,
      role: "developer",
      model: "default",
      triggerReason: "QA_REWORK",
      reworkCategory: "defect-fix",
    });
    expect(d1.decision).toBe("ALLOW");

    const row = db!.get<{ rework_category: string | null }>(
      "SELECT rework_category FROM budget_reservations WHERE id = $id",
      { id: d1.reservationId! },
    );
    expect(row?.rework_category).toBe("defect-fix");
  });

  // ─── UsageRecord creation ───────────────────────────────────────────────

  it("creates usage record on reconciliation", async () => {
    await setup(10);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 3,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });

    const recResult = budgetService.reconcile(d1.reservationId!, 2.5, {
      inputTokens: 1000,
      cachedTokens: 200,
      outputTokens: 500,
    });
    expect(recResult.status).toBe("RECONCILED");

    const record = db!.get<{ actual_cost: number; input_tokens: number }>(
      "SELECT actual_cost, input_tokens FROM usage_records WHERE reservation_id = $id",
      { id: d1.reservationId! },
    );
    expect(record).toBeDefined();
    expect(record?.actual_cost).toBe(2.5);
    expect(record?.input_tokens).toBe(1000);
  });

  // ─── Cleanup stale reservations ─────────────────────────────────────────

  it("cleans up stale reservations for dead runs", async () => {
    await setup(20);
    // Create two reservations
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 5,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    const d2 = budgetService.reserve({
      projectId,
      estimateCost: 5,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");
    expect(d2.decision).toBe("ALLOW");

    // d1 is active, d2 is stale (dead run)
    const result = budgetService.cleanupStaleReservations([d1.reservationId!]);
    expect(result.released).toBe(1);

    // d1 should still be RESERVED
    const r1 = db!.get<{ status: string }>(
      "SELECT status FROM budget_reservations WHERE id = $id",
      { id: d1.reservationId! },
    );
    expect(r1?.status).toBe("RESERVED");

    // d2 should be RELEASED
    const r2 = db!.get<{ status: string }>(
      "SELECT status FROM budget_reservations WHERE id = $id",
      { id: d2.reservationId! },
    );
    expect(r2?.status).toBe("RELEASED");

    // d2's estimate cost should be decremented from reserved_cost
    const config = db!.get<{ reserved_cost: number }>(
      "SELECT reserved_cost FROM budget_configs WHERE scope = 'project' AND scope_id = $scopeId",
      { scopeId: projectId },
    );
    expect(config?.reserved_cost).toBe(5); // only d1's 5 remains
  });

  it("releases all reservations when active set is empty", async () => {
    await setup(20);
    const d1 = budgetService.reserve({
      projectId,
      estimateCost: 3,
      role: "developer",
      model: "default",
      triggerReason: "DEVELOPMENT",
    });
    expect(d1.decision).toBe("ALLOW");

    const result = budgetService.cleanupStaleReservations([]);
    expect(result.released).toBe(1);

    const r1 = db!.get<{ status: string }>(
      "SELECT status FROM budget_reservations WHERE id = $id",
      { id: d1.reservationId! },
    );
    expect(r1?.status).toBe("RELEASED");

    const config = db!.get<{ reserved_cost: number }>(
      "SELECT reserved_cost FROM budget_configs WHERE scope = 'project' AND scope_id = $scopeId",
      { scopeId: projectId },
    );
    expect(config?.reserved_cost).toBe(0);
  });
});
