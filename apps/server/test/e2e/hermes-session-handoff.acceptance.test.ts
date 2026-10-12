import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { OnboardingService } from "../../src/modules/projects/onboarding-service.js";
import { isAuthoritativeRunProcessStopEvidence } from "../../src/modules/runtime/run-process-owner.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { createProductionPaths } from "../../src/platform/home/production-paths.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";

const ACCEPTANCE_MARKER = "I_UNDERSTAND_THIS_SENDS_REAL_PROVIDER_REQUESTS";
const enabled = process.env.EBB_RUN_TASK5C_LIVE_PROVIDER_ACCEPTANCE === ACCEPTANCE_MARKER;
const serverFixture = resolve(import.meta.dirname, "fixtures/crash-recovery-server.mjs");
const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const shutdownMessage = "ebb-v1-crash-recovery:shutdown";
const environmentAllowlist = [
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
] as const;
const wait = (milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

/**
 * Реальный acceptance включается только явным marker в PowerShell:
 * `pnpm --filter @ebb-orchestrator/server run build; $env:EBB_RUN_TASK5C_LIVE_PROVIDER_ACCEPTANCE='I_UNDERSTAND_THIS_SENDS_REAL_PROVIDER_REQUESTS'; pnpm --filter @ebb-orchestrator/server exec vitest run test/e2e/hermes-session-handoff.acceptance.test.ts`.
 * Тест использует текущую Hermes-конфигурацию ОС, не читает и не меняет credentials.
 */

interface ProductionChild {
  process: ChildProcess;
  output: string;
  firstReadSessionIds: string[];
}

interface HandoffRow {
  id: string;
  status: string;
  exit_code: number | null;
  attempt: number | null;
  session_id: string | null;
  capability_ref: string | null;
  capability_json: string | null;
  output: string | null;
  current_generation: number;
  capture_state: string;
  owner_state: string;
  stop_evidence: string | null;
  containment_kind: string;
  generation_state: string | null;
  original_session_id: string | null;
  reservation_id: string | null;
  reservation_status: string | null;
}

function childEnvironment(home: string, port: number): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of environmentAllowlist) {
    const inheritedName = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    if (inheritedName && process.env[inheritedName] !== undefined) environment[name] = process.env[inheritedName];
  }
  environment.EBB_ORCHESTRATOR_HOME = home;
  environment.PORT = String(port);
  return environment;
}

function launchProductionChild(home: string, port: number, password?: string): ProductionChild {
  const child = spawn(process.execPath, [serverFixture, "--observe-task5c-first-read", ...(password ? ["--bootstrap-local-user-stdin"] : [])], {
    cwd: workspaceRoot,
    env: childEnvironment(home, port),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const state: ProductionChild = { process: child, output: "", firstReadSessionIds: [] };
  child.stdout?.on("data", (chunk: Buffer) => { state.output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { state.output += chunk.toString("utf8"); });
  child.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && !Array.isArray(message) &&
        (message as Record<string, unknown>).type === "task5c:first-read" &&
        typeof (message as Record<string, unknown>).sessionId === "string") {
      state.firstReadSessionIds.push((message as Record<string, unknown>).sessionId as string);
    }
  });
  if (password) child.stdin?.end(`${password}\n${password}\n`);
  else child.stdin?.end();
  return state;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_PORT_UNAVAILABLE");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForReady(child: ProductionChild, origin: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error("TASK5C_PRODUCTION_CHILD_EXITED_BEFORE_READY");
    }
    const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
    if (response?.ok) {
      const body = await response.json() as { lifecycle?: string };
      if (body.lifecycle === "READY") return;
    }
    await wait(100);
  }
  throw new Error("TASK5C_PRODUCTION_CHILD_READY_TIMEOUT");
}

async function waitForExit(child: ProductionChild, timeoutMs = 30_000): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const onExit = () => { clearTimeout(timer); resolveExit(); };
    const timer = setTimeout(() => {
      child.process.off("exit", onExit);
      reject(new Error("TASK5C_PRODUCTION_CHILD_EXIT_TIMEOUT"));
    }, timeoutMs);
    child.process.once("exit", onExit);
  });
}

async function stopProductionChild(child: ProductionChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  await new Promise<void>((resolveSend, reject) => {
    child.process.send(shutdownMessage, (error) => error ? reject(error) : resolveSend());
  });
  await waitForExit(child);
}

async function crashProductionChild(child: ProductionChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  if (!child.process.kill("SIGKILL")) throw new Error("TASK5C_ORCHESTRATOR_CRASH_SIGNAL_FAILED");
  await waitForExit(child);
}

