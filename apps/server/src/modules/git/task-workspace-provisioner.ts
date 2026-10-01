import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Database } from "../../platform/database/database.js";
import { assertSafeGitRef } from "./git-cli.js";
import { WorktreeManager } from "./worktree-manager.js";

export interface TaskWorkspaceProvisionerOptions {
  database: Database;
  worktreeManager: WorktreeManager;
}

interface OnboardingRow {
  repository_path: string;
  facts_json: string;
  proposed_json: string;
}

interface TaskRow {
  id: string;
  project_id: string;
}

interface EpicProvisioningRow {
  id: string;
  project_id: string;
  display_id: string;
}

/**
 * Создаёт authoritative task worktree до запуска Epic integration.
 *
 * Репозиторий и target ref разрешаются только из активного approved onboarding.
 * Повторный вызов безопасен: уже проверенный journal/worktree считается готовым,
 * а незавершённая операция требует reconciliation и не перезаписывается.
 */
export class TaskWorkspaceProvisioner {
  private readonly db: Database;
  private readonly worktrees: WorktreeManager;

  constructor(options: TaskWorkspaceProvisionerOptions) {
    this.db = options.database;
    this.worktrees = options.worktreeManager;
  }

  /** Гарантирует persisted worktree/branch для всех child tasks Epic. */
  async provisionForEpic(epicId: string): Promise<void> {
    const epic = this.db.get<EpicProvisioningRow>(
      "SELECT id,project_id,display_id FROM epics WHERE id=$epicId",
      { epicId },
    );
    if (!epic) throw new Error(`Epic ${epicId} not found`);

    const onboarding = this.db.get<OnboardingRow>(
      `SELECT oc.repository_path, oc.facts_json, oc.proposed_json
         FROM onboarding_configs oc
         JOIN approvals a ON a.id=oc.approval_id
        WHERE oc.project_id=$projectId AND oc.status='ACTIVE'
          AND a.subject_type='PROJECT' AND a.subject_id=oc.project_id
          AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'`,
      { projectId: epic.project_id },
    );
    if (!onboarding) throw new Error("active approved onboarding is required");

    const repoPath = validatePersistedRepository(onboarding.repository_path);
    const epicBranch = `epic/${epic.display_id}`;
    assertSafeGitRef(epicBranch);
    const baseRef = resolveTargetRef(onboarding);
    const epicWorktrees = this.db.all<{ repo_path: string; path: string; branch: string; removed_at: string | null }>(
      `SELECT w.repo_path,w.path,w.branch,w.removed_at
         FROM worktrees w
        WHERE w.id=$worktreeId`,
      { worktreeId: `epic:${epic.id}` },
    );
    const epicOperations = this.db.all<{ type: string; status: string; repo_path: string; branch_name: string | null; worktree_id: string | null; target_ref: string | null }>(
      `SELECT type,status,repo_path,branch_name,worktree_id,target_ref FROM git_operations
        WHERE worktree_id=$worktreeId ORDER BY created_at`,
      { worktreeId: `epic:${epic.id}` },
    );
    const epicWorktree = epicWorktrees[0];
    const epicOperation = epicOperations[0];
    if (epicWorktrees.length !== 1 || epicOperations.length !== 1 || !epicWorktree || !epicOperation
      || epicWorktree.removed_at !== null || epicWorktree.repo_path !== repoPath || epicWorktree.branch !== epicBranch
      || epicOperation.type !== "CREATE_WORKTREE" || epicOperation.status !== "VERIFIED"
      || epicOperation.repo_path !== repoPath || epicOperation.branch_name !== epicBranch
      || epicOperation.worktree_id !== `epic:${epic.id}` || epicOperation.target_ref !== baseRef) {
      throw new Error("verified managed Epic workspace is required before child task provisioning");
    }
    const targetRef = epicBranch;
    const tasks = this.db.all<TaskRow>(
      "SELECT id,project_id FROM tasks WHERE epic_id=$epicId ORDER BY display_id",
      { epicId },
    );
    if (tasks.length === 0) throw new Error(`Epic ${epicId} has no tasks`);

    for (const task of tasks) {
      if (task.project_id !== epic.project_id) throw new Error(`Task ${task.id} project mismatch`);
      await this.provisionTask(task.id, repoPath, targetRef);
    }
  }

  private async provisionTask(taskId: string, repoPath: string, targetRef: string): Promise<void> {
    const branch = `task/${taskId}`;
    const existingOperations = this.db.all<{
      id: string;
      status: string;
      repo_path: string;
      branch_name: string | null;
      target_ref: string | null;
    }>(
      `SELECT id,status,repo_path,branch_name,target_ref
        FROM git_operations
        WHERE repo_path=$repoPath AND branch_name=$branch AND worktree_id=$taskId
        ORDER BY created_at`,
      { repoPath, branch, taskId },
    );
    if (existingOperations.length > 1) throw new Error(`Task ${taskId} has multiple Git provisioning operations`);
    const existing = existingOperations[0];

    if (existing) {
      if (existing.status !== "STARTED" && existing.status !== "VERIFIED") {
        throw new Error(`Task ${taskId} has an unfinished Git provisioning operation`);
      }
      if (existing.repo_path !== repoPath || existing.branch_name !== branch || existing.target_ref !== targetRef) {
        throw new Error(`Task ${taskId} has a persisted Git provisioning mismatch`);
      }
      // Re-run the journal and actual Git-state checks for VERIFIED entries too;
      // the persisted status alone is not proof that the worktree still matches.
      await this.worktrees.createTaskWorkspace(taskId, repoPath, existing.target_ref);
      return;
    }

    await this.worktrees.createTaskWorkspace(taskId, repoPath, targetRef);
  }
}

function validatePersistedRepository(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || !existsSync(value)) {
    throw new Error("persisted onboarding repository is unavailable");
  }
  try {
    const real = realpathSync(value);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new Error("persisted onboarding repository is unavailable");
  }
}

function resolveTargetRef(onboarding: OnboardingRow): string {
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
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
