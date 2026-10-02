import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

describe("PlanningRequest linkage migration", () => {
  it("upgrades a legacy request to durable lifecycle fields before newer migrations", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const migrations = loadTestMigrations();
      runMigrations(db, migrations.filter((migration) => migration.version <= 30));
      const now = new Date().toISOString();
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES('project-1','sample','Sample','ACTIVE',$now,$now)", { now });
      db.run("INSERT INTO planning_requests(id,project_id,request,requested_by,created_at) VALUES('request-1','project-1','Build a feature','local-user',$now)", { now });

      runMigrations(db, migrations);
      const columns = db.all<{ name: string }>("PRAGMA table_info(planning_requests)").map(({ name }) => name);
      expect(columns).toEqual(expect.arrayContaining(["status", "coordinator_run_id", "updated_at", "failure_code"]));
      expect(db.get<{ status: string; updated_at: string }>("SELECT status,updated_at FROM planning_requests WHERE id='request-1'"))
        .toEqual({ status: "RECEIVED", updated_at: now });
      // Include all forward migrations after the legacy v30 fixture, including Plan20's v39 Run session capture state.
      expect(db.all<{ version: number }>("SELECT version FROM schema_migrations WHERE version>=31 ORDER BY version").map(({ version }) => version))
        .toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39]);
    } finally {
      db.close();
    }
  });
});
