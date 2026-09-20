import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import { GitCli } from "../../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../../src/modules/git/worktree-manager.js";
import { TaskWorkspaceProvisioner } from "../../../src/modules/git/task-workspace-provisioner.js";

function migrations(): Migration[] {
  const dir = join(import.meta.dirname, "../../../src/platform/database/migrations");
  return readdirSync(dir).filter((file) => file.endsWith(".sql")).sort().map((file, index) => ({
    version: index + 1,
    name: file.slice(0, -4),
    sql: readFileSync(join(dir, file), "utf8"),
  }));
}

async function gitRepository(root: string): Promise<void> {
  const git = new GitCli();
  await git.run(root, ["init", "-b", "master"]);
  await git.run(root, ["config", "user.email", "test@example.com"]);
  await git.run(root, ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "README.md"), "# test\n");
  await git.run(root, ["add", "README.md"]);
  await git.run(root, ["commit", "-m", "initial"]);
}

describe("TaskWorkspaceProvisioner", () => {
  it("provisions a task worktree from approved onboarding and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-provisioning-"));
    const repo = join(root, "repo");
    const db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
    await gitRepository(repo);
    const projectId = randomUUID();
    const epicId = randomUUID();
    const taskId = randomUUID();
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    try {
      runMigrations(db, migrations());
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-1','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
      db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,$epicId,'TASK-1','T','DRAFT','{}',1,$now,$now)", { id: taskId, projectId, epicId, now });
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES($projectId,$repo,$facts,$proposed,'ACTIVE',$approvalId,$now,$now,$now)", { projectId, repo, approvalId, facts: JSON.stringify({ defaultBranch: "master" }), proposed: JSON.stringify({ defaultBranch: "master" }), now });

      const manager = new WorktreeManager({ db, worktreeDir: join(root, "worktrees") });
      const provisioner = new TaskWorkspaceProvisioner({ database: db, worktreeManager: manager });
      await provisioner.provisionForEpic(epicId);
      await provisioner.provisionForEpic(epicId);

      const operation = db.get<{ status: string; branch_name: string; target_ref: string; repo_path: string }>("SELECT status,branch_name,target_ref,repo_path FROM git_operations WHERE worktree_id=$taskId", { taskId });
      expect(operation).toEqual({ status: "VERIFIED", branch_name: `task/${taskId}`, target_ref: "master", repo_path: repo });
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations WHERE worktree_id=$taskId", { taskId })?.count).toBe(1);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees WHERE id=$taskId AND removed_at IS NULL", { taskId })?.count).toBe(1);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
