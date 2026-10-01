import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "../../platform/database/database.js";
import { GitCli, assertSafeGitRef } from "./git-cli.js";
import { GitOperationRepository } from "./git-operation-repository.js";
import { WorktreeRepository } from "./worktree-repository.js";
import type { WorktreeRecord } from "./worktree-manager.js";

export interface EpicWorkspaceProvisionerOptions {
  database: Database;
  worktreeDir: string;
  git?: GitCli;
}

interface EpicRow {
  id: string;
  project_id: string;
  display_id: string;
  repository_path: string;
  facts_json: string;
  proposed_json: string;
}

/**
 * Разрешает и проверяет managed workspace для Epic agent phases.
 * Repository и base ref берутся только из active approved onboarding; произвольные
 * пути, ветки и user supplied значения в этот сервис не передаются.
 */
export class EpicWorkspaceProvisioner {
  private readonly db: Database;
  private readonly git: GitCli;
  private readonly worktrees: WorktreeRepository;
  private readonly operations: GitOperationRepository;
  private readonly worktreeDir: string;

  constructor(options: EpicWorkspaceProvisionerOptions) {
    this.db = options.database;
    this.git = options.git ?? new GitCli();
    this.worktrees = new WorktreeRepository(options.database);
    this.operations = new GitOperationRepository(options.database);
    this.worktreeDir = resolve(options.worktreeDir);
  }

