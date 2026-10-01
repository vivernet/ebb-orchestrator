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

describe("usage route", () => {
  it("aggregates authoritative token and actual-cost columns with an empty budget projection", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const now = new Date().toISOString();
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
    const response = await app.inject({ method: "GET", url: "/api/v1/usage" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      global: {
        inputTokens: 12,
        cachedTokens: 15,
        outputTokens: 18,
        totalTokens: 45,
        tokens: 45,
        cost: 4.25,
        aggregation: "all_records",
      },
      project: {
        inputTokens: 12,
        cachedTokens: 15,
        outputTokens: 18,
        totalTokens: 45,
        tokens: 45,
        cost: 4.25,
        aggregation: "records_with_project_id",
      },
      epic: {
        inputTokens: 11,
        cachedTokens: 13,
        outputTokens: 15,
        totalTokens: 39,
        tokens: 39,
        cost: 3.75,
        aggregation: "records_with_epic_id",
      },
      task: {
        inputTokens: 7,
        cachedTokens: 8,
        outputTokens: 9,
        totalTokens: 24,
        tokens: 24,
        cost: 2.5,
        aggregation: "records_with_task_id",
      },
      budget: {
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
      },
    });

    await app.close();
    db.close();
  });

  it("projects hierarchical limits and only currently RESERVED entries without changing budget state", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const now = new Date().toISOString();
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

    const app = Fastify();
    await usageRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/usage" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.budget.configurations).toEqual([
      { scope: "global", scopeId: "global", limitCost: 100, softLimitCost: 75, policy: "hard", spentCost: 10, reservedCost: 5 },
      { scope: "project", scopeId: "project-1", limitCost: 80, softLimitCost: 60, policy: "soft", spentCost: 20, reservedCost: 3 },
      { scope: "epic", scopeId: "epic-1", limitCost: 30, softLimitCost: 25, policy: "hard", spentCost: 4, reservedCost: 2 },
      { scope: "task", scopeId: "task-1", limitCost: 40, softLimitCost: 35, policy: "soft", spentCost: 5, reservedCost: 1 },
    ]);
    expect(body.budget.contexts).toEqual([
      expect.objectContaining({ scope: "global", effectiveLimit: body.budget.configurations[0] }),
      expect.objectContaining({ scope: "project", scopeId: "project-1", effectiveLimit: body.budget.configurations[1] }),
      expect.objectContaining({ scope: "epic", scopeId: "epic-1", effectiveLimit: body.budget.configurations[2] }),
      expect.objectContaining({ scope: "task", scopeId: "task-1", effectiveLimit: body.budget.configurations[2] }),
    ]);
    expect(body.budget.contexts[3].applicableLimits.map((limit: { scope: string }) => limit.scope)).toEqual(["global", "project", "epic", "task"]);
    expect(body.budget.activeReservations).toEqual([
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
});