async function removeExitedFixtureLock(home: string, child: ProductionChild): Promise<void> {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    throw new Error("TASK5C_CANNOT_REMOVE_LOCK_FOR_LIVE_FIXTURE_PROCESS");
  }
  const lockPath = join(home, "orchestrator.lock");
  const record = await readFile(lockPath, "utf8");
  if (!new RegExp(`^v1:${child.process.pid}:[0-9a-f]{32}\\n?$`, "u").test(record)) {
    throw new Error("TASK5C_FIXTURE_LOCK_OWNER_MISMATCH");
  }
  await rm(lockPath);
}

async function login(origin: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${origin}/api/v1/session/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error("TASK5C_TEST_LOGIN_FAILED");
  const cookieHeader = response.headers.get("set-cookie");
  const cookie = cookieHeader?.split(";", 1)[0];
  const body = await response.json() as { csrfToken?: unknown };
  if (!cookie || typeof body.csrfToken !== "string") throw new Error("TASK5C_TEST_SESSION_UNAVAILABLE");
  return { cookie, csrf: body.csrfToken };
}

function loadHandoffRow(database: ReturnType<typeof createSqliteDatabase>, runId: string): HandoffRow | undefined {
  return database.get<HandoffRow>(
    `SELECT r.id,r.status,r.exit_code,r.attempt,r.session_id,r.capability_ref,r.capability_json,r.output,
      o.current_generation,o.capture_state,o.state AS owner_state,o.stop_evidence,o.containment_kind,
      g.state AS generation_state,b.original_session_id,sr.id AS reservation_id,sr.status AS reservation_status
     FROM agent_runs r JOIN run_process_owners o ON o.run_id=r.id
     LEFT JOIN run_process_owner_generations g ON g.run_id=o.run_id AND g.generation=o.current_generation
     LEFT JOIN run_resume_bindings b ON b.run_id=r.id
     LEFT JOIN scheduler_reservations sr ON sr.run_id=r.id AND sr.kind <> 'LOCK'
     WHERE r.id=$runId`,
    { runId },
  );
}

async function waitForLiveCapture(database: ReturnType<typeof createSqliteDatabase>, runId: string): Promise<HandoffRow> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const row = loadHandoffRow(database, runId);
    if (row?.session_id && row.original_session_id === row.session_id && row.capture_state === "BOUND" &&
        row.owner_state === "LIVE" && ["STARTED", "IN_PROGRESS"].includes(row.status)) return row;
    if (row && ["FAILED", "CANCELLED", "COMPLETED"].includes(row.status)) {
      const code = row.output?.match(/\b(?:TASK|HERMES|AGENT)_[A-Z0-9_]+\b/u)?.[0] ?? "NO_STABLE_DIAGNOSTIC_CODE";
      throw new Error(`TASK5C_INITIAL_RUN_FINISHED_BEFORE_CAPTURE_CHECK:${row.status}:EXIT_${row.exit_code ?? "NULL"}:CAPTURE_${row.capture_state}:OWNER_${row.owner_state}:${code}`);
    }
    await wait(5);
  }
  throw new Error("TASK5C_LIVE_SESSION_CAPTURE_TIMEOUT");
}

async function waitForTaskRunId(database: ReturnType<typeof createSqliteDatabase>, taskId: string): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const rows = database.all<{ id: string }>(
      "SELECT id FROM agent_runs WHERE task_id=$taskId ORDER BY rowid DESC LIMIT 2",
      { taskId },
    );
    if (rows.length > 1) throw new Error("TASK5C_MULTIPLE_RUNS_CREATED_FOR_FIXTURE_TASK");
    if (rows[0]) return rows[0].id;
    await wait(5);
  }
  throw new Error("TASK5C_DISPATCH_DID_NOT_PERSIST_RUN");
}

async function waitForRunCompletion(database: ReturnType<typeof createSqliteDatabase>, runId: string): Promise<HandoffRow> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const row = loadHandoffRow(database, runId);
    if (row && ["COMPLETED", "FAILED", "CANCELLED"].includes(row.status) && row.owner_state === "STOPPED") return row;
    await wait(100);
  }
  throw new Error("TASK5C_RESUMED_RUN_COMPLETION_TIMEOUT");
}

async function waitForFirstReadSession(child: ProductionChild, sessionId: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.firstReadSessionIds.includes(sessionId)) return;
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      throw new Error("TASK5C_PRODUCTION_CHILD_EXITED_BEFORE_PERSISTED_TURN_MARKER");
    }
    await wait(25);
  }
  throw new Error("TASK5C_PERSISTED_TURN_MARKER_TIMEOUT");
}

