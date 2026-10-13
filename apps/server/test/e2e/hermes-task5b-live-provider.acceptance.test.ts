import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RunService, createRunContextInput } from "../../src/modules/runtime/run-service.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";
import { HermesRuntimeAdapter } from "../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { ProcessExecutor } from "../../src/platform/process/process-executor.js";
import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import { createProductionPaths } from "../../src/platform/home/production-paths.js";
import { isAuthoritativeRunProcessStopEvidence } from "../../src/modules/runtime/run-process-owner.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { OnboardingService } from "../../src/modules/projects/onboarding-service.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";

const ACCEPTANCE_MARKER = "I_UNDERSTAND_THIS_SENDS_A_REAL_PROVIDER_REQUEST";
const enabled = process.env.EBB_RUN_TASK5B_LIVE_PROVIDER_ACCEPTANCE === ACCEPTANCE_MARKER;
const resolvePackage = createRequire(import.meta.url).resolve;
const tsxLoader = pathToFileURL(resolvePackage("tsx")).href;
const mcpCli = resolve(import.meta.dirname, "../../src/bin/ebb-orchestrator-mcp.ts");
const workspace = resolve(import.meta.dirname, "../../../..");
const wait = (milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

/** Возвращает только заранее разрешённые диагностические коды Hermes, не текст исключения целиком. */
function safeHermesFailure(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const message = current.message;
    if (/^HERMES_SESSION_STREAM_INVALID:[A-Z0-9_]+(?::EXIT_-?\d+)?(?::CATEGORY_(EMPTY|AUTH|RATE_LIMIT|NETWORK|TIMEOUT|MCP|PROCESS_ERROR|OTHER))?$/.test(message) ||
        /^HERMES_PYTHON_STARTUP_EXCEPTION:(ModuleNotFoundError|ImportError|PermissionError|FileNotFoundError|OSError|RuntimeError|ValueError|TypeError|AttributeError|KeyError|SyntaxError|NameError|UnicodeDecodeError|UnicodeEncodeError)$/u.test(message) ||
        message === "HERMES_EBB_MCP_REGISTRATION_FAILED" ||
        /^HERMES_ACTIVE_SESSION_REFUSED:(SESSION_NOT_OWNED|MAX_CONCURRENT_SESSIONS|SESSION_COORDINATION_UNAVAILABLE)$/u.test(message) ||
        message === "HERMES_SESSION_STREAM_INVALID" ||
        message === "HERMES_RUN_SELECTION_UNAVAILABLE" ||
        message === "HERMES_SESSION_CAPTURE_CALLBACK_FAILED") {
      return message;
    }
    current = current.cause;
  }
  return undefined;
}

interface RestartReadback {
  runStatus: string;
  sessionId: string | null;
  captureState: string;
  ownerState: string;
}

/** Reopens production persistence and composition in a fresh Orchestrator process. */
function readSessionAfterOrchestratorRestart(
  dbPath: string,
  orchestratorHome: string,
  runId: string,
  preloadPath?: string,
): Promise<RestartReadback> {
  const databaseModule = pathToFileURL(resolve(import.meta.dirname, "../../src/platform/database/sqlite-database.ts")).href;
  const compositionModule = pathToFileURL(resolve(import.meta.dirname, "../../src/platform/home/production-composition.ts")).href;
  const homeModule = pathToFileURL(resolve(import.meta.dirname, "../../src/platform/home/orchestrator-home.ts")).href;
  const source = [
    `const { createSqliteDatabase } = await import(${JSON.stringify(databaseModule)});`,
    `const { createProductionComposition } = await import(${JSON.stringify(compositionModule)});`,
    `const { resolveOrchestratorHome } = await import(${JSON.stringify(homeModule)});`,
    `const database = createSqliteDatabase(process.argv[1]);`,
    `try {`,
    `  const home = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: process.argv[2] }, process.platform);`,
    `  createProductionComposition({ database, home });`,
    `  const row = database.get("SELECT run.status AS runStatus,run.session_id AS sessionId,owner.capture_state AS captureState,owner.state AS ownerState FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id WHERE run.id=$runId", { runId: process.argv[3] });`,
    `  process.stdout.write(JSON.stringify(row));`,
    `} finally { database.close(); }`,
  ].join("\n");

  return new Promise((resolveReadback, rejectReadback) => {
    const child = spawn(process.execPath, [
      ...(preloadPath ? ["--import", pathToFileURL(preloadPath).href] : []),
      "--import", tsxLoader, "--input-type=module", "-e", source, dbPath, orchestratorHome, runId,
    ], {
      cwd: workspace,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        // Production composition creates HermesRuntimeAdapter, which resolves its
        // cache/checkpoint paths from process.env even though `home` is passed
        // explicitly to the composition. Keep this restart process isolated from
        // the host profile while giving it the same deterministic test home.
        EBB_ORCHESTRATOR_HOME: orchestratorHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReadback(new Error("TASK5B_RESTART_READBACK_PROCESS_FAILED", { cause: error }));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectReadback(new Error(`TASK5B_RESTART_READBACK_FAILED:EXIT_${code}:${stderr.slice(-1000)}`));
        return;
      }
      try {
        resolveReadback(JSON.parse(stdout) as RestartReadback);
      } catch (error) {
        rejectReadback(new Error("TASK5B_RESTART_READBACK_INVALID_JSON", { cause: error }));
      }
    });
  });
}

