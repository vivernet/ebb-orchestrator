import { GitCli, assertSafeGitRef } from "./git-cli.js";
import { IntegrationOutputSchema } from "@ebb-orchestrator/contracts";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
import type { Database } from "../../platform/database/database.js";
import { ExitCodeError } from "../../platform/process/process-executor.js";

/** Сохраняет cause для внутренней диагностики; message содержит только этап и allowlisted код. */
function preparationError(stage: "REFS" | "WORKTREE" | "PERSISTENCE", cause: unknown): Error {
  let diagnostic = "OTHER";
  if (cause instanceof ExitCodeError) {
    const stderrHasLine = (pattern: RegExp): boolean => cause.stderr.split(/\r?\n/u).some((line) => pattern.test(line));
    const stderrHasBoundedLine = (pattern: RegExp): boolean => cause.stderr.split(/\r?\n/u).some((line) => line.length <= 4096 && pattern.test(line));
    const fatalLines = cause.stderr.split(/\r?\n/u).filter((line) => line.length <= 4096 && line.startsWith("fatal: "));
    const fatalMessages = fatalLines.map((line) => line.slice("fatal: ".length));
    const category = stderrHasBoundedLine(/filename too long|path too long/iu) ? "PATH_TOO_LONG"
      : stderrHasLine(/^fatal: a branch named '[^'\r\n]+' already exists$/u) ? "BRANCH_EXISTS"
      : stderrHasLine(/^fatal: '\$GIT_DIR' too big$/u) ? "GIT_DIR_TOO_BIG"
      : stderrHasBoundedLine(/permission denied|access is denied/iu) ? "PERMISSION"
      : stderrHasLine(/^fatal: '[^'\r\n]+' already exists$/u) ? "WORKTREE_PATH_EXISTS"
      : stderrHasLine(/^fatal: could not create (?:leading directories of|worktree dir) '[^'\r\n]+': File exists$/iu) ? "WORKTREE_PATH_EXISTS"
      : stderrHasLine(/^fatal: '[^'\r\n]+' is already checked out at '[^'\r\n]+'$/u) ? "BRANCH_IN_USE"
      : stderrHasLine(/^fatal: invalid reference: [^\r\n]+$/u) ? "REF_NOT_FOUND"
      : stderrHasLine(/^fatal: invalid object name '[^'\r\n]+'$/u) ? "INVALID_OBJECT"
      : stderrHasLine(/^fatal: '[^'\r\n]+' is not a commit and a branch '[^'\r\n]+' cannot be created from it$/u) ? "INVALID_OBJECT"
      : stderrHasLine(/^fatal: not a git repository(?: \(or any of the parent directories\): \.git)?$/u) ? "REPOSITORY_UNAVAILABLE"
      : stderrHasLine(/^fatal: '[^'\r\n]+' is locked$/u) ? "WORKTREE_LOCKED"
      : stderrHasLine(/^fatal: refusing to create a worktree within another worktree$/iu) ? "NESTED_WORKTREE"
      : stderrHasLine(/^fatal: '[^'\r\n]+' is a nested worktree$/iu) ? "NESTED_WORKTREE"
      : fatalMessages.some((message) => /^(?:write-lock\b|(?:could not|unable to|cannot|failed to) [^\r\n]{0,80}\b(?:lock|write-lock)\b)/iu.test(message)) ? "LOCK_REJECTED"
      : fatalMessages.some((message) => /^(?:could not|unable to|cannot) (?:create|add)\b/iu.test(message)) ? "CREATE_REJECTED"
      : fatalMessages.some((message) => /^(?:invalid|unresolved) (?:ref|reference|branch)\b/iu.test(message)) ? "REFERENCE_REJECTED"
      : fatalMessages.some((message) => /\bworktree\b/iu.test(message)) ? "WORKTREE_REJECTED" : "OTHER";
    diagnostic = `GIT_EXIT_${Number.isSafeInteger(cause.exitCode) ? cause.exitCode : "UNKNOWN"}:${category}`;
  } else if (stage === "PERSISTENCE" && cause instanceof Error && "code" in cause && typeof cause.code === "string") {
    const safeCodes = ["ERR_SQLITE_ERROR", "SQLITE_CONSTRAINT", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_READONLY", "SQLITE_FULL", "SQLITE_IOERR"];
    if (safeCodes.includes(cause.code)) diagnostic = cause.code;
  }
  return new Error(`INTEGRATION_PREPARE_${stage}_FAILED:${diagnostic}`, { cause });
}

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
  /** Database после применения полного versioned migration catalog при startup. */
  database: Database;
  /** Полный путь к той же базе для Integration tooling, которое читает provenance напрямую. */
  provenanceDatabasePath?: string;
  integrationRunId?: string;
  /** Продвигает Epic target branch после Task Integration PASS; финальный Epic merge остаётся под approval. */
  advanceTargetBranch?: boolean;
  /** Проверенный worktree локальной target branch; нужен для согласованного обновления ref, index и файлов. */
  targetWorktreePath?: string;
  /** Runtime application command; `true` means the associated Run is safely terminal and its workspace may be cleaned. */
  finalizeRunFailure?: (runId: string, error: unknown) => boolean;
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
  private readonly database: Database;
  private readonly provenanceDatabasePath: string | undefined;
  private integrationRunId: string | undefined;
  private readonly finalizeRunFailure: IntegrationServiceOptions["finalizeRunFailure"];
  private readonly advanceTargetBranch: boolean;
  private readonly targetWorktreePath: string | undefined;

  constructor(options: IntegrationServiceOptions) {
    this.git = options.git ?? new GitCli();
    this.worktreeDir = options.worktreeDir ?? join(tmpdir(), "orchestrator-integration");
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch (error) {
      throw new Error("INTEGRATION_PREPARE_ROOT_CREATE_FAILED", { cause: error });
    }
    if (!options.database) throw new Error("IntegrationService requires a migrated database");
    this.database = options.database;
    this.provenanceDatabasePath = options.provenanceDatabasePath;
    this.advanceTargetBranch = options.advanceTargetBranch ?? false;
    this.targetWorktreePath = options.targetWorktreePath;
    this.integrationRunId = options.integrationRunId;
    this.finalizeRunFailure = options.finalizeRunFailure;
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
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch (error) {
      throw new Error("INTEGRATION_PREPARE_ROOT_CREATE_FAILED", { cause: error });
    }

    // Получает текущий target SHA для проверки что работаем с правильной основой
    let expectedTargetSha: string;
    let sourceSha: string;
    try {
      const targetShaResult = await this.git.run(repoPath, ["rev-parse", currentTargetBranch]);
      expectedTargetSha = targetShaResult.stdout.trim();
      sourceSha = (await this.git.run(repoPath, ["rev-parse", sourceBranch])).stdout.trim();
      if (!expectedTargetSha || !sourceSha) throw new Error("Integration refs did not resolve to commit SHAs");
    } catch (error) {
      throw preparationError("REFS", error);
    }

    // Создаёт пустую директорию hooks для отключения hooks
    let emptyHooksDir: string;
    try {
      emptyHooksDir = mkdtempSync(join(this.worktreeDir, "hooks-"));
    } catch (error) {
      throw new Error("INTEGRATION_PREPARE_HOOKS_DIR_CREATE_FAILED", { cause: error });
    }
    let preparationStage: "WORKTREE" | "PERSISTENCE" = "WORKTREE";

    try {
      // Создаёт integration branch только если такого ref ещё нет. При коллизии
      // Git должен отказать, не перемещая существующую ветку на текущий target.
      await this.git.run(repoPath, [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "worktree",
        "add",
        "-b",
        integrationBranch,
        worktreePath,
        expectedTargetSha,
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
      if (this.provenanceDatabasePath) {
        Object.defineProperty(attempt, "provenanceDatabasePath", {
          value: this.provenanceDatabasePath,
          enumerable: false,
          writable: false,
        });
      }
      preparationStage = "PERSISTENCE";
      this.database.run(`INSERT INTO integration_attempts (id, repository_path, source_branch, target_branch, expected_target_sha, source_sha, worktree_path, integration_run_id, status, created_at) VALUES ($id,$repo,$source,$target,$sha,$source_sha,$worktree,$run,$status,$created)`, { id: attempt.id, repo: attempt.repoPath, source: attempt.sourceBranch, target: attempt.currentTargetBranch, sha: attempt.expectedTargetSha, source_sha: attempt.sourceSha, worktree: attempt.worktreePath, run: attempt.integrationRunId ?? null, status: attempt.status, created: attempt.createdAt });

      return attempt;
    } catch (error) {
      // Удаляет только созданный этой попыткой, чистый и path-confined orphan.
      if (!worktreeExistedBeforeCreate) {
        await this.removeCleanOrphan(worktreePath);
      }
      throw preparationError(preparationStage, error);
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
    const persisted = this.database.get<{ integration_run_id: string | null }>(
      "SELECT integration_run_id FROM integration_attempts WHERE id = $id",
      { id: attempt.id },
    );
    if (!persisted || !integrationRunId || persisted.integration_run_id !== integrationRunId || attempt.integrationRunId !== integrationRunId ||
        (this.integrationRunId !== undefined && this.integrationRunId !== integrationRunId)) {
      throw new Error("integrationRunId does not match the persisted attempt");
    }
    this.integrationRunId = integrationRunId;
    return { ...attempt, integrationRunId };
  }

  /**
   * Завершает существующую integration attempt после восстановления исходного Run.
   * Проверяет успешный persisted output, точные SHA/provenance, ancestry и неизменный target.
   * Повторный вызов идемпотентен; не запускает runtime, merge или cleanup. При отказе
   * сохраняет attempt/worktree для reconciliation. Caller предварительно проверяет STOPPED proof.
   */
  async completeRecoveredAttempt(
    runId: string,
    expected?: { repoPath: string; sourceBranch: string; targetBranch: string },
  ): Promise<void> {
    if (!runId || this.integrationRunId !== runId) throw new Error("INTEGRATION_RECOVERY_RUN_MISMATCH");
    const attempts = this.database.all<{
      id: string; repository_path: string; source_branch: string; target_branch: string;
      expected_target_sha: string; source_sha: string; worktree_path: string;
      integration_run_id: string; status: IntegrationAttempt["status"]; created_at: string;
    }>("SELECT * FROM integration_attempts WHERE integration_run_id=$runId", { runId });
    const attempt = attempts.length === 1 ? attempts[0] : undefined;
    if (!attempt || !["MERGING", "MERGED"].includes(attempt.status) ||
        (expected && (attempt.repository_path !== expected.repoPath || attempt.source_branch !== expected.sourceBranch ||
          attempt.target_branch !== expected.targetBranch))) throw new Error("INTEGRATION_RECOVERY_PROVENANCE_MISMATCH");
    assertSafeGitRef(attempt.source_branch);
    assertSafeGitRef(attempt.target_branch);
    if (!/^[a-f0-9]{40}$/i.test(attempt.expected_target_sha) || !/^[a-f0-9]{40}$/i.test(attempt.source_sha)) {
      throw new Error("INTEGRATION_RECOVERY_PROVENANCE_MISMATCH");
    }
    const run = this.database.get<{ role: string; status: string; exit_code: number | null; ended_at: string | null; output: string | null }>(
      "SELECT role,status,exit_code,ended_at,output FROM agent_runs WHERE id=$runId", { runId });
    if (!run || run.role.toLowerCase() !== "integration" || run.status !== "COMPLETED" ||
        run.exit_code !== 0 || !run.ended_at || !run.output) throw new Error("INTEGRATION_RECOVERY_RUN_UNVERIFIED");
    let rawOutput: unknown;
    try { rawOutput = JSON.parse(run.output) as unknown; }
    catch { throw new Error("INTEGRATION_RECOVERY_OUTPUT_MISMATCH"); }
    const result = IntegrationOutputSchema.safeParse(rawOutput);
    if (!result.success || result.data.outcome !== "PASS" || result.data.baseSha !== attempt.expected_target_sha ||
        result.data.sourceSha !== attempt.source_sha || !result.data.provenance.includes(`integration_attempt:${attempt.id}`)) {
      throw new Error("INTEGRATION_RECOVERY_OUTPUT_MISMATCH");
    }
    if (!await this.isAncestor(attempt.expected_target_sha, "HEAD", attempt.worktree_path) ||
        !await this.isAncestor(attempt.source_sha, "HEAD", attempt.worktree_path)) {
      throw new Error("INTEGRATION_SNAPSHOT_MISMATCH: recovered worktree does not contain the prepared target and source commits");
    }
    const targetSha = (await this.git.run(attempt.repository_path, ["rev-parse", "--verify", "--end-of-options", `${attempt.target_branch}^{commit}`])).stdout.trim();
    const integrationHead = (await this.git.run(attempt.worktree_path, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
    if (this.advanceTargetBranch) await this.publishVerifiedTarget({
      id: attempt.id, repoPath: attempt.repository_path, currentTargetBranch: attempt.target_branch,
      expectedTargetSha: attempt.expected_target_sha, sourceSha: attempt.source_sha, worktreePath: attempt.worktree_path,
    }, integrationHead, targetSha, run.output);
    else if (targetSha !== attempt.expected_target_sha) {
      throw new Error(`TARGET_MOVED: expected ${attempt.expected_target_sha}, found ${targetSha}; restart integration`);
    }
    this.database.transaction((tx) => {
      const currentAttempts = tx.all<{ id: string; status: string }>("SELECT id,status FROM integration_attempts WHERE integration_run_id=$runId", { runId });
      const current = currentAttempts.length === 1 && currentAttempts[0]?.id === attempt.id ? currentAttempts[0] : undefined;
      const currentRun = tx.get<{ status: string; output: string | null }>("SELECT status,output FROM agent_runs WHERE id=$runId", { runId });
      if (!current || !["MERGING", "MERGED"].includes(current.status) || currentRun?.status !== "COMPLETED" || currentRun.output !== run.output) {
        throw new Error("INTEGRATION_RECOVERY_STATE_CHANGED");
      }
      tx.run("UPDATE integration_attempts SET status='MERGED' WHERE id=$id AND integration_run_id=$runId AND status='MERGING'", { id: attempt.id, runId });
    });
  }

  /**
   * Запускает реальную роль Integration только после того как изолированный worktree подготовлен.
   */
  async runInIntegrationWorktree<T>(attempt: IntegrationAttempt, runner: IntegrationRunner<T>): Promise<T> {
    if (!this.integrationRunId || !attempt.integrationRunId || attempt.integrationRunId !== this.integrationRunId) {
      throw new Error("integrationRunId is required and must be bound to the IntegrationService");
    }
    const persisted = this.database.get<{ id: string; repository_path: string; source_branch: string; target_branch: string; expected_target_sha: string; source_sha: string; worktree_path: string; created_at: string; status: IntegrationAttempt["status"]; integration_run_id: string | null }>(
      "SELECT id,repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,created_at,status,integration_run_id FROM integration_attempts WHERE id = $id", { id: attempt.id });
    if (!persisted || persisted.status !== "PREPARED" || attempt.status !== "PREPARED") throw new Error("integration attempt is not prepared");
    if (!this.matchesPersistedProvenance(attempt, persisted)) throw new Error("integration attempt does not match its immutable persisted provenance");
    const run = this.database.get<{ role: string; status: string }>("SELECT role, status FROM agent_runs WHERE id = $id", { id: attempt.integrationRunId });
    if (!run || run.role.toLowerCase() !== "integration" || !["STARTED", "IN_PROGRESS", "COMPLETING"].includes(run.status)) throw new Error("integration run is missing or inactive");
    attempt.status = "MERGING";
    this.database.run("UPDATE integration_attempts SET status = 'MERGING' WHERE id = $id AND status = 'PREPARED'", { id: attempt.id });
    const snapshot = Object.freeze({ ...attempt });
    let targetPublished = false;
    try {
      const containsExpectedTarget = await this.isAncestor(snapshot.expectedTargetSha ?? "", "HEAD", snapshot.worktreePath);
      const containsPreparedSource = await this.isAncestor(snapshot.sourceSha, "HEAD", snapshot.worktreePath);
      if (!snapshot.expectedTargetSha || !containsExpectedTarget || !containsPreparedSource) {
        throw new Error("INTEGRATION_SNAPSHOT_MISMATCH: worktree does not contain the prepared target and source commits");
      }
      // Не give the runner the live attempt record. In addition to the
      // immutable проверка ниже, этот prevents Объект in-process runner из
      // changing Объект object используемый by Объект final verification.
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
      const currentTargetSha = (await this.git.run(snapshot.repoPath, ["rev-parse", "--verify", "--end-of-options", `${snapshot.currentTargetBranch}^{commit}`])).stdout.trim();
      if (!snapshot.expectedTargetSha) throw new Error("INTEGRATION_TARGET_SHA_UNAVAILABLE");
      if (this.advanceTargetBranch) {
        const completedRun = this.database.get<{ role: string; status: string; exit_code: number | null; ended_at: string | null; output: string | null }>(
          "SELECT role,status,exit_code,ended_at,output FROM agent_runs WHERE id=$runId", { runId: this.integrationRunId },
        );
        if (!completedRun || completedRun.role.toLowerCase() !== "integration" || completedRun.status !== "COMPLETED" || completedRun.exit_code !== 0 || !completedRun.ended_at || !completedRun.output) {
          throw new Error("INTEGRATION_TARGET_PROMOTION_RUN_UNVERIFIED");
        }
        const integrationHead = (await this.git.run(snapshot.worktreePath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
        try {
          await this.publishVerifiedTarget(snapshot, integrationHead, currentTargetSha, completedRun.output);
          targetPublished = true;
        } catch (error) {
          const targetAfterAttempt = (await this.git.run(snapshot.repoPath, ["rev-parse", "--verify", "--end-of-options", `${snapshot.currentTargetBranch}^{commit}`])).stdout.trim();
          targetPublished = targetAfterAttempt === integrationHead || await this.isAncestor(integrationHead, targetAfterAttempt, snapshot.repoPath);
          throw error;
        }
      } else if (currentTargetSha !== snapshot.expectedTargetSha) {
        throw new Error(`TARGET_MOVED: expected ${snapshot.expectedTargetSha}, found ${currentTargetSha}; restart integration`);
      }
      attempt.status = "MERGED";
       this.database.run("UPDATE integration_attempts SET status = 'MERGED' WHERE id = $id", { id: attempt.id });
       return result;
    } catch (error) {
      if (targetPublished) {
        attempt.status = "MERGING";
        throw error;
      }
      attempt.status = "FAILED";
      const mayCleanup = this.failIntegration(attempt, error);
      if (mayCleanup) await this.cleanupIntegration(attempt);
      throw error;
    }
  }

  /**
   * Продвигает локальный target ref только на проверенный HEAD интеграционного worktree.
   * @remarks Precondition: persisted Integration run завершён с PASS, совпадающими target/source SHA и attempt provenance; worktree чистый и содержит оба исходных commit.
   * Публикует проверенный Integration HEAD через exact-OID `update-ref` CAS и безопасно синхронизирует только target worktree, совпадающий с исходным или целевым tree.
   * Если target уже содержит этот integration HEAD, вызов идемпотентен для crash recovery; чужое продвижение завершается `TARGET_MOVED` без перезаписи.
   */
  private async publishVerifiedTarget(
    attempt: Pick<IntegrationAttempt, "id" | "repoPath" | "currentTargetBranch" | "expectedTargetSha" | "sourceSha" | "worktreePath">,
    integrationHead: string,
    currentTargetSha: string,
    rawOutput: string,
  ): Promise<void> {
    let output: unknown;
    try { output = JSON.parse(rawOutput) as unknown; }
    catch { throw new Error("INTEGRATION_TARGET_PROMOTION_OUTPUT_INVALID"); }
    const parsed = IntegrationOutputSchema.safeParse(output);
    if (!parsed.success || parsed.data.outcome !== "PASS" || parsed.data.baseSha !== attempt.expectedTargetSha ||
        parsed.data.sourceSha !== attempt.sourceSha || !parsed.data.provenance.includes(`integration_attempt:${attempt.id}`) ||
        parsed.data.evidence.length === 0) throw new Error("INTEGRATION_TARGET_PROMOTION_OUTPUT_INVALID");
    if (!attempt.expectedTargetSha || !/^[a-f0-9]{40}$/iu.test(integrationHead) ||
        !await this.isAncestor(attempt.expectedTargetSha, integrationHead, attempt.worktreePath) ||
        !await this.isAncestor(attempt.sourceSha, integrationHead, attempt.worktreePath)) {
      throw new Error("INTEGRATION_TARGET_PROMOTION_HEAD_INVALID");
    }
    const status = await this.git.run(attempt.worktreePath, ["status", "--porcelain"]);
    if (status.stdout.trim()) throw new Error("INTEGRATION_TARGET_PROMOTION_WORKTREE_DIRTY");
    assertSafeGitRef(attempt.currentTargetBranch);
    const targetWorktreePath = this.targetWorktreePath;
    if (!targetWorktreePath) throw new Error("INTEGRATION_TARGET_WORKTREE_UNAVAILABLE");
    const targetGitCommonDir = (await this.git.run(targetWorktreePath, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const repositoryGitCommonDir = (await this.git.run(attempt.repoPath, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const targetCommonRoot = realpathSync(resolve(targetWorktreePath, targetGitCommonDir));
    const repositoryCommonRoot = realpathSync(resolve(attempt.repoPath, repositoryGitCommonDir));
    const checkedOutBranch = (await this.git.run(targetWorktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    const checkedOutHead = (await this.git.run(targetWorktreePath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
    if (targetCommonRoot !== repositoryCommonRoot || checkedOutBranch !== attempt.currentTargetBranch) {
      throw new Error("INTEGRATION_TARGET_WORKTREE_INVALID");
    }
    const alreadyPromoted = currentTargetSha === integrationHead || await this.isAncestor(integrationHead, currentTargetSha, attempt.repoPath);
    if (!alreadyPromoted && (currentTargetSha !== attempt.expectedTargetSha || checkedOutHead !== attempt.expectedTargetSha)) {
      throw new Error(`TARGET_MOVED: expected ${attempt.expectedTargetSha}, found ${currentTargetSha}; restart integration`);
    }
    if (currentTargetSha === attempt.expectedTargetSha) {
      if (!await this.targetWorktreeMatchesTree(targetWorktreePath, attempt.expectedTargetSha) || await this.targetWorktreeHasUntracked(targetWorktreePath, true)) {
        throw new Error("INTEGRATION_TARGET_WORKTREE_DIRTY");
      }
      if (await this.targetWorktreeHasConflictingUntracked(targetWorktreePath, attempt.expectedTargetSha, integrationHead)) {
        throw new Error("INTEGRATION_TARGET_WORKTREE_COLLISION");
      }
      const emptyHooksDir = mkdtempSync(join(this.worktreeDir, "hooks-ref-update-"));
      try {
        await this.git.run(attempt.repoPath, [
          "-c", `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
          "update-ref", `refs/heads/${attempt.currentTargetBranch}`, integrationHead, attempt.expectedTargetSha,
        ]);
      } catch (error) {
        const actual = (await this.git.run(attempt.repoPath, ["rev-parse", "--verify", "--end-of-options", `${attempt.currentTargetBranch}^{commit}`])).stdout.trim();
        if (actual !== attempt.expectedTargetSha) throw new Error(`TARGET_MOVED: expected ${attempt.expectedTargetSha}, found ${actual}; restart integration`, { cause: error });
        throw new Error("INTEGRATION_TARGET_PROMOTION_FAILED", { cause: error });
      } finally {
        rmSync(emptyHooksDir, { recursive: true, force: true });
      }
    }
    const verifiedTargetSha = (await this.git.run(attempt.repoPath, ["rev-parse", "--verify", "--end-of-options", `${attempt.currentTargetBranch}^{commit}`])).stdout.trim();
    if (verifiedTargetSha !== integrationHead && !await this.isAncestor(integrationHead, verifiedTargetSha, attempt.repoPath)) {
      throw new Error("TARGET_MOVED: target changed during verified promotion");
    }
    if (!await this.targetWorktreeMatchesTree(targetWorktreePath, verifiedTargetSha)) {
      if (!await this.targetWorktreeMatchesTree(targetWorktreePath, attempt.expectedTargetSha) ||
          await this.targetWorktreeHasUntracked(targetWorktreePath, true) ||
          await this.targetWorktreeHasConflictingUntracked(targetWorktreePath, attempt.expectedTargetSha, verifiedTargetSha)) {
        throw new Error("INTEGRATION_TARGET_WORKTREE_RECONCILIATION_REQUIRED");
      }
      try {
        await this.git.run(targetWorktreePath, ["read-tree", "-u", "-m", attempt.expectedTargetSha, verifiedTargetSha]);
      } catch (error) {
        throw new Error("INTEGRATION_TARGET_WORKTREE_RECONCILIATION_REQUIRED", { cause: error });
      }
    }
    const finalRef = (await this.git.run(attempt.repoPath, ["rev-parse", "--verify", "--end-of-options", `${attempt.currentTargetBranch}^{commit}`])).stdout.trim();
    const finalHead = (await this.git.run(targetWorktreePath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
    if (finalRef !== finalHead || !await this.targetWorktreeMatchesTree(targetWorktreePath, finalRef) ||
        await this.targetWorktreeHasUntracked(targetWorktreePath, true) || !await this.isAncestor(integrationHead, finalRef, attempt.repoPath)) {
      throw new Error("INTEGRATION_TARGET_PROMOTION_VERIFY_FAILED");
    }
  }

  /** Проверяет tree index, tracked files и отсутствие untracked files без изменения checkout. */
  private async targetWorktreeMatchesTree(worktreePath: string, commitSha: string): Promise<boolean> {
    const expectedTree = (await this.git.run(worktreePath, ["rev-parse", "--verify", "--end-of-options", `${commitSha}^{tree}`])).stdout.trim();
    const indexTree = (await this.git.run(worktreePath, ["write-tree"])).stdout.trim();
    if (indexTree !== expectedTree) return false;
    try {
      await this.git.run(worktreePath, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", commitSha, "--"]);
      return true;
    } catch (error) {
      if (error instanceof ExitCodeError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** Проверяет незарегистрированные файлы, не удаляя и не перезаписывая их. */
  private async targetWorktreeHasUntracked(worktreePath: string, excludeIgnored: boolean): Promise<boolean> {
    const args = ["ls-files", "--others", "--directory", "-z"];
    if (excludeIgnored) args.push("--exclude-standard");
    return Boolean((await this.git.run(worktreePath, args)).stdout);
  }

  /** Не допускает checkout поверх untracked файла или каталога, включая ignored data. */
  private async targetWorktreeHasConflictingUntracked(worktreePath: string, oldSha: string, newSha: string): Promise<boolean> {
    const untracked = (await this.git.run(worktreePath, ["ls-files", "--others", "--directory", "-z"])).stdout
      .split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/").replace(/\/$/u, ""));
    const changed = (await this.git.run(worktreePath, ["diff", "--no-renames", "--name-only", "-z", oldSha, newSha, "--"])).stdout
      .split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/"));
    let ignoreCaseSetting = "";
    try {
      ignoreCaseSetting = (await this.git.run(worktreePath, ["config", "--bool", "--get", "core.ignoreCase"])).stdout.trim();
    } catch (error) {
      if (!(error instanceof ExitCodeError) || error.exitCode !== 1) throw error;
    }
    const caseInsensitive = process.platform === "win32" || process.platform === "darwin" || ignoreCaseSetting === "true";
    const normalize = (path: string): string => caseInsensitive ? path.toLowerCase() : path;
    return untracked.some((rawUntrackedPath) => {
      const untrackedPath = normalize(rawUntrackedPath);
      return changed.some((rawChangedPath) => {
        const changedPath = normalize(rawChangedPath);
        return changedPath === untrackedPath || changedPath.startsWith(`${untrackedPath}/`) || untrackedPath.startsWith(`${changedPath}/`);
      });
    });
  }

  /**
   * Сохраняет попытку и её сбой авторизованного agent run вместе.
   */
  private failIntegration(attempt: IntegrationAttempt, error: unknown): boolean {
    this.database.run("UPDATE integration_attempts SET status = 'FAILED' WHERE id = $id", { id: attempt.id });
    if (!attempt.integrationRunId) return true;
    try {
      return this.finalizeRunFailure?.(attempt.integrationRunId, error) === true;
    } catch {
      return false;
    }
  }

  /**
   * Слияет подготовленный commit задачи перед запуском Integration Agent.
   */
  async mergePreparedSource(attempt: IntegrationAttempt): Promise<void> {
    const persisted = this.database.get<{ id: string; repository_path: string; source_branch: string; target_branch: string; expected_target_sha: string; source_sha: string; worktree_path: string; created_at: string; status: IntegrationAttempt["status"]; integration_run_id: string | null }>(
      "SELECT id,repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,created_at,status,integration_run_id FROM integration_attempts WHERE id = $id", { id: attempt.id });
    if (!persisted || persisted.status !== "PREPARED" || attempt.status !== "PREPARED") {
      throw new Error("integration attempt is not prepared");
    }
    if (!this.matchesPersistedProvenance(attempt, persisted)) throw new Error("integration attempt does not match its immutable persisted provenance");
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
        attempt.sourceSha,
      ]);
    } finally {
      rmSync(emptyHooksDir, { recursive: true, force: true });
    }
    const mergedSha = (await this.git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    const containsExpectedTarget = await this.isAncestor(attempt.expectedTargetSha ?? "", "HEAD", attempt.worktreePath);
    const containsPreparedSource = await this.isAncestor(attempt.sourceSha, "HEAD", attempt.worktreePath);
    if (!mergedSha || mergedSha === attempt.expectedTargetSha || !containsExpectedTarget || !containsPreparedSource) {
      throw new Error("INTEGRATION_SOURCE_NOT_MERGED: prepared worktree does not contain the source commit");
    }
  }

  private matchesPersistedProvenance(
    attempt: IntegrationAttempt,
    persisted: { id: string; repository_path: string; source_branch: string; target_branch: string; expected_target_sha: string; source_sha: string; worktree_path: string; created_at: string; integration_run_id: string | null },
  ): boolean {
    return persisted.id === attempt.id && persisted.repository_path === attempt.repoPath &&
      persisted.source_branch === attempt.sourceBranch && persisted.target_branch === attempt.currentTargetBranch &&
      persisted.expected_target_sha === attempt.expectedTargetSha && persisted.source_sha === attempt.sourceSha &&
      persisted.worktree_path === attempt.worktreePath && persisted.created_at === attempt.createdAt &&
      persisted.integration_run_id === (attempt.integrationRunId ?? null);
  }

  private async isAncestor(ancestor: string, descendant: string, worktreePath: string): Promise<boolean> {
    if (!ancestor) return false;
    try {
      await this.git.run(worktreePath, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
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
    const canonical = (value: string): string => {
      try { return realpathSync(value); } catch { return resolve(value); }
    };
    const root = canonical(this.worktreeDir);
    const candidate = canonical(worktreePath);
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
