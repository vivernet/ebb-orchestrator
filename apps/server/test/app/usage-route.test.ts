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
  it("aggregates authoritative token and actual-cost columns without scoped-budget claims", async () => {
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
      effectiveLimit: "global",
    });

    await app.close();
    db.close();
  });
});
