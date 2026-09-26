import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { DashboardProjection } from "../../../src/app/read-models/dashboard-projection.js";
import { TaskProjection } from "../../../src/app/read-models/task-projection.js";
import { ProjectProjection } from "../../../src/app/read-models/project-projection.js";
import { EpicProjection } from "../../../src/app/read-models/epic-projection.js";
import { ExecutionProjection } from "../../../src/app/read-models/execution-projection.js";
import { listActiveApprovedOnboardingRepositories } from "../../../src/modules/projects/onboarding-service.js";

function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const now = new Date().toISOString(); const projectId = randomUUID(); const taskId = randomUUID();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
  db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',1,$now,$now)", { id: taskId, projectId, now });
  return { db, projectId, taskId };
}

const blocked = { status: "BLOCK" as const, reason: { code: "ONBOARDING_NOT_ACTIVE" as const, message: "Онбординг проекта не активирован" } };

describe("scheduler projection serialization", () => {
  it("serializes missing onboarding as the exact hard block in every read model", () => {
    const { db, projectId, taskId } = setup();
    const dashboard = new DashboardProjection(db).get();
    const task = new TaskProjection(db).get(taskId)!;
    const project = new ProjectProjection(db).get(projectId)!;
    const execution = new ExecutionProjection(db).get();
    expect(dashboard.activeWork[0]?.eligibility).toEqual(blocked);
    expect(task.scheduler).toEqual(blocked);
    expect(project.tasks[0]?.eligibility).toEqual(blocked);
    expect(execution.blocked).toEqual([{ taskId, reason: blocked.reason }]);
    expect(execution.waiting).toEqual([]);
    expect(JSON.stringify(task)).not.toContain("waitReason");
    expect(JSON.stringify(execution)).not.toContain("RUNNABLE");
    expect(execution.waiting).toEqual([]);
    db.close();
  });

  it("keeps the same block for PROPOSED onboarding and never places it in waiting", () => {
    const { db, projectId, taskId } = setup(); const now = new Date().toISOString();
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/repo','{}','null','PROPOSED',NULL,$now,$now)", { projectId, now });
    const result = new ExecutionProjection(db).get();
    expect(result.blocked).toEqual([{ taskId, reason: blocked.reason }]);
    expect(result.waiting).toEqual([]);
    db.close();
  });

  it("fails closed when onboarding schema is missing without SchedulerService", () => {
    const { db } = setup();
    db.exec("DROP TABLE onboarding_configs");
    const result = new DashboardProjection(db).get();
    expect(result.activeWork[0]?.eligibility).toEqual(blocked);
    expect(result.activeWork[0]?.eligibility.status).not.toBe("RUNNABLE");
    expect(result.activeWork[0]?.eligibility.status).not.toBe("WAIT");
    db.close();
  });

  it("does not expose a legacy repository path without an active project-bound approval", () => {
    const { db, projectId } = setup(); const now = new Date().toISOString(); const otherProjectId = randomUUID();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'other','Other','ACTIVE',$now,$now)", { id: otherProjectId, now });
    const foreignApprovalId = randomUUID(); const matchingApprovalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$otherId,'PROJECT','APPROVED','test',$now)", { id: foreignApprovalId, otherId: otherProjectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: matchingApprovalId, projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/approved/repository','{}','{}','ACTIVE',$approvalId,$now,$now)", { projectId, approvalId: foreignApprovalId, now });
    db.run("INSERT INTO system_state(key,value_json,updated_at) VALUES($key,$value,$now)", { key: `project:${projectId}:git`, value: JSON.stringify({ repositoryPath: "/stale-unapproved-path", defaultBranch: "main" }), now });
    const projection = new ProjectProjection(db);
    expect(projection.get(projectId)?.git.repositoryPath).toBeNull();

    db.run("UPDATE onboarding_configs SET approval_id=$approvalId WHERE project_id=$projectId", { projectId, approvalId: matchingApprovalId });
    expect(projection.get(projectId)?.git.repositoryPath).toBe("/approved/repository");
    db.close();
  });

  it("uses only the approved onboarding path when Git journals contain stale paths", () => {
    const { db, projectId, taskId } = setup(); const now = new Date().toISOString(); const epicId = randomUUID();
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E-1','Epic','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    db.run("UPDATE tasks SET epic_id=$epicId WHERE id=$taskId", { epicId, taskId });
    const approvalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/approved/repository','{}','{}','ACTIVE',$approvalId,$now,$now)", { projectId, approvalId, now });
    db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,target_ref,created_at) VALUES('stale-task','WORKTREE','VERIFIED','/stale/task-repository',$taskBranch,'master',$now)", { taskBranch: `task/${taskId}`, now });
    db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,target_ref,created_at) VALUES('stale-epic','WORKTREE','VERIFIED','/stale/epic-repository',$epicBranch,'master',$now)", { epicBranch: `epic/${epicId}`, now });

    expect(listActiveApprovedOnboardingRepositories(db, projectId)).toEqual([{ repository_path: "/approved/repository", proposed_json: "{}" }]);
    expect(new TaskProjection(db).get(taskId)?.git.repositoryPath).toBe("/approved/repository");
    expect(new ProjectProjection(db).get(projectId)?.git.repositoryPath).toBe("/approved/repository");
    expect(new EpicProjection(db).get(epicId)?.git.repositoryPath).toBe("/approved/repository");
    db.close();
  });
});
