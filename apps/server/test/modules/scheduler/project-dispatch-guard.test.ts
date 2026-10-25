import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { assertProjectDispatchableTx, projectDispatchEligibilityTx, dispatchPauseEligibilityTx, assertDispatchPauseAllowedTx } from "../../../src/modules/scheduler/project-dispatch-guard.js";

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

  it("blocks dispatch when an approved active Project Config is degraded", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'project','Project','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId, id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,'/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { id: projectId, approvalId, now });
    db.run("INSERT INTO project_config_state(project_id,current_candidate_id,active_revision_id,config_status,updated_at) VALUES($id,NULL,NULL,'DEGRADED',$now)", { id: projectId, now });

    expect(db.transaction((tx) => projectDispatchEligibilityTx(tx, projectId))).toEqual({ allowed: false, reason: "PROJECT_CONFIG_DEGRADED" });
    expect(() => db.transaction((tx) => assertProjectDispatchableTx(tx, projectId))).toThrow("PROJECT_CONFIG_DEGRADED");
    db.close();
  });

  it("blocks a lifecycle project before its first approved Project Config revision", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'project','Project','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId, id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,'/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { id: projectId, approvalId, now });
    db.run("INSERT INTO project_config_state(project_id,current_candidate_id,active_revision_id,config_status,updated_at) VALUES($id,NULL,NULL,'READY',$now)", { id: projectId, now });

    expect(db.transaction((tx) => projectDispatchEligibilityTx(tx, projectId))).toEqual({ allowed: false, reason: "PROJECT_CONFIG_DEGRADED" });
    db.close();
  });
});

/**
 * Durable dispatch pause gates (plan-27 Task 2): глобальная пауза,
 * PROJECT- и EPIC-scope паузы проверяются в той же транзакции admission/reservation.
 */
describe("dispatch pause gates", () => {
  function activeProject(db: ReturnType<typeof createSqliteDatabase>, id: string, now: string): void {
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'project','Project','ACTIVE',$now,$now)", { id, now });
    const approvalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId, id, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,'/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { id, approvalId, now });
  }

  it("allows dispatch when no pause state exists", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    activeProject(db, projectId, new Date().toISOString());

    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId }))).toEqual({ allowed: true });
    expect(() => db.transaction((tx) => assertDispatchPauseAllowedTx(tx, { projectId }))).not.toThrow();
    db.close();
  });

  it("blocks all new reservations when global dispatch is paused", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    activeProject(db, projectId, new Date().toISOString());
    db.run("UPDATE scheduler_config SET dispatch_paused=1 WHERE id=1");

    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId }))).toEqual({ allowed: false, reason: "DISPATCH_PAUSED_GLOBAL" });
    expect(() => db.transaction((tx) => assertDispatchPauseAllowedTx(tx, { projectId }))).toThrow("DISPATCH_PAUSED_GLOBAL");
    db.close();
  });

  it("blocks only the paused project and never leaks across projects", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const now = new Date().toISOString();
    const pausedProject = randomUUID();
    const otherProject = randomUUID();
    activeProject(db, pausedProject, now);
    activeProject(db, otherProject, now);
    db.run("INSERT INTO scheduler_scope_pauses(scope,scope_id,paused_at,actor) VALUES('PROJECT',$scopeId,$now,'test')", { scopeId: pausedProject, now });

    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId: pausedProject }))).toEqual({ allowed: false, reason: "DISPATCH_PAUSED_PROJECT" });
    expect(() => db.transaction((tx) => assertDispatchPauseAllowedTx(tx, { projectId: pausedProject }))).toThrow("DISPATCH_PAUSED_PROJECT");
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId: otherProject }))).toEqual({ allowed: true });
    db.close();
  });

  it("blocks dispatch for a task under a paused epic without affecting other epics or the project", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const pausedEpic = randomUUID();
    const otherEpic = randomUUID();
    activeProject(db, projectId, now);
    for (const epicId of [pausedEpic, otherEpic]) db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E','Epic','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    db.run("INSERT INTO scheduler_scope_pauses(scope,scope_id,paused_at,actor) VALUES('EPIC',$scopeId,$now,'test')", { scopeId: pausedEpic, now });

    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId, epicId: pausedEpic }))).toEqual({ allowed: false, reason: "DISPATCH_PAUSED_EPIC" });
    expect(() => db.transaction((tx) => assertDispatchPauseAllowedTx(tx, { projectId, epicId: pausedEpic }))).toThrow("DISPATCH_PAUSED_EPIC");
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId, epicId: otherEpic }))).toEqual({ allowed: true });
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId }))).toEqual({ allowed: true });
    db.close();
  });

  it("rejects a pause row with a foreign project scoped to the wrong epic hierarchy", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const now = new Date().toISOString();
    const projectA = randomUUID();
    const projectB = randomUUID();
    const epicInA = randomUUID();
    activeProject(db, projectA, now);
    activeProject(db, projectB, now);
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E','Epic','OPEN','{}',$now,$now)", { id: epicInA, projectId: projectA, now });
    db.run("INSERT INTO scheduler_scope_pauses(scope,scope_id,paused_at,actor) VALUES('EPIC',$scopeId,$now,'test')", { scopeId: epicInA, now });

    // Задача из проекта B не должна блокироваться паузой эпика проекта A.
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId: projectB, epicId: epicInA }))).toEqual({ allowed: true });
    db.close();
  });
});