async function createTaskFixture(
  database: ReturnType<typeof createSqliteDatabase>, home: string, root: string,
): Promise<{ taskId: string; repository: string; workspace: string }> {
  const now = new Date().toISOString();
  const taskId = randomUUID();
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  const git = new GitCli();
  await git.run(repository, ["init", "--initial-branch=master"]);
  await git.run(repository, ["config", "user.email", "acceptance@example.invalid"]);
  await git.run(repository, ["config", "user.name", "Acceptance Fixture"]);
  await writeFile(join(repository, "README.md"), "# Disposable Plan20 Task5C recovery fixture\n");
  await git.run(repository, ["add", "README.md"]);
  const initialCommit = await git.run(repository, ["commit", "-m", "initial Task5C recovery fixture"]);
  if (initialCommit.exitCode !== 0) throw new Error("TASK5C_FIXTURE_REPOSITORY_SETUP_FAILED");

  const approvals = new ApprovalService(database);
  const onboarding = new OnboardingService(database, approvals);
  const draft = await onboarding.discoverAndCreateDraft(repository);
  onboarding.requestApproval(draft.projectId, {
    defaultBranch: "master", workflow: "standard", roles: ["developer"],
    guidelines: ["Use this disposable repository only for the live recovery acceptance."],
  });
  onboarding.approve(draft.projectId);
  onboarding.activate(draft.projectId);
  seedApprovedProjectConfig(database, draft.projectId, "master");

  const paths = createProductionPaths(resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: home }, process.platform as "win32" | "linux"));
  const workspace = await new WorktreeManager({ db: database, git, worktreeDir: paths.taskWorktreeDirectory })
    .createTaskWorkspace(taskId, repository, "master");
  database.run(
    `INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at)
     VALUES($id,$projectId,'TASK5C-HANDOFF','Verify same-Run Hermes recovery','READY',$contract,1,$now,$now)`,
    {
      id: taskId, projectId: draft.projectId, now,
      contract: JSON.stringify({
        version: 1,
        goal: "Verify that a single persisted Run can safely resume its original Hermes session after an Orchestrator restart.",
        context: "Do not modify files. Use the existing Hermes session and submit a short successful structured result after recovery.",
        requirements: ["Keep the assigned worktree unchanged.", "Use workspace.search and workspace.read to inspect the fixture README, then use git.head to obtain the exact current commit SHA."],
        acceptanceCriteria: ["Submit a DeveloperOutput with outcome COMPLETED and the exact current full commit SHA after all three tool calls succeed."],
        dependencies: [], nonGoals: ["No file edits", "No shell commands"],
        definitionOfDone: ["Validated submit_result is persisted for the original Run."],
      }),
    },
  );
  database.run(
    "INSERT OR IGNORE INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1000000,0,0)",
    { projectId: draft.projectId },
  );
  return { taskId, repository, workspace: workspace.path };
}

