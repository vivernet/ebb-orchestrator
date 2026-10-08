import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
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
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import { createProductionPaths } from "../../src/platform/home/production-paths.js";
import { isAuthoritativeRunProcessStopEvidence } from "../../src/modules/runtime/run-process-owner.js";

const ACCEPTANCE_MARKER = "I_UNDERSTAND_THIS_SENDS_A_REAL_PROVIDER_REQUEST";
const enabled = process.env.EBB_RUN_TASK5B_LIVE_PROVIDER_ACCEPTANCE === ACCEPTANCE_MARKER;
const resolvePackage = createRequire(import.meta.url).resolve;
const tsxLoader = pathToFileURL(resolvePackage("tsx")).href;
const mcpCli = resolve(import.meta.dirname, "../../src/bin/ebb-orchestrator-mcp.ts");
const workspace = resolve(import.meta.dirname, "../../../..");
const wait = (milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

interface RestartReadback {
  runStatus: string;
  sessionId: string | null;
  captureState: string;
  ownerState: string;
}

/** Reopens production persistence and composition in a fresh Orchestrator process. */
function readSessionAfterOrchestratorRestart(dbPath: string, orchestratorHome: string, runId: string): Promise<RestartReadback> {
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
    const child = spawn(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", source, dbPath, orchestratorHome, runId], {
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
        `INSERT INTO run_process_owners(run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,stop_evidence,updated_at,capture_state)
         VALUES($runId,$sourceTag,$hermesHome,'windows-job',$containmentId,$launchNonce,'STOPPED','verified-stop',$now,'BOUND')`,
        {
          runId,
          sourceTag: `ebb-run:${runId}`,
          hermesHome: join(root, "profiles", runId),
          containmentId: "a".repeat(64),
          launchNonce: "b".repeat(64),
          now,
        },
      );
      database.close();
      databaseOpen = false;

      await expect(readSessionAfterOrchestratorRestart(dbPath, join(root, "home"), runId)).resolves.toEqual({
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

async function isMissingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
  }
}

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
      let safeToRemoveFixture = !runId || restartReadbackVerified;
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
          const profile = database.get<{ hermes_home: string }>(
            "SELECT hermes_home FROM run_process_owners WHERE run_id=$runId", { runId },
          );
          let cleanupSucceeded = false;
          try { cleanupSucceeded = await runs?.cleanupTerminalHermesProfile(runId) === true; }
          catch { /* A failed cleanup leaves the initialized false result intact. */ }
          const profilePath = profile?.hermes_home;
          const profileAbsent = typeof profilePath === "string" && profilePath.length > 0 && await isMissingPath(profilePath);
          if (!cleanupSucceeded || !profileAbsent) {
            safeToRemoveFixture = false;
            cleanupUnverified = true;
          }
        } else if (row) {
          // Keep the DB and profile path intact so process-owner recovery evidence is not discarded.
          safeToRemoveFixture = false;
          cleanupUnverified = true;
        } else {
          // The durable Run identity is missing; retain the test home because profile absence is unproven.
          safeToRemoveFixture = false;
          cleanupUnverified = true;
        }
      }
      readbackDatabase?.close();
      database?.close();
      if (root && safeToRemoveFixture) await rm(root, { recursive: true, force: true });
      if (cleanupUnverified) throw new Error("TASK5B_LIVE_ACCEPTANCE_CLEANUP_UNVERIFIED; diagnostic database retained under the test temp root");
    });

    it("captures the actual init session id durably while the supervised owner is LIVE, then cleans its exact profile", async () => {
      root = await mkdtemp(join(tmpdir(), "ebb-plan20-task5b-live-"));
      dbPath = join(root, "orchestrator.sqlite");
      database = createSqliteDatabase(dbPath);
      runMigrations(database, loadTestMigrations());
      const now = new Date().toISOString();
      const projectId = randomUUID();
      const taskId = randomUUID();
      database.run(
        "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'task5b-live','Task5B live','ACTIVE',$now,$now)",
        { id: projectId, now },
      );
      database.run(
        `INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at)
         VALUES($id,$projectId,'TASK5B-LIVE','Hermes live provider acceptance','READY','{}',1,$now,$now)`,
        { id: taskId, projectId, now },
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
        hermesSourceSnapshotCacheRoot: paths.hermesSourceSnapshotCacheRoot,
        timeoutMs: 180_000,
        mcpCommand: process.execPath,
        mcpArgs: ["--import", tsxLoader, mcpCli],
      }, supervisor);
      runs = new RunService(database, runtime);

      const prompt = [
        "This is a single live provider acceptance request for the Orchestrator.",
        "Do not edit files, run shell commands, or call any tool except submit_result.",
        "Call submit_result exactly once with this valid DeveloperOutput JSON:",
        JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", summary: "Live Hermes provider request completed." }),
      ].join("\n");
      const options = {
        role: "developer", model: "persisted", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "plan20-task5b-live-v1", outputSchemaVersion: "1",
        capability: { workspace, allowedTools: ["workspace.read", "submit_result"] }, prompt,
      } satisfies StartRunOptions;
      const run = await runs.prepareRunWithHermesPreflight({
        ...options,
        contextInput: createRunContextInput(options, {
          prompt,
          roleInputs: {},
          workspaceIdentity: { repository: workspace, workspace, worktree: null },
          targetHead: null,
          targetBranch: null,
        }),
      });
      runId = run.id;

      let executionError = false;
      let executionFinished = false;
      const execution = runs.executePreparedRun(run.id).then(
        (value) => { executionFinished = true; return { value }; },
        () => { executionFinished = true; executionError = true; return { value: undefined }; },
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
      expect(liveDurableReadback, "actual Hermes init session must be CAS-bound and readable from a second SQLite connection before the owner stops").toBe(true);
      const settled = await execution;
      expect(executionError, "supervised real provider Run must complete successfully").toBe(false);
      expect(settled.value?.outcome.validatedSubmission, "the provider must submit the validated result through the controlled channel").toBe(true);

      const finalRun = database.get<{ status: string; session_id: string | null; input_tokens: number | null; output_tokens: number | null }>(
        "SELECT status,session_id,input_tokens,output_tokens FROM agent_runs WHERE id=$runId", { runId: run.id },
      );
      expect(finalRun?.status).toBe("COMPLETED");
      expect(typeof finalRun?.session_id).toBe("string");
      expect((finalRun?.session_id?.length ?? 0) > 0).toBe(true);
      expect((finalRun?.input_tokens ?? 0) + (finalRun?.output_tokens ?? 0)).toBeGreaterThan(0);
      const owner = database.get<{ hermes_home: string; state: string; stop_evidence: string | null; containment_kind: string }>(
        "SELECT hermes_home,state,stop_evidence,containment_kind FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
      );
      expect(owner?.state).toBe("STOPPED");
      expect(isAuthoritativeRunProcessStopEvidence(owner?.stop_evidence ?? null,
        owner?.containment_kind as "windows-job" | "systemd-user-service")).toBe(true);
      expect(await runs.cleanupTerminalHermesProfile(run.id)).toBe(true);
      expect(await isMissingPath(owner!.hermes_home)).toBe(true);

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
    }, 240_000);
  },
);
