import { GitCli } from "./git-cli.js";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
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

export interface IntegrationServiceOptions {
  git?: GitCli;
  worktreeDir?: string;
  database?: Database;
  integrationRunId?: string;
}

/**
 * Инкапсулирует операцию Git integration-service с журналированием и проверкой целевого repository/worktree.
 */
export function getIntegrationProvenance(db: Database, attempt: IntegrationAttempt): VerifiedIntegrationProvenance | null {
  const row = db.get<{ id: string; source_branch: string; target_branch: string; repository_path: string; expected_target_sha: string; source_sha: string; worktree_path: string; status: IntegrationAttempt["status"]; created_at: string; integration_run_id: string | null }>("SELECT * FROM integration_attempts WHERE id = $id", { id: attempt.id });
  if (!row || row.status !== "MERGED" || attempt.status !== "MERGED" || !attempt.integrationRunId || row.integration_run_id !== attempt.integrationRunId || row.source_branch !== attempt.sourceBranch || row.target_branch !== attempt.currentTargetBranch || row.repository_path !== attempt.repoPath || row.expected_target_sha !== attempt.expectedTargetSha || row.source_sha !== attempt.sourceSha || row.worktree_path !== attempt.worktreePath || row.created_at !== attempt.createdAt) return null;
  return { snapshot: Object.freeze({ ...attempt }), identity: `${row.id}:${row.repository_path}:${row.target_branch}:${row.source_branch}` };
}

export type IntegrationRunner<T> = (worktreePath: string, attempt: Readonly<IntegrationAttempt>) => Promise<T>;

/**
 * IntegrationService управляет подготовкой интеграционных пространств.
 * 
 * Ключевые свойства:
 * - Использует временный интеграционный branch/worktree принадлежащий попытке интеграции
 * - Никогда не экспериментирует в Task worktree или master
 * - Проверяет текущий target SHA перед подготовкой интеграции
 */
