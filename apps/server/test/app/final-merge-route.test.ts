import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => ({
  version: Number(/^([0-9]+)/.exec(file)?.[1]),
  name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""),
  sql: readFileSync(join(migrationDir, file), "utf8"),
}));

function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)", { now });
  db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('epic-1','project-1','E-1','Epic','IN_PROGRESS','{}',$now,$now)", { now });
  db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,resolution_note,created_at,resolved_at) VALUES ('onboarding-approval','WORKFLOW_CHANGE','project-1','PROJECT','APPROVED','local-user','local-user',NULL,$now,$now)", { now });
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES ('project-1','C:\\authoritative\\repo','{}','{}','ACTIVE','onboarding-approval',$now,$now,$now)", { now });
  db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,resolution_note,created_at,resolved_at) VALUES ('merge-approval','FINAL_MERGE','epic-1','EPIC','APPROVED','local-user','local-user',NULL,$now,$now)", { now });
  const scheduler = { projectProjection: vi.fn(() => ({ global: { active: 0, max: 1 }, projects: [] })) };
  const merge = { mergeApprovedForIntegration: vi.fn(async () => ({ success: true, subjectId: "epic-1", targetBranch: "master", mergeCommitSha: "sha", resultingTargetSha: "sha", verifiedCompletion: true as const })) };
  const factory = vi.fn(() => merge);
  const epicOrchestrator = { approveFinalMergeAsync: vi.fn(async () => ({ epicId: "epic-1", status: "DONE" })) };
  const app = createApp({ db, scheduler: scheduler as never, runService: {} as never, finalMergeServiceFactory: factory, epicOrchestrator: epicOrchestrator as never });
  return { db, app, factory, merge, epicOrchestrator };
}

function headers(app: ReturnType<typeof createApp>) {
  return { authorization: `Bearer ${app.sessionToken}`, origin: "http://127.0.0.1:3000", "x-csrf-token": app.csrfToken };
}

describe("final merge route", () => {
  it("delegates Epic merge to the persisted orchestration authority", async () => {
    const { db, app, factory, merge, epicOrchestrator } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/final-merges/epic-1",
      headers: headers(app),
      payload: { approvalId: "merge-approval", integrationRunId: "integration-run-1" },
    });
    expect(response.statusCode).toBe(200);
    expect(epicOrchestrator.approveFinalMergeAsync).toHaveBeenCalledWith("epic-1", "merge-approval");
    expect(factory).not.toHaveBeenCalled();
    expect(merge.mergeApprovedForIntegration).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it("rejects client repository and branch authority", async () => {
    const { db, app, merge } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/final-merges/epic-1",
      headers: headers(app),
      payload: { approvalId: "merge-approval", integrationRunId: "integration-run-1", repoPath: "C:\\attacker", targetBranch: "attacker" },
    });
    expect(response.statusCode).toBe(400);
    expect(merge.mergeApprovedForIntegration).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });

  it("requires exact approved FINAL_MERGE subject", async () => {
    const { db, app, merge } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/final-merges/other-subject",
      headers: headers(app),
      payload: { approvalId: "merge-approval", integrationRunId: "integration-run-1" },
    });
    expect(response.statusCode).toBe(409);
    expect(merge.mergeApprovedForIntegration).not.toHaveBeenCalled();
    await app.close();
    db.close();
  });
});
