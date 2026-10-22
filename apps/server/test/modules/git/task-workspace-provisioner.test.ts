import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import { GitCli } from "../../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../../src/modules/git/worktree-manager.js";
import { TaskWorkspaceProvisioner } from "../../../src/modules/git/task-workspace-provisioner.js";
import { EpicWorkspaceProvisioner } from "../../../src/modules/git/epic-workspace-provisioner.js";

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
  it("rejects onboarding bound to another project's approved workflow change without creating worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-provisioning-mismatch-"));
    const repo = join(root, "repo");
    const db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
    await gitRepository(repo);
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const epicId = randomUUID();
    const taskId = randomUUID();
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    try {
      runMigrations(db, migrations());
      for (const id of [projectId, otherProjectId]) db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id, now });
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-1','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
      db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,$epicId,'TASK-1','T','DRAFT','{}',1,$now,$now)", { id: taskId, projectId, epicId, now });
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$otherProjectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, otherProjectId, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES($projectId,$repo,$facts,$proposed,'ACTIVE',$approvalId,$now,$now,$now)", { projectId, repo, approvalId, facts: JSON.stringify({ defaultBranch: "master" }), proposed: JSON.stringify({ defaultBranch: "master" }), now });
      const manager = new WorktreeManager({ db, worktreeDir: join(root, "worktrees") });
      const provisioner = new TaskWorkspaceProvisioner({ database: db, worktreeManager: manager });
      await expect(provisioner.provisionForEpic(epicId)).rejects.toThrow("active approved onboarding is required");
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations")?.count).toBe(0);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees")?.count).toBe(0);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
      await new EpicWorkspaceProvisioner({ database: db, worktreeDir: join(root, "epic-worktrees") }).provisionForEpic(epicId);
      await provisioner.provisionForEpic(epicId);
      await provisioner.provisionForEpic(epicId);

      const operation = db.get<{ status: string; branch_name: string; target_ref: string; repo_path: string }>("SELECT status,branch_name,target_ref,repo_path FROM git_operations WHERE worktree_id=$taskId", { taskId });
      expect(operation).toEqual({ status: "VERIFIED", branch_name: `task/${taskId}`, target_ref: "epic/EPIC-1", repo_path: repo });
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations WHERE worktree_id=$taskId", { taskId })?.count).toBe(1);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees WHERE id=$taskId AND removed_at IS NULL", { taskId })?.count).toBe(1);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("provisions a dependent task from the Epic head after its prerequisite is integrated", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-provisioning-dependent-"));
    const repo = join(root, "repo");
    const db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
    await gitRepository(repo);
    const projectId = randomUUID();
    const epicId = randomUUID();
    const prerequisiteId = randomUUID();
    const dependentId = randomUUID();
    const staleUnstartedId = randomUUID();
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    const git = new GitCli();
    try {
      runMigrations(db, migrations());
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-1','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
      for (const [id, displayId] of [[prerequisiteId, "TASK-1"], [dependentId, "TASK-2"], [staleUnstartedId, "TASK-3"]] as const) {
        db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,$epicId,$displayId,'T','DRAFT','{}',1,$now,$now)", { id, projectId, epicId, displayId, now });
      }
      db.run("INSERT INTO dependencies(id,task_id,depends_on_task_id,type,created_at) VALUES($id,$taskId,$dependencyId,'BLOCKING',$now)", { id: randomUUID(), taskId: dependentId, dependencyId: prerequisiteId, now });
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES($projectId,$repo,$facts,$proposed,'ACTIVE',$approvalId,$now,$now,$now)", { projectId, repo, approvalId, facts: JSON.stringify({ defaultBranch: "master" }), proposed: JSON.stringify({ defaultBranch: "master" }), now });

      const epicWorkspace = await new EpicWorkspaceProvisioner({ database: db, worktreeDir: join(root, "epic-worktrees"), git }).provisionForEpic(epicId);
      const provisioner = new TaskWorkspaceProvisioner({ database: db, worktreeManager: new WorktreeManager({ db, git, worktreeDir: join(root, "task-worktrees") }), git });
      await provisioner.provisionForEpic(epicId, [prerequisiteId, staleUnstartedId]);
      const staleWorkspace = db.get<{ path: string }>("SELECT path FROM worktrees WHERE id=$id AND removed_at IS NULL", { id: staleUnstartedId });
      expect(staleWorkspace).toBeDefined();
      const staleHeadBefore = (await git.run(staleWorkspace!.path, ["rev-parse", "HEAD"])).stdout.trim();

      writeFileSync(join(epicWorkspace.path, "prerequisite-integrated.txt"), "integrated prerequisite\n");
      await git.run(epicWorkspace.path, ["add", "prerequisite-integrated.txt"]);
      await git.run(epicWorkspace.path, ["commit", "-m", "integrate prerequisite task"]);
      const integratedHead = (await git.run(repo, ["rev-parse", "epic/EPIC-1"])).stdout.trim();

      await provisioner.provisionForEpic(epicId, [dependentId]);

      const dependentWorkspace = db.get<{ path: string }>("SELECT path FROM worktrees WHERE id=$id AND removed_at IS NULL", { id: dependentId });
      expect(dependentWorkspace).toBeDefined();
      expect((await git.run(dependentWorkspace!.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(integratedHead);
      expect(readFileSync(join(dependentWorkspace!.path, "prerequisite-integrated.txt"), "utf8")).toBe("integrated prerequisite\n");
      await expect(provisioner.provisionForEpic(epicId, [staleUnstartedId]))
        .rejects.toThrow(`TASK_WORKSPACE_STALE_BEFORE_DISPATCH:${staleUnstartedId}`);
      expect((await git.run(staleWorkspace!.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(staleHeadBefore);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for every parallel task operation before rejecting a failed batch", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-provisioning-drain-"));
    const repo = join(root, "repo");
    const db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(repo));
    await gitRepository(repo);
    const projectId = randomUUID();
    const epicId = randomUUID();
    const failedTaskId = randomUUID();
    const delayedTaskId = randomUUID();
    const approvalId = randomUUID();
    const now = new Date().toISOString();
    try {
      runMigrations(db, migrations());
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-1','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
      for (const [id, displayId] of [[failedTaskId, "TASK-1"], [delayedTaskId, "TASK-2"]] as const) {
        db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,$epicId,$displayId,'T','DEVELOPMENT','{}',1,$now,$now)", { id, projectId, epicId, displayId, now });
      }
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES($projectId,$repo,$facts,$proposed,'ACTIVE',$approvalId,$now,$now,$now)", { projectId, repo, approvalId, facts: JSON.stringify({ defaultBranch: "master" }), proposed: JSON.stringify({ defaultBranch: "master" }), now });
      await new EpicWorkspaceProvisioner({ database: db, worktreeDir: join(root, "epic-worktrees") }).provisionForEpic(epicId);

      let startSibling!: () => void;
      let releaseSibling!: () => void;
      const siblingStarted = new Promise<void>((resolve) => { startSibling = resolve; });
      const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
      const firstFailure = new Error("first task workspace failure");
      let siblingSettled = false;
      let activeMutations = 0;
      const fakeWorktrees = {
        async createTaskWorkspace(taskId: string, repoPath: string, _targetRef: string) {
          if (taskId === failedTaskId) throw firstFailure;
          activeMutations += 1;
          startSibling();
          try {
            await siblingGate;
            db.run("UPDATE tasks SET title='Sibling settled' WHERE id=$id", { id: taskId });
            siblingSettled = true;
          } finally {
            activeMutations -= 1;
          }
          return { id: taskId, repoPath, path: join(root, taskId), branch: `task/${taskId}`, createdAt: now, removedAt: null };
        },
      } as unknown as WorktreeManager;
      const provisioner = new TaskWorkspaceProvisioner({ database: db, worktreeManager: fakeWorktrees });
      const batch = provisioner.provisionForEpic(epicId, [failedTaskId, delayedTaskId]);
      let returnedError: unknown;
      const observed = batch.catch((error: unknown) => { returnedError = error; });

      await siblingStarted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rejectedBeforeSiblingSettled = returnedError !== undefined;
      releaseSibling();
      await observed;

      expect(rejectedBeforeSiblingSettled).toBe(false);
      expect(returnedError).toBe(firstFailure);
      expect(siblingSettled).toBe(true);
      expect(activeMutations).toBe(0);
      expect(db.get<{ title: string }>("SELECT title FROM tasks WHERE id=$id", { id: delayedTaskId })?.title).toBe("Sibling settled");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a previously verified task worktree journaled against the base branch and preserves it", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-provisioning-legacy-target-"));
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
      const epicWorktreeDir = join(root, "epic-worktrees");
      await new EpicWorkspaceProvisioner({ database: db, worktreeDir: epicWorktreeDir }).provisionForEpic(epicId);
      const legacyWorkspace = await manager.createTaskWorkspace(taskId, repo, "master");
      const provisioner = new TaskWorkspaceProvisioner({ database: db, worktreeManager: manager });

      await expect(provisioner.provisionForEpic(epicId)).rejects.toThrow("persisted Git provisioning mismatch");

      expect(db.get<{ status: string; target_ref: string }>("SELECT status,target_ref FROM git_operations WHERE worktree_id=$taskId", { taskId }))
        .toEqual({ status: "VERIFIED", target_ref: "master" });
      expect((await new GitCli().run(repo, ["worktree", "list"])).stdout.replace(/\\/g, "/").toLowerCase())
        .toContain(legacyWorkspace.path.replace(/\\/g, "/").toLowerCase());
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