  /** Гарантирует проверенную и журналированную ветку `epic/<display_id>`. */
  async provisionForEpic(epicId: string): Promise<WorktreeRecord> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(epicId)) throw new Error("Epic ID is invalid");
    const onboarding = this.db.get<EpicRow>(
      `SELECT e.id,e.project_id,e.display_id,o.repository_path,o.facts_json,o.proposed_json
         FROM epics e JOIN projects p ON p.id=e.project_id AND p.status='ACTIVE'
         JOIN onboarding_configs o ON o.project_id=e.project_id AND o.status='ACTIVE'
         JOIN approvals a ON a.id=o.approval_id AND a.subject_type='PROJECT' AND a.subject_id=e.project_id
            AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'
        WHERE e.id=$epicId`,
      { epicId },
    );
    if (!onboarding) throw new Error("active approved onboarding is required for Epic workspace");

    const repoPath = validatePersistedRepository(onboarding.repository_path);
    const targetRef = resolveTargetRef(onboarding);
    const branch = `epic/${onboarding.display_id}`;
    assertSafeGitRef(branch);
    const worktreeId = `epic:${onboarding.id}`;
    const worktreePath = join(this.worktreeDir, `epic-${onboarding.id}`);
    const prior = this.db.all<{ id: string; repo_path: string; path: string; branch: string; removed_at: string | null }>(
      "SELECT id,repo_path,path,branch,removed_at FROM worktrees WHERE id=$id",
      { id: worktreeId },
    );
    const journal = this.db.all<{ id: string; type: string; status: string; repo_path: string; branch_name: string | null; worktree_id: string | null; target_ref: string | null }>(
      "SELECT id,type,status,repo_path,branch_name,worktree_id,target_ref FROM git_operations WHERE worktree_id=$id ORDER BY created_at",
      { id: worktreeId },
    );

    this.ensureManagedRoot();
    const targetHead = (await this.git.run(repoPath, ["rev-parse", "--verify", "--end-of-options", `${targetRef}^{commit}`])).stdout.trim();
    if (!targetHead) throw new Error("Epic workspace target ref does not resolve to a commit");
    if (prior.length || journal.length) {
      if (journal.length !== 1) throw new Error("Epic workspace journal requires reconciliation");
      const operation = journal[0]!;
      if (operation.type !== "CREATE_WORKTREE" || operation.repo_path !== repoPath || operation.branch_name !== branch
        || operation.target_ref !== targetRef || operation.worktree_id !== worktreeId) {
        throw new Error("Epic workspace journal does not match active approved onboarding");
      }
      if (prior.length > 1) throw new Error("Epic workspace has duplicate journal rows");
      if (operation.status === "VERIFIED") {
        const record = this.worktrees.findById(worktreeId);
        if (!record || record.repoPath !== repoPath || record.path !== worktreePath || record.branch !== branch) {
          throw new Error("Epic workspace journal does not match active approved onboarding");
        }
        await this.verifyActualWorktree(record);
        return record;
      }
      if (operation.status !== "STARTED") throw new Error("Epic workspace operation status is invalid");
      const record: WorktreeRecord = prior.length === 1
        ? this.worktrees.findById(worktreeId)!
        : { id: worktreeId, repoPath, path: worktreePath, branch, createdAt: new Date().toISOString(), removedAt: null };
      if (record.repoPath !== repoPath || record.path !== worktreePath || record.branch !== branch || !existsSync(worktreePath)) {
        throw new Error("Epic workspace Git operation requires manual reconciliation");
      }
      await this.verifyActualWorktree(record, targetHead);
      if (prior.length === 0) this.worktrees.create(record);
      this.operations.verify(operation.id);
      if (this.operations.findById(operation.id)?.status !== "VERIFIED") throw new Error("Epic workspace recovery was not durably verified");
      return record;
    }
    if (existsSync(worktreePath)) throw new Error("Epic workspace path is already occupied");
    const localBranch = await this.git.run(repoPath, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]);
    if (localBranch.stdout.trim()) throw new Error("Epic branch already exists without a verified managed workspace");

    // Journal intent is durable before the Git mutation. An interrupted attempt
    // remains STARTED and requires reconciliation instead of an unsafe retry.
    const operation = this.operations.create({
      id: crypto.randomUUID(),
      type: "CREATE_WORKTREE",
      repoPath,
      branchName: branch,
      worktreeId,
      targetRef,
    });
    const emptyHooksDir = mkdtempSync(join(tmpdir(), "ebb-epic-hooks-"));
    let record: WorktreeRecord | undefined;
    try {
      await this.git.run(repoPath, [
        "-c", `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "worktree", "add", "-b", branch, worktreePath, targetRef,
      ]);
      record = {
        id: worktreeId,
        repoPath,
        path: worktreePath,
        branch,
        createdAt: new Date().toISOString(),
        removedAt: null,
      };
      await this.verifyActualWorktree(record, targetHead);
      this.worktrees.create(record);
      this.operations.verify(operation.id);
      const verified = this.operations.findById(operation.id);
      if (verified?.status !== "VERIFIED") throw new Error("Epic workspace Git operation was not durably verified");
      return record;
    } finally {
      rmSync(emptyHooksDir, { recursive: true, force: true });
    }
  }

  private ensureManagedRoot(): void {
    mkdirSync(this.worktreeDir, { recursive: true });
    const stat = lstatSync(this.worktreeDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Epic worktree root must be a real directory");
    const real = realpathSync(this.worktreeDir);
    if (!samePath(real, this.worktreeDir)) throw new Error("Epic worktree root resolves outside its configured path");
  }

  private async verifyActualWorktree(record: WorktreeRecord, expectedHead?: string): Promise<void> {
    const path = realpathSync(record.path);
    if (!samePath(path, record.path)) throw new Error("Epic worktree path does not match its journal");
    const top = (await this.git.run(record.path, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const branch = (await this.git.run(record.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    const head = (await this.git.run(record.path, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
    const branchHead = (await this.git.run(record.repoPath, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${record.branch}^{commit}`])).stdout.trim();
    if (!samePath(top, record.path) || branch !== record.branch || !head || head !== branchHead || (expectedHead !== undefined && head !== expectedHead)) {
      throw new Error("Epic workspace Git state does not match its managed branch");
    }
    if (expectedHead !== undefined) {
      const changes = (await this.git.run(record.path, ["status", "--porcelain", "--untracked-files=all"])).stdout;
      if (changes.trim()) throw new Error("Epic workspace recovery refuses a dirty worktree");
    }
  }
}

function validatePersistedRepository(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || !existsSync(value)) throw new Error("persisted onboarding repository is unavailable");
  try {
    const real = realpathSync(value);
    if (!lstatSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new Error("persisted onboarding repository is unavailable");
  }
}

function resolveTargetRef(onboarding: Pick<EpicRow, "facts_json" | "proposed_json">): string {
  const proposed = parseObject(onboarding.proposed_json);
  const facts = parseObject(onboarding.facts_json);
  const target = typeof proposed.defaultBranch === "string"
    ? proposed.defaultBranch
    : typeof facts.defaultBranch === "string" ? facts.defaultBranch : null;
  if (!target) throw new Error("persisted onboarding default branch is missing");
  assertSafeGitRef(target);
  return target;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