describe("Plan20 Task5B restart persistence harness", () => {
  it("keeps only allowlisted Hermes failure codes for acceptance diagnostics", () => {
    expect(safeHermesFailure(new Error("wrapped", {
      cause: new Error("HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_-1"),
    }))).toBe("HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_-1");
    expect(safeHermesFailure(new Error("wrapped", {
      cause: new Error("HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_103:CATEGORY_AUTH"),
    }))).toBe("HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_103:CATEGORY_AUTH");
    expect(safeHermesFailure(new Error("HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_103:CATEGORY_AUTH:secret")))
      .toBeUndefined();
    expect(safeHermesFailure(new Error("HERMES_PYTHON_STARTUP_EXCEPTION:ModuleNotFoundError")))
      .toBe("HERMES_PYTHON_STARTUP_EXCEPTION:ModuleNotFoundError");
    expect(safeHermesFailure(new Error("HERMES_PYTHON_STARTUP_EXCEPTION:PermissionError")))
      .toBe("HERMES_PYTHON_STARTUP_EXCEPTION:PermissionError");
    expect(safeHermesFailure(new Error("HERMES_PYTHON_STARTUP_EXCEPTION:UnknownProviderError"))).toBeUndefined();
    expect(safeHermesFailure(new Error("HERMES_PYTHON_STARTUP_EXCEPTION:ModuleNotFoundError:secret"))).toBeUndefined();
    expect(safeHermesFailure(new Error("HERMES_EBB_MCP_REGISTRATION_FAILED")))
      .toBe("HERMES_EBB_MCP_REGISTRATION_FAILED");
    expect(safeHermesFailure(new Error("HERMES_EBB_MCP_REGISTRATION_FAILED:secret"))).toBeUndefined();
    expect(safeHermesFailure(new Error("HERMES_ACTIVE_SESSION_REFUSED:SESSION_NOT_OWNED")))
      .toBe("HERMES_ACTIVE_SESSION_REFUSED:SESSION_NOT_OWNED");
    expect(safeHermesFailure(new Error("HERMES_ACTIVE_SESSION_REFUSED:UNKNOWN"))).toBeUndefined();
    expect(safeHermesFailure(new Error("provider response contained a secret"))).toBeUndefined();
  });

  it("reads a session capture after reopening production composition in a new process", async () => {
    const root = await mkdtemp(join(tmpdir(), "ebb-plan20-task5b-restart-check-"));
    const dbPath = join(root, "orchestrator.sqlite");
    const database = createSqliteDatabase(dbPath);
    const runId = randomUUID();
    const now = new Date().toISOString();
    let databaseOpen = true;
    try {
      runMigrations(database, loadTestMigrations());
      database.run(
        "INSERT INTO agent_runs(id,role,runtime,model,status,session_id) VALUES($id,'developer','hermes','test','COMPLETED','durable-session-id')",
        { id: runId },
      );
      database.run(
        `INSERT INTO run_process_owner_generations(run_id,generation,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,stop_evidence,updated_at,capture_state)
         VALUES($runId,1,$sourceTag,$hermesHome,'windows-job',$containmentId,$launchNonce,'STOPPED','verified-stop',$now,'BOUND')`,
        {
          runId,
          sourceTag: `ebb-run:${runId}`,
          hermesHome: join(root, "shared-hermes-root"),
          containmentId: "a".repeat(64),
          launchNonce: "b".repeat(64),
          now,
        },
      );
      database.run(
        `INSERT INTO run_process_owners(run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,stop_evidence,updated_at,capture_state)
         VALUES($runId,$sourceTag,$hermesHome,'windows-job',$containmentId,$launchNonce,'STOPPED','verified-stop',$now,'BOUND')`,
        {
          runId,
          sourceTag: `ebb-run:${runId}`,
          hermesHome: join(root, "shared-hermes-root"),
          containmentId: "a".repeat(64),
          launchNonce: "b".repeat(64),
          now,
        },
      );
      database.close();
      databaseOpen = false;

      const preloadPath = join(root, "tsx-preload.mjs");
      await writeFile(preloadPath, [
        "// Keep TSX's Windows temp-directory fallback independent of OS account lookup.",
        "process.geteuid ??= () => process.pid;",
        "",
      ].join("\n"), { flag: "wx", mode: 0o600 });

      await expect(readSessionAfterOrchestratorRestart(dbPath, join(root, "home"), runId, preloadPath)).resolves.toEqual({
        runStatus: "COMPLETED",
        sessionId: "durable-session-id",
        captureState: "BOUND",
        ownerState: "STOPPED",
      });
    } finally {
      if (databaseOpen) database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});


/**
 * Реальная provider acceptance Plan20 Task5B. Запускается только при задании точного marker:
 * Hermes отправит один настоящий запрос через существующую пользовательскую auth-конфигурацию.
 * Секреты не читаются, не копируются, не входят в окружение теста и не печатаются.
 */
describe.skipIf(!enabled || !["win32", "linux"].includes(process.platform))(
  "Plan20 Task5B — supervised Hermes live-provider acceptance",
  () => {
    let root = "";
    let dbPath = "";
    let database: ReturnType<typeof createSqliteDatabase> | undefined;
    let readbackDatabase: ReturnType<typeof createSqliteDatabase> | undefined;
    let runs: RunService | undefined;
    let runId: string | undefined;
    let restartReadbackVerified = false;

    afterAll(async () => {
      let safeToRemoveFixture = restartReadbackVerified;
      let cleanupUnverified = Boolean(runId) && !restartReadbackVerified && !database;
      if (runId && database) {
        let row = database.get<{ status: string; state: string; stop_evidence: string | null; containment_kind: string }>(
          `SELECT run.status,owner.state,owner.stop_evidence,owner.containment_kind
             FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id WHERE run.id=$runId`,
          { runId },
        );
        if (row && !(["COMPLETED", "FAILED", "CANCELLED"].includes(row.status) && row.state === "STOPPED" &&
            isAuthoritativeRunProcessStopEvidence(row.stop_evidence, row.containment_kind as "windows-job" | "systemd-user-service"))) {
          await runs?.cancelRun(runId).catch(() => undefined);
          row = database.get(
            `SELECT run.status,owner.state,owner.stop_evidence,owner.containment_kind
               FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id WHERE run.id=$runId`,
            { runId },
          );
        }
        if (row && ["COMPLETED", "FAILED", "CANCELLED"].includes(row.status) && row.state === "STOPPED" &&
            isAuthoritativeRunProcessStopEvidence(row.stop_evidence, row.containment_kind as "windows-job" | "systemd-user-service")) {
          // Fixture process уже доказанно остановлен; повторная отмена не требуется.
        } else if (row) {
          // Keep the DB intact so process-owner recovery evidence is not discarded.
          safeToRemoveFixture = false;
          cleanupUnverified = true;
        } else {
          // The durable Run identity is missing; retain only the Ebb test home for recovery evidence.
          safeToRemoveFixture = false;
          cleanupUnverified = true;
        }
      }
      readbackDatabase?.close();
      database?.close();
      if (root && safeToRemoveFixture) await rm(root, { recursive: true, force: true });
      else if (root) process.stderr.write(`TASK5B_DIAGNOSTIC_ROOT_RETAINED:${root}\n`);
      if (cleanupUnverified) throw new Error("TASK5B_LIVE_ACCEPTANCE_CLEANUP_UNVERIFIED; diagnostic database retained under the test temp root");
    });

    it("captures the actual init session id durably while the supervised owner is LIVE, then confirms STOPPED", async () => {
      root = await mkdtemp(join(tmpdir(), "ebb-plan20-task5b-live-"));
      dbPath = join(root, "orchestrator.sqlite");
      database = createSqliteDatabase(dbPath);
      runMigrations(database, loadTestMigrations());
      const now = new Date().toISOString();
      const taskId = randomUUID();
      const repository = join(root, "repository");
      await mkdir(repository, { recursive: true });
      const git = new GitCli();
      await git.run(repository, ["init", "--initial-branch=master"]);
      await git.run(repository, ["config", "user.email", "acceptance@example.invalid"]);
      await git.run(repository, ["config", "user.name", "Acceptance Fixture"]);
      await writeFile(join(repository, "README.md"), "# Disposable Task5B acceptance repository\n");
      await git.run(repository, ["add", "README.md"]);
      await git.run(repository, ["commit", "-m", "initial Task5B acceptance fixture"]);

      const approvals = new ApprovalService(database);
      const onboarding = new OnboardingService(database, approvals);
      const draft = await onboarding.discoverAndCreateDraft(repository);
      onboarding.requestApproval(draft.projectId, {
        defaultBranch: "master",
        workflow: "standard",
        roles: ["developer"],
        guidelines: ["Use the disposable Task5B acceptance repository."],
      });
      onboarding.approve(draft.projectId);
      onboarding.activate(draft.projectId);
      seedApprovedProjectConfig(database, draft.projectId, "master");

      const taskWorkspace = await new WorktreeManager({
        db: database,
        git,
        worktreeDir: join(root, "task-worktrees"),
      }).createTaskWorkspace(taskId, repository, "master");
      database.run(
        `INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at)
         VALUES($id,$projectId,'TASK5B-LIVE','Hermes live provider acceptance','READY',$contract,1,$now,$now)`,
        {
          id: taskId, projectId: draft.projectId, now,
          contract: JSON.stringify({
            version: 1,
            goal: "Verify that Hermes captures and persists its real session ID.",
            context: "One live provider request; do not edit files or run shell commands.",
            requirements: ["Submit the requested structured result through submit_result."],
            acceptanceCriteria: ["The Run completes and its session ID survives Orchestrator restart."],
            dependencies: [], nonGoals: [], definitionOfDone: ["Verified persisted session ID and STOPPED process owner."],
          }),
        },
      );

      const orchestratorHome = join(root, "orchestrator-home");
      const home = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: orchestratorHome }, process.platform as "win32" | "linux");
      const paths = createProductionPaths(home);
      const executor = new ProcessExecutor();
      const supervisor = process.platform === "win32"
        ? new WindowsJobSupervisor(executor)
        : new SystemdRunSupervisor(executor);
      const runtime = new HermesRuntimeAdapter(executor, undefined, {
        databasePath: dbPath,
        resultDirectory: paths.hermesResultDirectory,
        checkpointDirectory: paths.hermesCheckpointDirectory,
        timeoutMs: 180_000,
        mcpCommand: process.execPath,
        mcpArgs: ["--import", tsxLoader, mcpCli],
      }, supervisor);
      const runService = new RunService(database, runtime);
      runs = runService;

      const currentWorkspaceHead = (await git.run(taskWorkspace.path, ["rev-parse", "HEAD"])).stdout.trim();
      const prompt = [
        "This is a single live provider acceptance request for the Orchestrator.",
        "Do not edit files, run shell commands, or call any tool except submit_result.",
        "Call submit_result exactly once with this valid DeveloperOutput JSON:",
        JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", summary: "Live Hermes provider request completed.", commitSha: currentWorkspaceHead }),
      ].join("\n");
      const options = {
        role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "plan20-task5b-live-v1", outputSchemaVersion: "1",
        capability: { workspace: taskWorkspace.path, allowedTools: ["workspace.read", "submit_result"] }, prompt,
      } satisfies StartRunOptions;
      const run = await runService.prepareRunWithHermesPreflight({
          ...options,
          contextInput: createRunContextInput(options, {
            prompt,
            roleInputs: {},
            workspaceIdentity: { repository, workspace: taskWorkspace.path, worktree: taskId },
            targetHead: (await git.run(repository, ["rev-parse", "master"])).stdout.trim(),
            targetBranch: "master",
          }),
      });
      runId = run.id;

      let executionFailure: string | undefined;
      let executionFinished = false;
      const execution = runs.executePreparedRun(run.id).then(
        (value) => { executionFinished = true; return { value }; },
        (error: unknown) => { executionFinished = true; executionFailure = safeHermesFailure(error); return { value: undefined }; },
      );
      let liveDurableReadback = false;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && !executionFinished) {
        const row = database.get<{ session_id: string | null; capture_state: string; owner_state: string; status: string }>(
          `SELECT run.session_id,owner.capture_state,owner.state AS owner_state,run.status
             FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id WHERE run.id=$runId`,
          { runId: run.id },
        );
        if (row?.session_id && row.capture_state === "BOUND" && row.owner_state === "LIVE") {
          readbackDatabase = createSqliteDatabase(dbPath);
          const durable = readbackDatabase.get<{ session_id: string | null; capture_state: string; owner_state: string }>(
            `SELECT run.session_id,owner.capture_state,owner.state AS owner_state
               FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id WHERE run.id=$runId`,
            { runId: run.id },
          );
          liveDurableReadback = durable?.session_id === row.session_id && durable.capture_state === "BOUND" && durable.owner_state === "LIVE";
          readbackDatabase.close();
          readbackDatabase = undefined;
          if (liveDurableReadback) break;
        }
        await wait(100);
      }
      const settled = executionFinished ? await execution : undefined;
      expect(liveDurableReadback,
        `actual Hermes init session must be CAS-bound and readable from a second SQLite connection before the owner stops; safe Hermes failure: ${executionFailure ?? "none"}`,
      ).toBe(true);
      const completed = settled ?? await execution;
      expect(executionFailure, "supervised real provider Run must complete successfully").toBeUndefined();
      expect(completed.value?.outcome.validatedSubmission, "the provider must submit the validated result through the controlled channel").toBe(true);

      const finalRun = database.get<{ status: string; session_id: string | null; input_tokens: number | null; output_tokens: number | null; output: string | null }>(
        "SELECT status,session_id,input_tokens,output_tokens,output FROM agent_runs WHERE id=$runId", { runId: run.id },
      );
      expect(finalRun?.status).toBe("COMPLETED");
      expect(JSON.parse(finalRun!.output!).commitSha).toBe(currentWorkspaceHead);
      expect(typeof finalRun?.session_id).toBe("string");
      expect((finalRun?.session_id?.length ?? 0) > 0).toBe(true);
      expect((finalRun?.input_tokens ?? 0) + (finalRun?.output_tokens ?? 0)).toBeGreaterThan(0);
      const owner = database.get<{ hermes_home: string; state: string; stop_evidence: string | null; containment_kind: string }>(
        "SELECT hermes_home,state,stop_evidence,containment_kind FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
      );
      expect(owner?.state).toBe("STOPPED");
      expect(isAuthoritativeRunProcessStopEvidence(owner?.stop_evidence ?? null,
        owner?.containment_kind as "windows-job" | "systemd-user-service")).toBe(true);
      expect(database.get<{ hermes_home: string }>(
        "SELECT hermes_home FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
      )?.hermes_home).toBe(owner!.hermes_home);

      // End this Orchestrator's database lifetime before reopening it in a fresh process.
      // The live-before-stop assertion above remains separate and proves capture timing.
      database.close();
      database = undefined;
      runs = undefined;
      const afterRestart = await readSessionAfterOrchestratorRestart(dbPath, orchestratorHome, run.id);
      expect(afterRestart).toEqual({
        runStatus: "COMPLETED",
        sessionId: finalRun?.session_id,
        captureState: "BOUND",
        ownerState: "STOPPED",
      });
      restartReadbackVerified = true;
    }, 600_000);
  },
);
