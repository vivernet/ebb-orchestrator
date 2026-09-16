import { GitCli } from "./git-cli.js";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import type { Database } from "../../platform/database/database.js";
import { createSqliteDatabase } from "../../platform/database/sqlite-database.js";
import { readFileSync } from "node:fs";

export interface IntegrationAttempt {
  id: string;
  sourceBranch: string;
  currentTargetBranch: string;
  expectedTargetBranch: string;
  worktreePath: string;
  repoPath: string;
  expectedTargetSha: string | null;
  sourceSha: string;
  status: "PREPARED" | "MERGING" | "MERGED" | "FAILED";
  createdAt: string;
  integrationRunId?: string;
  provenanceDatabasePath?: string;
}

interface IntegrationSnapshot {
  readonly id: string;
  readonly sourceBranch: string;
  readonly currentTargetBranch: string;
  readonly expectedTargetBranch: string;
  readonly worktreePath: string;
  readonly repoPath: string;
  readonly expectedTargetSha: string | null;
  readonly sourceSha: string;
  readonly createdAt: string;
  readonly integrationRunId?: string;
}

export interface VerifiedIntegrationProvenance {
  readonly snapshot: Readonly<IntegrationSnapshot>;
  readonly identity: string;
}

export function getVerifiedIntegrationProvenance(
  _attempt: IntegrationAttempt
): VerifiedIntegrationProvenance | null {
  return null;
}

export interface IntegrationServiceOptions {
  git?: GitCli;
  worktreeDir?: string;
  database?: Database;
  integrationRunId?: string;
}

export function getIntegrationProvenance(db: Database, attempt: IntegrationAttempt): VerifiedIntegrationProvenance | null {
  const row = db.get<{ id: string; source_branch: string; target_branch: string; repository_path: string; expected_target_sha: string; source_sha: string; worktree_path: string; status: IntegrationAttempt["status"]; created_at: string; integration_run_id: string | null }>("SELECT * FROM integration_attempts WHERE id = $id", { id: attempt.id });
  if (!row || row.status !== "MERGED" || attempt.status !== "MERGED" || !attempt.integrationRunId || row.integration_run_id !== attempt.integrationRunId || row.source_branch !== attempt.sourceBranch || row.target_branch !== attempt.currentTargetBranch || row.repository_path !== attempt.repoPath || row.expected_target_sha !== attempt.expectedTargetSha || row.source_sha !== attempt.sourceSha || row.worktree_path !== attempt.worktreePath || row.created_at !== attempt.createdAt) return null;
  return { snapshot: Object.freeze({ ...attempt }), identity: `${row.id}:${row.repository_path}:${row.target_branch}:${row.source_branch}` };
}

export type IntegrationRunner<T> = (worktreePath: string, attempt: Readonly<IntegrationAttempt>) => Promise<T>;

/**
 * IntegrationService manages the preparation of integration workspaces.
 * 
 * Key properties:
 * - Uses temporary integration branch/worktree owned by the integration attempt
 * - Never experiments in the Task worktree or master
 * - Verifies current target SHA before preparing integration
 */
export class IntegrationService {
  private readonly git: GitCli;
  private readonly worktreeDir: string;
  private database: Database;
  private databasePath: string;
  private databaseClosed = false;
  private readonly ownsDatabase: boolean;
  private readonly integrationRunId: string | undefined;

  constructor(options: IntegrationServiceOptions = {}) {
    this.git = options.git ?? new GitCli();
    this.worktreeDir = options.worktreeDir ?? join(tmpdir(), "orchestrator-integration");
    mkdirSync(this.worktreeDir, { recursive: true });
    this.databasePath = join(this.worktreeDir, "integration-provenance.sqlite");
    this.ownsDatabase = !options.database;
    this.database = options.database ?? createSqliteDatabase(this.databasePath);
    this.integrationRunId = options.integrationRunId;
    this.database.exec(readFileSync(new URL("../../platform/database/migrations/009_integration_provenance.sql", import.meta.url), "utf8"));
    const columns = this.database.all<{ name: string }>("PRAGMA table_info(integration_attempts)");
    if (!columns.some((column) => column.name === "source_sha")) this.database.exec("ALTER TABLE integration_attempts ADD COLUMN source_sha TEXT NOT NULL DEFAULT ''");
  }

