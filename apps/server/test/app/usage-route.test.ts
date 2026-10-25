import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { usageRoutes } from "../../src/app/routes/usage.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => ({
    version: Number(/^([0-9]+)/.exec(file)?.[1]),
    name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""),
    sql: readFileSync(join(migrationDir, file), "utf8"),
  }));

const FROM = "2026-10-21T00:00:00.000Z";
const TO = "2026-10-21T23:59:59.999Z";

function windowUrl(from = FROM, to = TO, granularity = "day"): string {
  return `/api/v1/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=${granularity}`;
}

describe("usage route", () => {
  it("aggregates windows token and actual-cost columns with an empty budget projection", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const now = FROM;
    db.run(
      "INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)",
      { now },
    );
    db.run(
      `INSERT INTO usage_records
        (id,project_id,epic_id,task_id,input_tokens,cached_tokens,output_tokens,total_tokens,actual_cost,role,model,trigger_reason,created_at)
       VALUES
        ('usage-1','project-1',NULL,NULL,1,2,3,6,0.5,'developer','model','DEVELOPMENT',$now),
        ('usage-2','project-1','epic-1',NULL,4,5,6,15,1.25,'reviewer','model','CODE_REVIEW',$now),
        ('usage-3','project-1','epic-1','task-1',7,8,9,24,2.5,'qa','model','QA_VALIDATION',$now)`,
      { now },
    );

    const app = Fastify();
    await usageRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: windowUrl() });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.window).toEqual({ from: FROM, to: TO, granularity: "day" });
    expect(body.summary).toEqual({
      inputTokens: 12,
      cachedTokens: 15,
      outputTokens: 18,
      totalTokens: 45,
      cost: 4.25,
    });
    expect(body.dailySeries).toEqual([
      { date: "2026-10-21", usage: { inputTokens: 12, cachedTokens: 15, outputTokens: 18, totalTokens: 45, cost: 4.25 } },
    ]);
    expect(body.budgets).toEqual({
      configurations: [],
      contexts: [
        {
          scope: "global",
          scopeId: "global",
          projectId: null,
          epicId: null,
          taskId: null,
          applicableLimits: [],
          effectiveLimit: null,
        },
        {
          scope: "project",
          scopeId: "project-1",
          projectId: "project-1",
          epicId: null,
          taskId: null,
          applicableLimits: [],
          effectiveLimit: null,
        },
      ],
      activeReservations: [],
    });
    expect(body.efficiency.deterministicCheckCount).toEqual({ availability: "unavailable", reason: "NO_DURABLE_CHECK_EXECUTION_SOURCE" });
    expect(body.anomaly).toEqual({ availability: "unavailable", reason: "NO_APPROVED_POLICY" });
    expect(body.taskRecoveryShare).toEqual({ availability: "unavailable", reason: "NO_APPROVED_POLICY" });

    await app.close();
    db.close();
  });

  it("projects hierarchical limits and only currently RESERVED entries without changing budget state", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const now = FROM;
    db.run(
      "INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)",
      { now },
    );
    db.run(
      "INSERT INTO epics (id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('epic-1','project-1','E1','Epic 1','OPEN','{}',$now,$now)",
      { now },
    );
    db.run(
      "INSERT INTO tasks (id,project_id,epic_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('task-1','project-1','epic-1','T1','Task 1','READY','{}',$now,$now)",
      { now },
    );
    const configs = [
      ["global", "global", 100, 75, "hard", 10, 5],
      ["project", "project-1", 80, 60, "soft", 20, 3],
      ["epic", "epic-1", 30, 25, "hard", 4, 2],
      ["task", "task-1", 40, 35, "soft", 5, 1],
    ] as const;
    configs.forEach(([scope, scopeId, limit, softLimit, policy, spent, reserved], index) => {
      db.run(
        `INSERT INTO budget_configs (id,scope,scope_id,limit_cost,soft_limit_cost,policy,spent_cost,reserved_cost,created_at,updated_at)
         VALUES ($id,$scope,$scopeId,$limit,$softLimit,$policy,$spent,$reserved,$now,$now)`,
        { id: `config-${index}`, scope, scopeId, limit, softLimit, policy, spent, reserved, now },
      );
    });
    db.run(
      `INSERT INTO budget_reservations (id,project_id,epic_id,task_id,estimate_cost,status,role,model,trigger_reason,created_at)
       VALUES ('reservation-active','project-1','epic-1','task-1',1.5,'RESERVED','developer','model-x','DEVELOPMENT',$now),
              ('reservation-done','project-1','epic-1','task-1',2,'RECONCILED','reviewer','model-y','CODE_REVIEW',$now)`,
      { now },
    );
    db.run(
      `INSERT INTO usage_records
        (id,project_id,epic_id,task_id,input_tokens,cached_tokens,output_tokens,total_tokens,actual_cost,role,model,trigger_reason,created_at)
       VALUES ('usage-1','project-1','epic-1','task-1',10,5,7,22,0.75,'developer','model-x','DEVELOPMENT',$now)`,
      { now },
    );

    const app = Fastify();
    await usageRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: windowUrl() });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.summary).toEqual({ inputTokens: 10, cachedTokens: 5, outputTokens: 7, totalTokens: 22, cost: 0.75 });
    expect(body.budgets.configurations).toEqual([
      { scope: "global", scopeId: "global", limitCost: 100, softLimitCost: 75, policy: "hard", spentCost: 10, reservedCost: 5 },
      { scope: "project", scopeId: "project-1", limitCost: 80, softLimitCost: 60, policy: "soft", spentCost: 20, reservedCost: 3 },
      { scope: "epic", scopeId: "epic-1", limitCost: 30, softLimitCost: 25, policy: "hard", spentCost: 4, reservedCost: 2 },
      { scope: "task", scopeId: "task-1", limitCost: 40, softLimitCost: 35, policy: "soft", spentCost: 5, reservedCost: 1 },
    ]);
    expect(body.budgets.contexts).toEqual([
      expect.objectContaining({ scope: "global", effectiveLimit: body.budgets.configurations[0] }),
      expect.objectContaining({ scope: "project", scopeId: "project-1", effectiveLimit: body.budgets.configurations[1] }),
      expect.objectContaining({ scope: "epic", scopeId: "epic-1", effectiveLimit: body.budgets.configurations[2] }),
      expect.objectContaining({ scope: "task", scopeId: "task-1", effectiveLimit: body.budgets.configurations[2] }),
    ]);
    expect(body.budgets.contexts[3].applicableLimits.map((limit: { scope: string }) => limit.scope)).toEqual(["global", "project", "epic", "task"]);
    expect(body.budgets.activeReservations).toEqual([
      {
        id: "reservation-active",
        projectId: "project-1",
        epicId: "epic-1",
        taskId: "task-1",
        estimateCost: 1.5,
        status: "RESERVED",
        role: "developer",
        model: "model-x",
        triggerReason: "DEVELOPMENT",
        reworkCategory: null,
        createdAt: now,
      },
    ]);
    expect(db.all<{ id: string; status: string }>("SELECT id,status FROM budget_reservations ORDER BY id")).toEqual([
      { id: "reservation-active", status: "RESERVED" },
      { id: "reservation-done", status: "RECONCILED" },
    ]);

    await app.close();
    db.close();
  });

  it("rejects malformed or missing window parameters", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const app = Fastify();
    await usageRoutes(app, { db });

    const cases = [
      "/api/v1/usage",
      "/api/v1/usage?from=2026-10-21T00:00:00.000Z&to=2026-10-21T23:59:59.999Z",
      "/api/v1/usage?from=2026-10-21T00:00:00.000Z&granularity=day",
      windowUrl("not-a-timestamp", TO),
      windowUrl(TO, FROM),
      windowUrl(FROM, TO, "week"),
    ] as const;
    for (const url of cases) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
    }

    await app.close();
    db.close();
  });
});
