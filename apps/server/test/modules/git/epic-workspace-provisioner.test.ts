import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import { GitCli } from "../../../src/modules/git/git-cli.js";
import { EpicWorkspaceProvisioner } from "../../../src/modules/git/epic-workspace-provisioner.js";

function migrations(): Migration[] {
  const directory = join(import.meta.dirname, "../../../src/platform/database/migrations");
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name, index) => ({
    version: index + 1,
    name: name.slice(0, -4),
    sql: readFileSync(join(directory, name), "utf8"),
  }));
}

async function initGitRepo(path: string): Promise<GitCli> {
  mkdirSync(path, { recursive: true });
  const git = new GitCli();
  await git.run(path, ["init"]);
  await git.run(path, ["config", "user.email", "test@example.com"]);
  await git.run(path, ["config", "user.name", "Test User"]);
  writeFileSync(join(path, "README.md"), "# Ebb Orchestrator test fixture");
  await git.run(path, ["add", "README.md"]);
  await git.run(path, ["commit", "-m", "initial"]);
  return git;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ebb-epic-worktree-"));
  const repoPath = join(root, "repo");
  const worktreeDir = join(root, "managed-epics");
  const git = await initGitRepo(repoPath);
  const db = createSqliteDatabase(join(root, "state.sqlite"));
  runMigrations(db, migrations());
  const projectId = randomUUID();
  const epicId = randomUUID();
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'worktree','Worktree','ACTIVE',$now,$now)", { id: projectId, now });
  db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,created_at,resolved_at) VALUES('approval-1','WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','tester','tester',$now,$now)", { projectId, now });
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repoPath,$facts,$proposed,'ACTIVE','approval-1',$now,$now)", {
    projectId,
    repoPath,
    facts: JSON.stringify({ defaultBranch: "master" }),
    proposed: JSON.stringify({ defaultBranch: "master" }),
    now,
  });
  db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-123','Test Epic','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
  const provisioner = new EpicWorkspaceProvisioner({ database: db, worktreeDir });
  return { root, repoPath, worktreeDir, db, git, epicId, provisioner };
}

describe("EpicWorkspaceProvisioner", () => {
  it("creates and reuses a journaled Epic worktree without checking out its branch in the project repository", async () => {
    const f = await fixture();
    try {
      const first = await f.provisioner.provisionForEpic(f.epicId);
      const second = await f.provisioner.provisionForEpic(f.epicId);

      expect(first).toEqual(second);
      expect(first.id).toBe(`epic:${f.epicId}`);
      expect(first.repoPath).toBe(f.repoPath);
      expect(first.path).toBe(join(f.worktreeDir, `epic-${f.epicId}`));
      expect(first.branch).toBe("epic/EPIC-123");
      expect((await f.git.run(f.repoPath, ["branch", "--show-current"])).stdout.trim()).toBe("master");
      expect((await f.git.run(first.path, ["branch", "--show-current"])).stdout.trim()).toBe("epic/EPIC-123");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees WHERE id=$id AND path=$path AND branch=$branch AND removed_at IS NULL", {
        id: `epic:${f.epicId}`, path: first.path, branch: "epic/EPIC-123",
      })?.count).toBe(1);
      expect(f.db.get<{ status: string; target_ref: string }>("SELECT status,target_ref FROM git_operations WHERE worktree_id=$id", { id: first.id })).toMatchObject({ status: "VERIFIED", target_ref: "master" });
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations WHERE worktree_id=$id", { id: first.id })?.count).toBe(1);
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("refuses an existing Epic branch and preserves the project checkout", async () => {
    const f = await fixture();
    try {
      await f.git.run(f.repoPath, ["branch", "epic/EPIC-123"]);
      await expect(f.provisioner.provisionForEpic(f.epicId)).rejects.toThrow();
      expect((await f.git.run(f.repoPath, ["branch", "--show-current"])).stdout.trim()).toBe("master");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees")?.count).toBe(0);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations")?.count).toBe(0);
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("reconciles an interrupted create only when the managed worktree is exactly at the approved base ref", async () => {
    const f = await fixture();
    try {
      const worktreeId = `epic:${f.epicId}`;
      const worktreePath = join(f.worktreeDir, `epic-${f.epicId}`);
      const hooksPath = mkdtempSync(join(tmpdir(), "ebb-epic-recovery-hooks-"));
      try {
        await f.git.run(f.repoPath, ["-c", `core.hooksPath=${hooksPath.replace(/\\/g, "/")}`, "worktree", "add", "-b", "epic/EPIC-123", worktreePath, "master"]);
      } finally {
        rmSync(hooksPath, { recursive: true, force: true });
      }
      f.db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at) VALUES('operation-1','CREATE_WORKTREE','STARTED',$repo,$branch,$worktreeId,'master',$now)", {
        repo: f.repoPath,
        branch: "epic/EPIC-123",
        worktreeId,
        now: new Date().toISOString(),
      });

      const recovered = await f.provisioner.provisionForEpic(f.epicId);

      expect(recovered.path).toBe(worktreePath);
      expect(f.db.get<{ status: string }>("SELECT status FROM git_operations WHERE id='operation-1'")?.status).toBe("VERIFIED");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees WHERE id=$id AND removed_at IS NULL", { id: worktreeId })?.count).toBe(1);
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("does not verify an interrupted Epic worktree that became dirty", async () => {
    const f = await fixture();
    try {
      const worktree = await f.provisioner.provisionForEpic(f.epicId);
      f.db.run("UPDATE git_operations SET status='STARTED',verified_at=NULL WHERE worktree_id=$id", { id: worktree.id });
      writeFileSync(join(worktree.path, "unexpected.txt"), "uncommitted data");

      await expect(f.provisioner.provisionForEpic(f.epicId)).rejects.toThrow(/dirty|clean|modified/i);

      expect(readFileSync(join(worktree.path, "unexpected.txt"), "utf8")).toBe("uncommitted data");
      expect(f.db.get<{ status: string }>("SELECT status FROM git_operations WHERE worktree_id=$id", { id: worktree.id })?.status).toBe("STARTED");
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("fails closed when onboarding is not active and approved", async () => {
    const f = await fixture();
    try {
      f.db.run("UPDATE onboarding_configs SET status='PROPOSED' WHERE project_id=(SELECT project_id FROM epics WHERE id=$epicId)", { epicId: f.epicId });
      await expect(f.provisioner.provisionForEpic(f.epicId)).rejects.toThrow(/approved onboarding/i);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees")?.count).toBe(0);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations")?.count).toBe(0);
    } finally {
      f.db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