  /**
   * Prepares an integration workspace for merging sourceBranch into currentTargetBranch.
   * 
   * Creates a dedicated integration worktree that:
   * - Is based on the current target branch (handles moving target)
   * - Can safely perform merge operations without affecting master or task worktrees
   * - Is owned by this integration attempt and should be cleaned up after use
   */
  async prepareIntegration(
    sourceBranch: string,
    currentTargetBranch: string,
    repoPath: string
  ): Promise<IntegrationAttempt> {
    const attemptId = `integration-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const integrationBranch = `integration/${attemptId}`;
    const worktreePath = join(this.worktreeDir, attemptId);

    // Ensure worktree directory exists
    mkdirSync(this.worktreeDir, { recursive: true });

    // Get current target SHA to verify we're working from the right base
    const targetShaResult = await this.git.run(repoPath, ["rev-parse", currentTargetBranch]);
    const expectedTargetSha = targetShaResult.stdout.trim();
    const sourceSha = (await this.git.run(repoPath, ["rev-parse", sourceBranch])).stdout.trim();

    // Create empty hooks directory to disable hooks
    const emptyHooksDir = join(this.worktreeDir, `hooks-${Date.now()}`);
    mkdirSync(emptyHooksDir, { recursive: true });

    try {
      // Create worktree with integration branch directly from target branch
      // Using -B to force creation/checkout if branch exists
      await this.git.run(repoPath, [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "worktree",
        "add",
        "-B",
        integrationBranch,
        worktreePath,
        currentTargetBranch,
      ]);

      const attempt: IntegrationAttempt = {
        id: attemptId,
        sourceBranch,
        currentTargetBranch,
        expectedTargetBranch: currentTargetBranch,
        worktreePath,
        repoPath,
        expectedTargetSha,
        sourceSha,
        status: "PREPARED",
          createdAt: new Date().toISOString(),
          ...(this.integrationRunId ? { integrationRunId: this.integrationRunId } : {}),
        };
      Object.defineProperty(attempt, "provenanceDatabasePath", { value: join(this.worktreeDir, "integration-provenance.sqlite"), enumerable: false, writable: false });
      this.database.run(`INSERT INTO integration_attempts (id, repository_path, source_branch, target_branch, expected_target_sha, source_sha, worktree_path, integration_run_id, status, created_at) VALUES ($id,$repo,$source,$target,$sha,$source_sha,$worktree,$run,$status,$created)`, { id: attempt.id, repo: attempt.repoPath, source: attempt.sourceBranch, target: attempt.currentTargetBranch, sha: attempt.expectedTargetSha, source_sha: attempt.sourceSha, worktree: attempt.worktreePath, run: attempt.integrationRunId ?? null, status: attempt.status, created: attempt.createdAt });
      if (this.ownsDatabase) { this.database.close(); this.databaseClosed = true; }

      return attempt;
    } catch (error) {
      // Clean up partial worktree on failure
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    } finally {
      // Clean up empty hooks directory
      try {
        rmSync(emptyHooksDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /** Run the real Integration role only after the isolated worktree is prepared. */
  async runInIntegrationWorktree<T>(attempt: IntegrationAttempt, runner: IntegrationRunner<T>): Promise<T> {
    if (this.databaseClosed || (attempt.provenanceDatabasePath && attempt.provenanceDatabasePath !== this.databasePath)) {
      if (!this.databaseClosed && this.ownsDatabase) this.database.close();
      const provenancePath = attempt.provenanceDatabasePath ?? this.databasePath;
      this.databasePath = provenancePath;
      this.database = createSqliteDatabase(this.databasePath);
      this.databaseClosed = false;
    }
    const persisted = this.database.get<{ status: IntegrationAttempt["status"]; integration_run_id: string }>("SELECT status, integration_run_id FROM integration_attempts WHERE id = $id", { id: attempt.id });
    if (!persisted || persisted.status !== "PREPARED" || attempt.status !== "PREPARED") throw new Error("integration attempt is not prepared");
    if (attempt.integrationRunId) {
      if (persisted.integration_run_id !== attempt.integrationRunId) throw new Error("integrationRunId is required for integration provenance");
      const run = this.database.get<{ role: string; status: string }>("SELECT role, status FROM agent_runs WHERE id = $id", { id: attempt.integrationRunId });
      if (!run || run.role.toLowerCase() !== "integration" || !["STARTED", "IN_PROGRESS", "COMPLETING"].includes(run.status)) throw new Error("integration run is missing or inactive");
    }
    attempt.status = "MERGING";
    this.database.run("UPDATE integration_attempts SET status = 'MERGING' WHERE id = $id AND status = 'PREPARED'", { id: attempt.id });
    const snapshot = Object.freeze({ ...attempt });
    try {
      // Do not give the runner the live attempt record. In addition to the
      // immutable check below, this prevents an in-process runner from
      // changing the object used by the final verification.
      const runnerAttempt = Object.freeze({ ...attempt });
      let result: T;
      try {
        result = await runner(snapshot.worktreePath, runnerAttempt);
      } catch (error) {
        if (error instanceof TypeError && /read only|readonly|frozen/i.test(error.message)) {
          throw new Error("INTEGRATION_PROVENANCE_MUTATED: runner changed the integration attempt", { cause: error });
        }
        throw error;
      }
      const provenanceChanged = [
        [attempt.id, snapshot.id],
        [attempt.sourceBranch, snapshot.sourceBranch],
        [attempt.currentTargetBranch, snapshot.currentTargetBranch],
        [attempt.expectedTargetBranch, snapshot.expectedTargetBranch],
        [attempt.worktreePath, snapshot.worktreePath],
        [attempt.repoPath, snapshot.repoPath],
        [attempt.expectedTargetSha, snapshot.expectedTargetSha],
        [attempt.sourceSha, snapshot.sourceSha],
        [attempt.createdAt, snapshot.createdAt],
      ].some(([actual, expected]) => actual !== expected);
      if (provenanceChanged) {
        throw new Error("INTEGRATION_PROVENANCE_MUTATED: runner changed the integration attempt");
      }
      // The target may have moved while the integration role was running.  Do
      // this check here, rather than leaving it to an end-to-end caller.
      const currentTargetSha = (await this.git.run(snapshot.repoPath, ["rev-parse", snapshot.currentTargetBranch])).stdout.trim();
      if (!snapshot.expectedTargetSha || currentTargetSha !== snapshot.expectedTargetSha) {
        attempt.status = "FAILED";
        this.database.run("UPDATE integration_attempts SET status = 'FAILED' WHERE id = $id", { id: attempt.id });
        throw new Error(`TARGET_MOVED: expected ${snapshot.expectedTargetSha ?? "a verified target"}, found ${currentTargetSha}; restart integration`);
      }
      attempt.status = "MERGED";
       this.database.run("UPDATE integration_attempts SET status = 'MERGED' WHERE id = $id", { id: attempt.id });
       if (this.ownsDatabase) { this.database.close(); this.databaseClosed = true; }
       return result;
    } catch (error) {
      attempt.status = "FAILED";
      this.database.run("UPDATE integration_attempts SET status = 'FAILED' WHERE id = $id", { id: attempt.id });
      if (this.ownsDatabase) { this.database.close(); this.databaseClosed = true; }
      throw error;
    }
  }

  /**
   * Cleans up an integration attempt by removing its worktree.
   */
  async cleanupIntegration(attempt: IntegrationAttempt): Promise<void> {
    try {
      // Remove worktree directory
      rmSync(attempt.worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
