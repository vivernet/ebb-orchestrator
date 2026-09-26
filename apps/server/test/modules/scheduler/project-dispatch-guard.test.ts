import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { assertProjectDispatchableTx, projectDispatchEligibilityTx } from "../../../src/modules/scheduler/project-dispatch-guard.js";

describe("project dispatch guard", () => {
  it("fails closed when onboarding_configs is absent for an active project", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'project','Project','ACTIVE',$now,$now)", { id: projectId, now });
    db.exec("DROP TABLE onboarding_configs");

    expect(db.transaction((tx) => projectDispatchEligibilityTx(tx, projectId))).toEqual({ allowed: false, reason: "ONBOARDING_NOT_ACTIVE" });
    expect(() => db.transaction((tx) => assertProjectDispatchableTx(tx, projectId))).toThrow("ONBOARDING_NOT_ACTIVE");
    db.close();
  });

  it("blocks a project with missing onboarding in the caller transaction", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'project','Project','ACTIVE',$now,$now)", { id: projectId, now });

    expect(db.transaction((tx) => projectDispatchEligibilityTx(tx, projectId))).toEqual({ allowed: false, reason: "ONBOARDING_NOT_ACTIVE" });
    expect(() => db.transaction((tx) => assertProjectDispatchableTx(tx, projectId))).toThrow("ONBOARDING_NOT_ACTIVE");
    db.close();
  });

  it("allows only an active project with active onboarding", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'project','Project','ACTIVE',$now,$now)", { id: projectId, now });
    const approvalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId, id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,'/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { id: projectId, approvalId, now });

    expect(db.transaction((tx) => projectDispatchEligibilityTx(tx, projectId))).toEqual({ allowed: true });
    expect(() => db.transaction((tx) => assertProjectDispatchableTx(tx, projectId))).not.toThrow();
    db.close();
  });

  it("blocks active onboarding when its approved approval belongs to another project", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const foreignProjectId = randomUUID();
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    for (const id of [projectId, foreignProjectId]) db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'project','Project','ACTIVE',$now,$now)", { id, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$foreignProjectId,'PROJECT','APPROVED','test',$now)", { approvalId, foreignProjectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { projectId, approvalId, now });

    expect(db.transaction((tx) => projectDispatchEligibilityTx(tx, projectId))).toEqual({ allowed: false, reason: "ONBOARDING_NOT_ACTIVE" });
    expect(() => db.transaction((tx) => assertProjectDispatchableTx(tx, projectId))).toThrow("ONBOARDING_NOT_ACTIVE");
    db.close();
  });
});