export class IntegrationService {
  private readonly git: GitCli;
  private readonly worktreeDir: string;
  private database: Database;
  private databasePath: string;
  private databaseClosed = false;
  private readonly ownsDatabase: boolean;
  private integrationRunId: string | undefined;

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
   * Подготавливает интеграционное пространство для слияния sourceBranch в currentTargetBranch.
   * 
   * Создаёт выделенный интеграционный worktree который:
   * - Основан на текущем target branch (обрабатывает движущийся target)
   * - Может безопасно выполнять операции слияния не затрагивая master или task worktrees
   * - Принадлежит этой попытке интеграции и должен быть удалён после использования
   */
  async prepareIntegration(
    sourceBranch: string,
    currentTargetBranch: string,
    repoPath: string
  ): Promise<IntegrationAttempt> {
    const attemptId = `integration-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const integrationBranch = `integration/${attemptId}`;
    const worktreePath = join(this.worktreeDir, attemptId);
    const worktreeExistedBeforeCreate = existsSync(worktreePath);

    // Гарантирует существование директории worktree
    mkdirSync(this.worktreeDir, { recursive: true });

    // Получает текущий target SHA для проверки что работаем с правильной основой
    const targetShaResult = await this.git.run(repoPath, ["rev-parse", currentTargetBranch]);
    const expectedTargetSha = targetShaResult.stdout.trim();
    const sourceSha = (await this.git.run(repoPath, ["rev-parse", sourceBranch])).stdout.trim();

    // Создаёт пустую директорию hooks для отключения hooks
    const emptyHooksDir = mkdtempSync(join(this.worktreeDir, "hooks-"));

    try {
      // Создаёт worktree с интеграционным branch напрямую из target branch
      // Используя -B для принудительного создания/чекута если branch существует
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
      // Удаляет только созданный этой попыткой, чистый и path-confined orphan.
      if (!worktreeExistedBeforeCreate) {
        await this.removeCleanOrphan(worktreePath);
      }
      throw error;
    } finally {
      // Очищает пустую директорию hooks
      try {
        rmSync(emptyHooksDir, { recursive: true, force: true });
      } catch {
        // Пропускаем ошибки очистки
      }
    }
  }

  /**
   * Связывает уже созданный интеграционный workspace с авторизованным run.
   */
  bindIntegrationRun(attempt: IntegrationAttempt, integrationRunId: string): IntegrationAttempt {
    if (this.databaseClosed) throw new Error("Integration database is closed");
    this.integrationRunId = integrationRunId;
    this.database.run("UPDATE integration_attempts SET integration_run_id = $run WHERE id = $id", { id: attempt.id, run: integrationRunId });
    return { ...attempt, integrationRunId };
  }

  /**
   * Запускает реальную роль Integration только после того как изолированный worktree подготовлен.
   */
  async runInIntegrationWorktree<T>(attempt: IntegrationAttempt, runner: IntegrationRunner<T>): Promise<T> {
    if (!this.integrationRunId || !attempt.integrationRunId || attempt.integrationRunId !== this.integrationRunId) {
      throw new Error("integrationRunId is required and must be bound to the IntegrationService");
    }
    if (this.databaseClosed || (this.ownsDatabase && attempt.provenanceDatabasePath && attempt.provenanceDatabasePath !== this.databasePath)) {
      if (!this.databaseClosed && this.ownsDatabase) this.database.close();
      const provenancePath = attempt.provenanceDatabasePath ?? this.databasePath;
      this.databasePath = provenancePath;
      this.database = createSqliteDatabase(this.databasePath);
      this.databaseClosed = false;
    }
    const persisted = this.database.get<{ status: IntegrationAttempt["status"]; integration_run_id: string }>("SELECT status, integration_run_id FROM integration_attempts WHERE id = $id", { id: attempt.id });
    if (!persisted || persisted.status !== "PREPARED" || attempt.status !== "PREPARED") throw new Error("integration attempt is not prepared");
    if (persisted.integration_run_id !== attempt.integrationRunId) throw new Error("integrationRunId is not bound to the integration attempt");
    const run = this.database.get<{ role: string; status: string }>("SELECT role, status FROM agent_runs WHERE id = $id", { id: attempt.integrationRunId });
    if (!run || run.role.toLowerCase() !== "integration" || !["STARTED", "IN_PROGRESS", "COMPLETING"].includes(run.status)) throw new Error("integration run is missing or inactive");
    attempt.status = "MERGING";
    this.database.run("UPDATE integration_attempts SET status = 'MERGING' WHERE id = $id AND status = 'PREPARED'", { id: attempt.id });
    const snapshot = Object.freeze({ ...attempt });
    try {
      // Не give the runner the live attempt record. In addition to the
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
      // Целевой branch мог переместиться пока выполнялась роль Integration. Выполняем
      // эту проверку здесь, а не оставляем её конечному вызывающему.
      const currentTargetSha = (await this.git.run(snapshot.repoPath, ["rev-parse", snapshot.currentTargetBranch])).stdout.trim();
      if (!snapshot.expectedTargetSha || currentTargetSha !== snapshot.expectedTargetSha) {
        throw new Error(`TARGET_MOVED: expected ${snapshot.expectedTargetSha ?? "a verified target"}, found ${currentTargetSha}; restart integration`);
      }
      attempt.status = "MERGED";
       this.database.run("UPDATE integration_attempts SET status = 'MERGED' WHERE id = $id", { id: attempt.id });
       if (this.ownsDatabase) { this.database.close(); this.databaseClosed = true; }
       return result;
    } catch (error) {
      attempt.status = "FAILED";
      this.failIntegration(attempt, error);
      await this.cleanupIntegration(attempt);
      if (this.ownsDatabase) { this.database.close(); this.databaseClosed = true; }
      throw error;
    }
  }

  /**
   * Сохраняет попытку и её сбой авторизованного agent run вместе.
   */
  private failIntegration(attempt: IntegrationAttempt, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = JSON.stringify({
      type: "INTEGRATION_RECONCILIATION_FAILURE",
      attemptId: attempt.id,
      integrationRunId: attempt.integrationRunId ?? null,
      message,
    });
    this.database.transaction((tx) => {
      tx.run("UPDATE integration_attempts SET status = 'FAILED' WHERE id = $id", { id: attempt.id });
      if (attempt.integrationRunId) {
        tx.run(
          `UPDATE agent_runs SET status = 'FAILED', output = $output,
            ended_at = $ended_at, exit_code = -1
            WHERE id = $id AND role = 'Integration'
              AND status IN ('STARTED', 'IN_PROGRESS', 'COMPLETING')`,
          { id: attempt.integrationRunId, output: diagnostics, ended_at: new Date().toISOString() },
        );
      }
    });
  }

  /**
   * Слияет подготовленный commit задачи перед запуском Integration Agent.
   */
  async mergePreparedSource(attempt: IntegrationAttempt): Promise<void> {
    if (this.databaseClosed) throw new Error("Integration database is closed");
    const persisted = this.database.get<{ status: IntegrationAttempt["status"]; integration_run_id: string | null }>(
      "SELECT status, integration_run_id FROM integration_attempts WHERE id = $id", { id: attempt.id });
    if (!persisted || persisted.status !== "PREPARED" || attempt.status !== "PREPARED") {
      throw new Error("integration attempt is not prepared");
    }
    if (persisted.integration_run_id !== (attempt.integrationRunId ?? null)) {
      throw new Error("integrationRunId is not bound to the integration attempt");
    }
    const targetSha = (await this.git.run(attempt.repoPath, ["rev-parse", attempt.currentTargetBranch])).stdout.trim();
    if (targetSha !== attempt.expectedTargetSha) {
      throw new Error(`TARGET_MOVED: expected ${attempt.expectedTargetSha ?? "a verified target"}, found ${targetSha}; restart integration`);
    }
    const emptyHooksDir = mkdtempSync(join(this.worktreeDir, "hooks-merge-"));
    try {
      await this.git.run(attempt.worktreePath, [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "merge",
        "--no-edit",
        attempt.sourceBranch,
      ]);
    } finally {
      rmSync(emptyHooksDir, { recursive: true, force: true });
    }
    const mergedSha = (await this.git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    if (!mergedSha || mergedSha === attempt.expectedTargetSha) {
      throw new Error("INTEGRATION_SOURCE_NOT_MERGED: prepared worktree does not contain the source commit");
    }
  }

  /**
   * Очищает попытку интеграции удаляя её worktree.
   */
  async cleanupIntegration(attempt: IntegrationAttempt): Promise<void> {
    this.assertManagedWorktreePath(attempt.worktreePath);
    const status = await this.git.run(attempt.worktreePath, ["status", "--porcelain"]);
    if (status.stdout.trim() !== "") {
      throw new Error(
        `Cannot remove dirty integration worktree: ${attempt.worktreePath}. ` +
        `The worktree has uncommitted changes. Commit or stash changes before cleanup.`
      );
    }
    await this.git.run(attempt.repoPath, ["worktree", "remove", attempt.worktreePath]);
  }

  /** Не позволяет cleanup удалить произвольный путь из недоверенной попытки. */
  private assertManagedWorktreePath(worktreePath: string): void {
    const root = resolve(this.worktreeDir);
    const candidate = resolve(worktreePath);
    const relativePath = relative(root, candidate);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Integration worktree path is outside the managed root: ${worktreePath}`);
    }
  }

  /** Удаляет только подтверждённо чистый orphan внутри managed root. */
  private async removeCleanOrphan(worktreePath: string): Promise<void> {
    try {
      this.assertManagedWorktreePath(worktreePath);
      const root = realpathSync(this.worktreeDir);
      const candidateStat = lstatSync(worktreePath);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return;
      const candidate = realpathSync(worktreePath);
      const candidateRelative = relative(root, candidate);
      if (!candidateRelative || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) return;
      if (this.containsSymlink(worktreePath)) return;

      const entries = readdirSync(worktreePath);
      if (entries.length > 0) {
        const status = await this.git.run(worktreePath, ["status", "--porcelain"]);
        if (status.stdout.trim() !== "") return;
      }

      this.assertManagedWorktreePath(worktreePath);
      const finalStat = lstatSync(worktreePath);
      if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || this.containsSymlink(worktreePath)) return;
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Ошибка проверки или Git оставляет orphan для ручного recovery.
    }
  }

  private containsSymlink(directory: string): boolean {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return true;
      if (stat.isDirectory() && this.containsSymlink(path)) return true;
    }
    return false;
  }
}