describe.skipIf(!enabled || !["win32", "linux"].includes(process.platform))(
  "Plan20 Task5C — real Hermes same-Run/session handoff after production restart",
  () => {
    let root = "";
    let database: ReturnType<typeof createSqliteDatabase> | undefined;
    let runId: string | undefined;
    let safeToRemove = false;
    const children: ProductionChild[] = [];

    afterAll(async () => {
      for (const child of children) {
        if (child.process.exitCode === null && child.process.signalCode === null) {
          await stopProductionChild(child).catch(() => undefined);
        }
      }
      const row = runId && database ? loadHandoffRow(database, runId) : undefined;
      const terminalAndStopped = Boolean(row && ["COMPLETED", "FAILED", "CANCELLED"].includes(row.status) &&
        row.owner_state === "STOPPED" && isAuthoritativeRunProcessStopEvidence(row.stop_evidence,
          row.containment_kind as "windows-job" | "systemd-user-service"));
      safeToRemove ||= !runId || terminalAndStopped;
      database?.close();
      if (root && safeToRemove) await rm(root, { recursive: true, force: true });
      else if (root) process.stderr.write(`TASK5C_DIAGNOSTIC_ROOT_RETAINED:${root}\n`);
    });

    it("stops the old scope and resumes the same Run and Hermes session after restart", async () => {
      const rootPath = await mkdtemp(join(tmpdir(), "ebb-plan20-task5c-handoff-"));
      root = rootPath;
      const home = join(root, "orchestrator-home");
      const homePaths = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: home }, process.platform as "win32" | "linux");
      const port = await reservePort();
      const origin = `http://127.0.0.1:${port}`;
      const password = randomUUID();
      const first = launchProductionChild(home, port, password);
      children.push(first);
      await waitForReady(first, origin);

      database = createSqliteDatabase(homePaths.database);
      const fixture = await createTaskFixture(database, home, root);
      const auth = await login(origin, password);
      // Observe SQLite while the real dispatch request is still in flight. Awaiting the HTTP
      // response first can miss the short live-session window on a fast real provider response.
      const dispatchResponse = fetch(`${origin}/api/v1/tasks/${fixture.taskId}/dispatch`, {
        method: "POST",
        headers: { origin, cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" },
        body: JSON.stringify({ role: "developer", model: "default" }),
      }).then(async (response) => ({
        status: response.status,
        body: await response.json() as { runId?: unknown },
      })).catch(() => undefined);
      runId = await waitForTaskRunId(database, fixture.taskId);

      const initial = await waitForLiveCapture(database, runId);
      expect(initial.current_generation).toBe(1);
      expect(initial.reservation_id).toBeTruthy();
      const originalSessionId = initial.session_id!;
      const originalCapabilityRef = initial.capability_ref;
      const originalCapabilityJson = initial.capability_json;
      expect(originalCapabilityRef).toBeTruthy();
      expect(originalCapabilityJson).toBeTruthy();
      const originalReservationId = initial.reservation_id;
      const originalAttempt = initial.attempt;

      // Hermes emits init before persisting the inbound turn. Wait for one successful Run-bound
      // workspace.read result so the original session contains a durable turn before the crash.
      await waitForFirstReadSession(first, originalSessionId);
      const liveBeforeCrash = loadHandoffRow(database, runId);
      expect(liveBeforeCrash?.session_id).toBe(originalSessionId);
      expect(liveBeforeCrash?.owner_state).toBe("LIVE");
      expect(liveBeforeCrash?.status).toBe(initial.status);

      // An abrupt Orchestrator exit leaves the durable Run/reservation intact; startup owns stop proof.
      await crashProductionChild(first);
      // The product's singleton lock deliberately fails closed on any existing lock. Clear only
      // this temporary fixture's exact dead-child record after verifying the child has exited.
      await removeExitedFixtureLock(home, first);
      const completedDispatchResponse = await Promise.race([dispatchResponse, wait(100).then(() => undefined)]);
      if (completedDispatchResponse &&
          (completedDispatchResponse.status !== 202 || completedDispatchResponse.body.runId !== runId)) {
        throw new Error("TASK5C_REAL_PROVIDER_RUN_DISPATCH_FAILED");
      }
      const crashed = loadHandoffRow(database, runId);
      expect(crashed?.status).toBe(initial.status);
      expect(crashed?.session_id).toBe(originalSessionId);
      expect(crashed?.owner_state).toBe("LIVE");

      // The workspace remains unchanged: production startup must prove the old generation stopped,
      // then resume the same logical Run through its durable original Hermes session.
      const resumedRestart = launchProductionChild(home, port);
      children.push(resumedRestart);
      const completed = await waitForRunCompletion(database, runId);
      const failureCode = completed.output?.match(/\b(?:TASK|HERMES|AGENT)_[A-Z0-9_]+\b/u)?.[0] ?? "NO_STABLE_DIAGNOSTIC_CODE";
      expect(completed.status, `TASK5C_RESUMED_RUN_FAILURE:${completed.exit_code ?? "NULL"}:${failureCode}`).toBe("COMPLETED");
      expect(completed.current_generation).toBe(2);
      expect(completed.generation_state).toBe("STOPPED");
      expect(completed.session_id).toBe(originalSessionId);
      expect(completed.original_session_id).toBe(originalSessionId);
      expect(completed.attempt).toBe((originalAttempt ?? 0) + 1);
      expect(completed.capability_ref).toBeNull();
      expect(completed.capability_json).toBeNull();
      expect(completed.reservation_id).toBe(originalReservationId);
      expect(completed.reservation_status).toBe("RELEASED");
      expect(JSON.parse(completed.output ?? "{}")).toMatchObject({ version: "1.0.0", outcome: "COMPLETED" });
      expect(isAuthoritativeRunProcessStopEvidence(completed.stop_evidence,
        completed.containment_kind as "windows-job" | "systemd-user-service")).toBe(true);
      expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id=$taskId", { taskId: fixture.taskId })?.count).toBe(1);
      await waitForReady(resumedRestart, origin, 90_000);
      safeToRemove = true;
    }, 900_000);
  },
);
