/**
 * Приёмка Plan19 Task5: настоящий пользовательский Request, три planning роли,
 * approval и восстановление одобренного Epic в новом production процессе.
 *
 * Opt-in: EBB_RUN_REQUEST_EPIC_HERMES_ACCEPTANCE=I_UNDERSTAND_THIS_SENDS_REAL_PROVIDER_REQUESTS.
 * До запуска требуется свежая server build. Используется настроенный Hermes текущего
 * пользователя; fixture не читает и не копирует его credentials. Restart выполняется
 * на pending approval и FINAL_APPROVAL gates, а не посреди активного provider Run.
 * Этот harness поддерживает Windows/Linux; macOS acceptance им не подтверждается.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import type { Database } from "../../src/platform/database/database.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { OnboardingService } from "../../src/modules/projects/onboarding-service.js";
import { validatePlanningDecisions } from "../../src/modules/planning/planning-service.js";
import { CoordinatorOutputSchema, CoordinatorPlanSchema } from "@ebb-orchestrator/contracts";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { validateRoleOutput } from "../../src/modules/runtime/output-validator.js";
import { isAuthoritativeRunProcessStopEvidence } from "../../src/modules/runtime/run-process-owner.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";

const marker = "I_UNDERSTAND_THIS_SENDS_REAL_PROVIDER_REQUESTS";
const enabled = process.env.EBB_RUN_REQUEST_EPIC_HERMES_ACCEPTANCE === marker;
const serverFixture = resolve(import.meta.dirname, "fixtures/crash-recovery-server.mjs");
const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const environmentAllowlist = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HERMES_HOME", "HERMES_PROFILE", "HERMES_CONFIG", "HERMES_MODEL"] as const;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const terminalStatuses = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
// Only source-owned stable identifiers may cross the subprocess boundary. Never retain
// or print raw stdout/stderr: Hermes output may contain prompts or credentials.
const safeDiagnosticCodes = new Set([
  "AGENT_OUTPUT_MISSING", "EPIC_INTEGRATION_CONTRACT_INVALID", "EPIC_INTEGRATION_SERVICE_UNAVAILABLE",
  "EPIC_INTEGRATION_WORKTREE_ROOT_UNAVAILABLE", "EPIC_INTEGRATION_TARGET_SHA_UNAVAILABLE",
  "EPIC_INTEGRATION_PROVENANCE_PATH_UNAVAILABLE", "EPIC_RECOVERY_CHECKPOINT_INVALID",
  "EPIC_RECOVERY_FAILED", "EPIC_RUN_STOP_UNPROVEN", "HERMES_RUN_PREFLIGHT_REQUIRED",
  "HERMES_RUN_SELECTION_UNAVAILABLE", "PROJECT_ACTION_COMMANDS_UNAVAILABLE",
  "PROJECT_ACTION_COMMANDS_UNAPPROVED", "RUN_PROCESS_OWNER_UNAVAILABLE",
  "INTEGRATION_PREPARE_ROOT_CREATE_FAILED", "INTEGRATION_PREPARE_HOOKS_DIR_CREATE_FAILED",
  "WINDOWS_PROCESS_SCOPE_TIMEOUT",
]);

function safeCodesInText(value: string): string[] {
  const found = new Set<string>();
  for (const match of value.matchAll(/[A-Z][A-Z0-9_]{4,}/gu)) if (safeDiagnosticCodes.has(match[0])) found.add(match[0]);
  const integrationPreparationPattern = /INTEGRATION_PREPARE_(?:(?:REFS|WORKTREE|PERSISTENCE)_FAILED:(?:GIT_EXIT_(?:\d{1,16}|UNKNOWN):(?:PATH_TOO_LONG|BRANCH_EXISTS|PERMISSION|WORKTREE_PATH_EXISTS|BRANCH_IN_USE|REF_NOT_FOUND|INVALID_OBJECT|REPOSITORY_UNAVAILABLE|WORKTREE_LOCKED|NESTED_WORKTREE|CREATE_REJECTED|LOCK_REJECTED|REFERENCE_REJECTED|WORKTREE_REJECTED|OTHER)|OTHER)|PERSISTENCE_FAILED:(?:ERR_SQLITE_ERROR|SQLITE_(?:CONSTRAINT|BUSY|LOCKED|READONLY|FULL|IOERR)))/gu;
  for (const match of value.matchAll(integrationPreparationPattern)) found.add(match[0]);
  return [...found].sort();
}

interface ProductionChild { process: ChildProcess; shutdownObserved: boolean; approvalEpicId: string | null; closeObserved: boolean; checkpointCrashVerified: boolean; diagnosticCodes: Set<string>; }
interface ChildExitEvidence { exited: boolean; exitCode: number | null; closeObserved: boolean; shutdownObserved: boolean; checkpointCrashVerified: boolean; }
interface TeardownOwner { status: string; state: string | null; stop_evidence: string | null; containment_kind: string | null; }
interface RunEvidence extends TeardownOwner {
  id: string; role: string; task_id: string | null; epic_id: string | null;
  output: string | null; session_id: string | null; input_tokens: number | null; output_tokens: number | null;
  capability_json: string | null;
}
interface RequestRow { id: string; status: string; classification: string | null; plan_id: string | null; coordinator_run_id: string | null; failure_code: string | null; }
interface PendingPlan { id: string; status: string; epic_id: string | null; plan_json: string; }
interface ActiveProjectConfigRevision { revision_id: string; revision_hash: string; }

function assertRunUsesActiveProjectConfig(run: RunEvidence, active: ActiveProjectConfigRevision): void {
  let capability: unknown;
  try { capability = run.capability_json ? JSON.parse(run.capability_json) : null; }
  catch { throw new Error("REQUEST_EPIC_CAPABILITY_NOT_JSON"); }
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) throw new Error("REQUEST_EPIC_CAPABILITY_UNAVAILABLE");
  const binding = (capability as { approvedProjectConfig?: unknown }).approvedProjectConfig;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("REQUEST_EPIC_APPROVED_PROJECT_CONFIG_UNAVAILABLE");
  const approved = binding as { revisionId?: unknown; revisionHash?: unknown; config?: unknown };
  if (approved.revisionId !== active.revision_id || approved.revisionHash !== active.revision_hash) {
    throw new Error("REQUEST_EPIC_APPROVED_PROJECT_CONFIG_REVISION_MISMATCH");
  }
  const config = approved.config;
  const commands = config && typeof config === "object" && !Array.isArray(config)
    ? (config as { execution?: unknown }).execution
    : undefined;
  const test = commands && typeof commands === "object" && !Array.isArray(commands)
    ? (commands as { commands?: unknown }).commands
    : undefined;
  const testCommand = test && typeof test === "object" && !Array.isArray(test)
    ? (test as { test?: unknown }).test
    : undefined;
  if (!testCommand || typeof testCommand !== "object" || Array.isArray(testCommand) ||
      (testCommand as { executable?: unknown }).executable !== process.execPath ||
      JSON.stringify((testCommand as { args?: unknown }).args) !== JSON.stringify(["test/smoke.js"])) {
    throw new Error("REQUEST_EPIC_APPROVED_PROJECT_CONFIG_TEST_COMMAND_MISMATCH");
  }
}

describe("Request-to-Epic approved Project Config evidence", () => {
  it("accepts only the active revision and exact configured QA command", () => {
    const active = { revision_id: "revision-1", revision_hash: "a".repeat(64) };
    const run = {
      capability_json: JSON.stringify({ approvedProjectConfig: {
        revisionId: active.revision_id, revisionHash: active.revision_hash,
        config: { execution: { commands: { test: { executable: process.execPath, args: ["test/smoke.js"] } } } },
      } }),
    } as RunEvidence;
    expect(() => assertRunUsesActiveProjectConfig(run, active)).not.toThrow();
    const stale = { ...run, capability_json: run.capability_json?.replace(active.revision_id, "revision-old") ?? null };
    expect(() => assertRunUsesActiveProjectConfig(stale, active)).toThrow("REQUEST_EPIC_APPROVED_PROJECT_CONFIG_REVISION_MISMATCH");
    const wrongHash = { ...run, capability_json: run.capability_json?.replace(active.revision_hash, "b".repeat(64)) ?? null };
    expect(() => assertRunUsesActiveProjectConfig(wrongHash, active)).toThrow("REQUEST_EPIC_APPROVED_PROJECT_CONFIG_REVISION_MISMATCH");
    expect(() => assertRunUsesActiveProjectConfig({ ...run, capability_json: "{}" }, active))
      .toThrow("REQUEST_EPIC_APPROVED_PROJECT_CONFIG_UNAVAILABLE");
    expect(() => assertRunUsesActiveProjectConfig({ ...run, capability_json: "{" }, active))
      .toThrow("REQUEST_EPIC_CAPABILITY_NOT_JSON");
    const substituted = { ...run, capability_json: run.capability_json?.replace("test/smoke.js", "test/other.js") ?? null };
    expect(() => assertRunUsesActiveProjectConfig(substituted, active)).toThrow("REQUEST_EPIC_APPROVED_PROJECT_CONFIG_TEST_COMMAND_MISMATCH");
  });
});

/** Удаление fixture разрешено лишь после выхода процесса и доказанной остановки каждого Run. */
function canRemoveFixture(childrenExited: boolean, owners: readonly TeardownOwner[]): boolean {
  return childrenExited && owners.every((owner) => terminalStatuses.has(owner.status) && owner.state === "STOPPED" &&
    (owner.containment_kind === "windows-job" || owner.containment_kind === "systemd-user-service") &&
    isAuthoritativeRunProcessStopEvidence(owner.stop_evidence, owner.containment_kind));
}

/** Принимает только подтверждённый выход процесса с закрытыми pipe/IPC. */
function canAcceptChildExit(evidence: ChildExitEvidence): boolean {
  return evidence.exited && evidence.closeObserved &&
    (evidence.checkpointCrashVerified || (evidence.exitCode === 0 && evidence.shutdownObserved));
}

function childEnvironment(home: string, port: number, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of environmentAllowlist) {
    const actual = Object.keys(inherited).find((key) => key.toUpperCase() === name.toUpperCase());
    if (actual && inherited[actual] !== undefined) environment[name] = inherited[actual];
  }
  return { ...environment, EBB_ORCHESTRATOR_HOME: home, PORT: String(port) };
}

function launchChild(home: string, port: number, password?: string, pauseAfterApproval = false): ProductionChild {
  // Test-only checkpoint: the real API has materialized/claimed the approved Epic,
  // but no workspace or AgentRun has been created yet. The next child runs unmodified main.
  const checkpointBootstrap = `
    const { pathToFileURL } = await import('node:url');
    const { EpicWorkspaceProvisioner } = await import(pathToFileURL(process.argv[1]).href);
    EpicWorkspaceProvisioner.prototype.provisionForEpic = async function (epicId) {
      await new Promise((done, fail) => process.send({ type: 'request-epic:approved-checkpoint', epicId }, error => error ? fail(error) : done()));
      await new Promise(() => {});
    };
    await import(pathToFileURL(process.argv[2]).href);
  `;
  const childArgs = pauseAfterApproval
    ? ["--input-type=module", "-e", checkpointBootstrap, join(workspaceRoot, "apps/server/dist/modules/git/epic-workspace-provisioner.js"), serverFixture]
    : [serverFixture];
  const processChild = spawn(process.execPath, [...childArgs, ...(password ? ["--bootstrap-local-user-stdin"] : [])], {
    cwd: workspaceRoot, env: childEnvironment(home, port), shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const child = observeChild(processChild);
  if (password) processChild.stdin?.end(`${password}\n${password}\n`);
  else processChild.stdin?.end();
  return child;
}

function observeChild(processChild: ChildProcess): ProductionChild {
  const child: ProductionChild = { process: processChild, shutdownObserved: false, approvalEpicId: null, closeObserved: false, checkpointCrashVerified: false, diagnosticCodes: new Set() };
  processChild.once("close", () => { child.closeObserved = true; });
  // Keep only the lifecycle fact, never a retained raw subprocess transcript.
  const observe = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (text.includes("shutdown complete")) child.shutdownObserved = true;
    for (const code of safeCodesInText(text)) child.diagnosticCodes.add(code);
  };
  processChild.stdout?.on("data", observe);
  processChild.stderr?.on("data", observe);
  processChild.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "type" in message && "epicId" in message &&
        message.type === "request-epic:approved-checkpoint" && typeof message.epicId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(message.epicId)) {
      child.approvalEpicId = message.epicId;
    }
  });
  return child;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("REQUEST_EPIC_PORT_UNAVAILABLE");
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  return address.port;
}

async function waitForReady(child: ProductionChild, origin: string, timeoutMs = 90_000, database?: Database, epicId?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.process.exitCode !== null || child.process.signalCode !== null) {
      const exit = child.process.exitCode === null ? "NONE" : String(child.process.exitCode);
      const signal = child.process.signalCode ?? "NONE";
      const codes = [...child.diagnosticCodes].sort().join(",") || "NONE";
      const phase = database && epicId ? failedIntegrationDiagnostic(database, epicId) : null;
      throw new Error([`REQUEST_EPIC_CHILD_EXITED_BEFORE_READY:EXIT_${exit}:SIGNAL_${signal}:CODES_${codes}`, phase].filter(Boolean).join(":"));
    }
    const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    if (response?.ok && (await response.json() as { lifecycle?: unknown }).lifecycle === "READY") return;
    await sleep(200);
  }
  throw new Error("REQUEST_EPIC_READY_TIMEOUT");
}

function failedIntegrationDiagnostic(database: Database, epicId: string): string | null {
  const row = database.get<{ status: string; exit_code: number | null; output: string | null }>(
    `SELECT pr.status,ar.exit_code,ar.output FROM orchestration_phase_runs pr
     LEFT JOIN agent_runs ar ON ar.id=pr.agent_run_id
     WHERE pr.epic_id=$epicId AND pr.phase='integration' AND pr.status='FAILED' ORDER BY pr.ended_at DESC LIMIT 1`, { epicId });
  if (!row) return null;
  const codes = safeCodesInText(row.output ?? "").join(",") || "NONE";
  return `INTEGRATION_PHASE_FAILED:STATUS_${row.status}:EXIT_${row.exit_code ?? "NONE"}:CODES_${codes}`;
}

function childExitEvidence(child: ProductionChild): ChildExitEvidence {
  return {
    exited: child.process.exitCode !== null || child.process.signalCode !== null,
    exitCode: child.process.exitCode, closeObserved: child.closeObserved,
    shutdownObserved: child.shutdownObserved, checkpointCrashVerified: child.checkpointCrashVerified,
  };
}

/** Регистрирует close до остановки, затем проверяет закрытие всех каналов процесса. */
async function closeChild(child: ProductionChild, requestStop: () => Promise<void>): Promise<void> {
  if (child.closeObserved) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClose: (() => void) | undefined;
  const closed = new Promise<void>((done, fail) => {
    onClose = done;
    child.process.once("close", onClose);
    timer = setTimeout(() => fail(new Error("REQUEST_EPIC_CHILD_STOP_TIMEOUT")), 30_000);
  });
  void closed.catch(() => undefined);
  try {
    await Promise.all([childExitEvidence(child).exited ? Promise.resolve() : requestStop(), closed]);
  } finally {
    clearTimeout(timer);
    if (onClose) child.process.off("close", onClose);
  }
}

async function stopChild(child: ProductionChild): Promise<void> {
  await closeChild(child, () => new Promise<void>((done, fail) => {
    child.process.send("ebb-v1-crash-recovery:shutdown", (error) => error ? fail(error) : done());
  }));
  if (!canAcceptChildExit(childExitEvidence(child))) throw new Error("REQUEST_EPIC_CHILD_SHUTDOWN_NOT_VERIFIED");
}

/**
 * Прерывает только Orchestrator в подтверждённом approval checkpoint, где уже нет
 * активных Hermes Runs. Проверяет close; SIGKILL не выдаётся за graceful shutdown.
 */
async function crashCheckpointChild(child: ProductionChild, owners: readonly TeardownOwner[]): Promise<void> {
  if (child.checkpointCrashVerified) return;
  if (!child.approvalEpicId || childExitEvidence(child).exited || !canRemoveFixture(true, owners)) {
    throw new Error("REQUEST_EPIC_CHECKPOINT_CRASH_UNSAFE");
  }
  await closeChild(child, async () => {
    if (!child.process.kill("SIGKILL")) throw new Error("REQUEST_EPIC_CHECKPOINT_CRASH_FAILED");
  });
  if (!childExitEvidence(child).exited || (child.process.exitCode === 0 && child.process.signalCode === null)) {
    throw new Error("REQUEST_EPIC_CHECKPOINT_CRASH_NOT_VERIFIED");
  }
  child.checkpointCrashVerified = true;
}

/** Удаляет только stale lock завершённого production child внутри временной fixture. */
async function removeExitedFixtureLock(home: string, child: ProductionChild): Promise<void> {
  if (!childExitEvidence(child).exited || !child.closeObserved) {
    throw new Error("REQUEST_EPIC_CANNOT_REMOVE_LOCK_FOR_LIVE_FIXTURE_PROCESS");
  }
  const lockPath = join(home, "orchestrator.lock");
  const record = await readFile(lockPath, "utf8");
  if (!new RegExp(`^v1:${child.process.pid}:[0-9a-f]{32}\\n?$`, "u").test(record)) {
    throw new Error("REQUEST_EPIC_FIXTURE_LOCK_OWNER_MISMATCH");
  }
  await rm(lockPath);
}

async function login(origin: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${origin}/api/v1/session/login`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error("REQUEST_EPIC_LOGIN_FAILED");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = await response.json() as { csrfToken?: unknown };
  if (!cookie || typeof body.csrfToken !== "string") throw new Error("REQUEST_EPIC_SESSION_UNAVAILABLE");
  return { cookie, csrf: body.csrfToken };
}

function runs(database: Database): RunEvidence[] {
  return database.all<RunEvidence>(`SELECT r.id,r.role,r.task_id,r.epic_id,r.status,r.output,r.session_id,r.input_tokens,r.output_tokens,r.capability_json,
    o.state,o.stop_evidence,o.containment_kind FROM agent_runs r LEFT JOIN run_process_owners o ON o.run_id=r.id ORDER BY r.id`);
}

function assertLiveRun(run: RunEvidence): void {
  if (run.status !== "COMPLETED" || !run.output || !run.session_id || (run.input_tokens ?? 0) <= 0 || (run.output_tokens ?? 0) <= 0 || !canRemoveFixture(true, [run])) {
    throw new Error(`REQUEST_EPIC_RUN_NOT_VERIFIED:${run.role}:${run.status}:${run.state ?? "MISSING_OWNER"}`);
  }
  let output: unknown;
  try { output = JSON.parse(run.output); } catch { throw new Error(`REQUEST_EPIC_OUTPUT_NOT_JSON:${run.role}`); }
  const validation = validateRoleOutput(run.role, output);
  if (!validation.valid) throw new Error(`REQUEST_EPIC_OUTPUT_SCHEMA_REJECTED:${run.role}`);
  if (["reviewer", "qa", "integration"].includes(run.role.toLowerCase()) && validation.outcome !== "PASS") {
    throw new Error(`REQUEST_EPIC_ROLE_DID_NOT_PASS:${run.role}`);
  }
}

function requestSnapshot(database: Database, requestId: string): { request: RequestRow; plan: PendingPlan; runs: RunEvidence[] } {
  const request = database.get<RequestRow>("SELECT id,status,classification,plan_id,coordinator_run_id,failure_code FROM planning_requests WHERE id=$id", { id: requestId });
  const plan = request?.plan_id ? database.get<PendingPlan>("SELECT id,status,epic_id,plan_json FROM planning_plans WHERE id=$id", { id: request.plan_id }) : undefined;
  if (!request || !plan) throw new Error("REQUEST_EPIC_PLAN_LINK_UNAVAILABLE");
  return { request, plan, runs: runs(database) };
}

function snapshotDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function waitForPendingPlan(database: Database, requestId: string, child: ProductionChild): Promise<void> {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const row = database.get<RequestRow>("SELECT id,status,classification,plan_id,coordinator_run_id,failure_code FROM planning_requests WHERE id=$id", { id: requestId });
    if (row?.status === "PLAN_PENDING_APPROVAL") return;
    if (row && ["FAILED", "NEEDS_INPUT", "REJECTED", "MATERIALIZED"].includes(row.status)) {
      throw new Error(`REQUEST_EPIC_PLANNING_STOPPED:${row.status}:${/^[A-Z0-9_]+$/u.test(row.failure_code ?? "") ? row.failure_code : "NO_STABLE_CODE"}`);
    }
    if (child.process.exitCode !== null || child.process.signalCode !== null) throw new Error("REQUEST_EPIC_CHILD_EXITED_DURING_PLANNING");
    await sleep(200);
  }
  throw new Error("REQUEST_EPIC_PLANNING_TIMEOUT");
}

async function gitSucceeded(repository: string, args: string[]): Promise<string> {
  const result = await new GitCli().run(repository, args);
  if (result.exitCode !== 0) throw new Error("REQUEST_EPIC_FIXTURE_GIT_FAILED");
  return result.stdout.trim();
}

/** Подтверждает именно запрошенные роли, шаблон, required-флаги и направление графа. */
function assertFixturePlan(value: unknown): void {
  const parsed = CoordinatorPlanSchema.safeParse(value);
  if (!parsed.success || !parsed.data.epic || parsed.data.tasks.length !== 2) throw new Error("REQUEST_EPIC_FIXTURE_PLAN_INVALID");
  const first = parsed.data.tasks.find((task) => task.ref === "task_health");
  const second = parsed.data.tasks.find((task) => task.ref === "task_documentation");
  if (!first || !second || parsed.data.tasks.some((task) => task.role !== "developer" || task.workflow !== "standard" || task.optional) ||
      first.dependsOn.length !== 0 || second.dependsOn.length !== 1 || second.dependsOn[0] !== first.ref) {
    throw new Error("REQUEST_EPIC_FIXTURE_PLAN_SCOPE_MISMATCH");
  }
}

function assertTaskPhaseRoleCoverage(
  rows: readonly { task_id: string | null; phase: string; role: string }[],
  taskIds: readonly string[],
): void {
  const expected = taskIds.flatMap((task_id) => [
    { task_id, phase: "child_task", role: "developer" },
    { task_id, phase: "review", role: "reviewer" },
    { task_id, phase: "qa", role: "qa" },
    { task_id, phase: "integration", role: "integration" },
  ]).sort((left, right) => `${left.task_id}:${left.phase}:${left.role}`.localeCompare(`${right.task_id}:${right.phase}:${right.role}`));
  const actual = rows.filter((row) => row.task_id !== null && taskIds.includes(row.task_id))
    .map(({ task_id, phase, role }) => ({ task_id, phase, role }))
    .sort((left, right) => `${left.task_id}:${left.phase}:${left.role}`.localeCompare(`${right.task_id}:${right.phase}:${right.role}`));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("REQUEST_EPIC_TASK_PHASE_ROLE_COVERAGE_MISMATCH");
}

function assertPreApprovalIsolation(database: Database, projectId: string, baseline: { worktrees: unknown[]; gitOperations: unknown[] }): void {
  expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE project_id=$id AND (kind='TASK' OR kind='LOCK' OR status='RESERVED')", { id: projectId })?.count).toBe(0);
  expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE project_id=$id", { id: projectId })?.count).toBe(0);
  expect(database.all("SELECT * FROM worktrees ORDER BY id")).toEqual(baseline.worktrees);
  expect(database.all("SELECT * FROM git_operations ORDER BY id")).toEqual(baseline.gitOperations);
  expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(0);
  expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
  expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM orchestration_phase_runs")?.count).toBe(0);
}

describe("Plan19 Task5 acceptance safeguards (provider-free)", () => {
  it("extracts only explicitly allowlisted stable diagnostics from arbitrary child output", () => {
    expect(safeCodesInText("Error: EPIC_INTEGRATION_SERVICE_UNAVAILABLE token=secret\ncustom secret text"))
      .toEqual(["EPIC_INTEGRATION_SERVICE_UNAVAILABLE"]);
    expect(safeCodesInText("Error: INTEGRATION_PREPARE_ROOT_CREATE_FAILED\nINTEGRATION_PREPARE_HOOKS_DIR_CREATE_FAILED"))
      .toEqual(["INTEGRATION_PREPARE_HOOKS_DIR_CREATE_FAILED", "INTEGRATION_PREPARE_ROOT_CREATE_FAILED"]);
    expect(safeCodesInText("Error: INTEGRATION_PREPARE_REFS_FAILED:GIT_EXIT_128:PERMISSION"))
      .toEqual(["INTEGRATION_PREPARE_REFS_FAILED:GIT_EXIT_128:PERMISSION"]);
    expect(safeCodesInText("Run stopped: WINDOWS_PROCESS_SCOPE_TIMEOUT; raw output omitted"))
      .toEqual(["WINDOWS_PROCESS_SCOPE_TIMEOUT"]);
    expect(safeCodesInText("INTEGRATION_PREPARE_REFS_FAILED:GIT_EXIT_128:/private/path" )).toEqual([]);
    expect(safeCodesInText("provider says HERMES_PRIVATE_ERROR and raw OPENAI_API_KEY=secret" )).toEqual([]);
  });
  it("accepts only a verified checkpoint crash with closed IPC and pipe handles", () => {
    const crashed = { exited: true, exitCode: null, closeObserved: true, shutdownObserved: false, checkpointCrashVerified: true };
    expect(canAcceptChildExit(crashed)).toBe(true);
    expect(canAcceptChildExit({ ...crashed, checkpointCrashVerified: false })).toBe(false);
    expect(canAcceptChildExit({ ...crashed, closeObserved: false })).toBe(false);
    expect(canAcceptChildExit({ ...crashed, exited: false })).toBe(false);
    expect(canAcceptChildExit({ ...crashed, exitCode: 0, checkpointCrashVerified: false, shutdownObserved: true })).toBe(true);
  });
  it("kills and waits for a checkpoint process only after all Run owners are stopped", async () => {
    const processChild = spawn(process.execPath, ["-e", "process.send({type:'request-epic:approved-checkpoint',epicId:'test-epic'});setInterval(()=>{},1000);"], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: childEnvironment("unused-test-home", 1234),
    });
    const child = observeChild(processChild);
    processChild.stdin?.end();
    try {
      const deadline = Date.now() + 10_000;
      while (!child.approvalEpicId && !childExitEvidence(child).exited && Date.now() < deadline) await sleep(25);
      expect(child.approvalEpicId).toBe("test-epic");
      await expect(crashCheckpointChild(child, [{ status: "IN_PROGRESS", state: "LIVE", stop_evidence: null, containment_kind: "windows-job" }]))
        .rejects.toThrow("REQUEST_EPIC_CHECKPOINT_CRASH_UNSAFE");
      expect(childExitEvidence(child).exited).toBe(false);
      await crashCheckpointChild(child, [{ status: "COMPLETED", state: "STOPPED", stop_evidence: "WINDOWS_JOB_EMPTY", containment_kind: "windows-job" }]);
      expect(child.checkpointCrashVerified).toBe(true);
      expect(child.closeObserved).toBe(true);
      expect(child.shutdownObserved).toBe(false);
      await expect(stopChild(child)).resolves.toBeUndefined();
    } finally {
      // This is an inert Node fixture, never a provider or production Orchestrator.
      await closeChild(child, async () => { if (!child.process.kill("SIGKILL")) throw new Error("REQUEST_EPIC_INERT_CHILD_CLEANUP_FAILED"); });
    }
  }, 45_000);
  it("retains a fixture when the Orchestrator exited but a Hermes scope remains live", () => {
    expect(canRemoveFixture(true, [{ status: "IN_PROGRESS", state: "LIVE", stop_evidence: null, containment_kind: "windows-job" }])).toBe(false);
  });
  it("retains fixtures without owner proof, and while the Orchestrator is alive", () => {
    expect(canRemoveFixture(true, [{ status: "COMPLETED", state: null, stop_evidence: null, containment_kind: null }])).toBe(false);
    expect(canRemoveFixture(false, [])).toBe(false);
    expect(canRemoveFixture(true, [])).toBe(true);
  });
  it("requires a canonical platform-specific stop proof for every terminal Run", () => {
    const stopped = { status: "COMPLETED", state: "STOPPED", stop_evidence: "WINDOWS_JOB_EMPTY", containment_kind: "windows-job" };
    expect(canRemoveFixture(true, [stopped])).toBe(true);
    expect(canRemoveFixture(true, [{ ...stopped, stop_evidence: "PID_EXITED" }])).toBe(false);
    expect(canRemoveFixture(true, [{ ...stopped, containment_kind: "systemd-user-service" }])).toBe(false);
  });
  it("preserves non-secret configured Hermes selectors while excluding credentials", () => {
    expect(childEnvironment("fixture-home", 1234, { PATH: "system", USERPROFILE: "normal-user", OPENAI_API_KEY: "private", GITHUB_TOKEN: "private", HERMES_HOME: "selected-home", HERMES_PROFILE: "selected-profile", HERMES_CONFIG: "selected-config", HERMES_MODEL: "selected-model", EBB_ORCHESTRATOR_HOME: "old" }))
      .toEqual({ PATH: "system", USERPROFILE: "normal-user", HERMES_HOME: "selected-home", HERMES_PROFILE: "selected-profile", HERMES_CONFIG: "selected-config", HERMES_MODEL: "selected-model", EBB_ORCHESTRATOR_HOME: "fixture-home", PORT: "1234" });
  });
  it("rejects changed roles, workflow, optional tasks, duplicate refs and reversed dependencies", () => {
    const plan = { epic: { title: "Health endpoint" }, tasks: [
      { ref: "task_health", title: "Implement health", role: "developer", workflow: "standard", acceptanceCriteria: ["endpoint works"], dependsOn: [] },
      { ref: "task_documentation", title: "Document health", role: "developer", workflow: "standard", acceptanceCriteria: ["documentation is accurate"], dependsOn: ["task_health"] },
    ] };
    expect(() => assertFixturePlan(plan)).not.toThrow();
    for (const delta of [{ role: "architect" }, { workflow: "documentation" }, { optional: true }, { ref: "task_health" }, { dependsOn: [] }]) {
      expect(() => assertFixturePlan({ ...plan, tasks: [plan.tasks[0], { ...plan.tasks[1], ...delta }] })).toThrow("REQUEST_EPIC_FIXTURE_PLAN_SCOPE_MISMATCH");
    }
    expect(() => assertFixturePlan({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["task_documentation"] }, { ...plan.tasks[1], dependsOn: [] }] })).toThrow("REQUEST_EPIC_FIXTURE_PLAN_SCOPE_MISMATCH");
  });
  it("requires each Task to have exactly the persisted Developer, Reviewer, QA and Integration phases", () => {
    const taskIds = ["task-a", "task-b"];
    const rows = taskIds.flatMap((task_id) => [
      { task_id, phase: "child_task", role: "developer" },
      { task_id, phase: "review", role: "reviewer" },
      { task_id, phase: "qa", role: "qa" },
      { task_id, phase: "integration", role: "integration" },
    ]);
    expect(() => assertTaskPhaseRoleCoverage(rows, taskIds)).not.toThrow();
    expect(() => assertTaskPhaseRoleCoverage(rows.filter((row) => row.task_id !== "task-b" || row.phase !== "qa"), taskIds))
      .toThrow("REQUEST_EPIC_TASK_PHASE_ROLE_COVERAGE_MISMATCH");
    expect(() => assertTaskPhaseRoleCoverage([...rows, { task_id: "task-a", phase: "qa", role: "developer" }], taskIds))
      .toThrow("REQUEST_EPIC_TASK_PHASE_ROLE_COVERAGE_MISMATCH");
  });
});

describe.skipIf(!enabled || !["win32", "linux"].includes(process.platform))("Plan19 Task5 — real Hermes Request to Epic across production restarts", () => {
  let root = "";
  let database: Database | undefined;
  const children: ProductionChild[] = [];

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    for (const child of children) {
      try {
        if (child.approvalEpicId && !child.checkpointCrashVerified && !childExitEvidence(child).exited) {
          if (!database) throw new Error("REQUEST_EPIC_CHECKPOINT_OWNERS_UNAVAILABLE");
          await crashCheckpointChild(child, runs(database));
        } else await stopChild(child);
      } catch (error) { cleanupErrors.push(error); }
    }
    const exited = children.every((child) => canAcceptChildExit(childExitEvidence(child)));
    const safeToRemove = database ? canRemoveFixture(exited, runs(database)) : exited;
    database?.close();
    database = undefined;
    if (root && safeToRemove) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    else if (root) cleanupErrors.push(new Error(`REQUEST_EPIC_FIXTURE_RETAINED:${root}`));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "REQUEST_EPIC_TEARDOWN_NOT_VERIFIED");
  }, 150_000);

  it("keeps the same Request pending approval after restart, then recovers the approved Epic only to FINAL_APPROVAL", async () => {
    root = await mkdtemp(join(tmpdir(), "ebb-request-epic-hermes-"));
    const home = join(root, ".ebb-orchestrator");
    const homePaths = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: home }, process.platform as "win32" | "linux");
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const password = randomUUID();
    const first = launchChild(home, port, password);
    children.push(first);
    await waitForReady(first, origin);
    database = createSqliteDatabase(homePaths.database);
    const repository = join(root, "repository");
    await mkdir(repository);
    await cp(join(import.meta.dirname, "fixtures/health-service"), repository, { recursive: true });
    await gitSucceeded(repository, ["init", "--initial-branch=master"]);
    await gitSucceeded(repository, ["config", "user.email", "acceptance@example.invalid"]);
    await gitSucceeded(repository, ["config", "user.name", "Acceptance Fixture"]);
    await gitSucceeded(repository, ["add", "."]);
    await gitSucceeded(repository, ["commit", "-m", "Initial Request-to-Epic acceptance fixture"]);
    const initialMaster = await gitSucceeded(repository, ["rev-parse", "master"]);
    const smokeHash = createHash("sha256").update(await readFile(join(repository, "test/smoke.js"))).digest("hex");
    const approvals = new ApprovalService(database);
    const onboarding = new OnboardingService(database, approvals);
    const draft = await onboarding.discoverAndCreateDraft(repository);
    onboarding.requestApproval(draft.projectId, { defaultBranch: "master", workflow: "standard", roles: ["developer", "reviewer", "qa", "integration"], guidelines: ["Use the disposable acceptance repository."] });
    onboarding.approve(draft.projectId);
    onboarding.activate(draft.projectId);
    // Infrastructure configuration fixture only; all planning/workflow role outputs are genuine.
    seedApprovedProjectConfig(database, draft.projectId, "master", {
      test: { executable: process.execPath, args: ["test/smoke.js"] },
    });
    database.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1000000,0,0)", { projectId: draft.projectId });
    const prePlanningBaseline = { worktrees: database.all("SELECT * FROM worktrees ORDER BY id"), gitOperations: database.all("SELECT * FROM git_operations ORDER BY id") };
    const auth = await login(origin, password);
    const response = await fetch(`${origin}/api/v1/projects/${draft.projectId}/requests`, {
      method: "POST", headers: { origin, cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ request: "Build a small Epic with exactly two required Developer Tasks using standard workflow. Use temporary refs task_health and task_documentation. task_health must have no dependencies; task_documentation must depend only on task_health. Task one (task_health): make only the minimum required edit to the existing src/server.js so GET /health returns HTTP 200 and JSON {status:'ok'}, while GET / returns 404. Task two (task_documentation): make only the minimum required edit to the existing README.md documenting the implemented GET /health endpoint and its source code. No other files, dependencies, authentication, external services, or architecture changes are needed. Developer instructions: do not run tests or linters and do not claim verification; submit a structured result with submit_result listing the changed files and a concise change summary. Reviewer: inspect the Task changes against their acceptance criteria and confirm that only the requested files and behavior changed. QA: run the approved Project Config test command exactly as configured (`node test/smoke.js`, executable `process.execPath`, args `test/smoke.js`) and report its result; do not substitute a mock or another command. The harness independently checks that the original test/smoke.js remains unchanged." }),
    });
    if (response.status !== 202) throw new Error(`REQUEST_EPIC_CREATE_REQUEST_HTTP_${response.status}`);
    const created = await response.json() as { requestId?: unknown; status?: unknown };
    if (typeof created.requestId !== "string" || created.status !== "RECEIVED") throw new Error("REQUEST_EPIC_CREATE_REQUEST_RESPONSE_INVALID");
    const requestId = created.requestId;
    await waitForPendingPlan(database, requestId, first);
    const pending = requestSnapshot(database, requestId);
    expect(pending.request).toMatchObject({ id: requestId, status: "PLAN_PENDING_APPROVAL", classification: "EPIC", failure_code: null });
    expect(pending.plan).toMatchObject({ status: "PENDING", epic_id: null });
    expect(pending.runs.map((run) => run.role).sort()).toEqual(["architect", "coordinator", "product_manager"]);
    pending.runs.forEach(assertLiveRun);
    expect(pending.runs.every((run) => run.task_id === null && run.epic_id === null)).toBe(true);
    expect(pending.runs.find((run) => run.role === "coordinator")?.id).toBe(pending.request.coordinator_run_id);
    const plan = JSON.parse(pending.plan.plan_json) as { epic?: unknown; tasks: unknown; planningDecisions?: unknown };
    const coordinatorJson = pending.runs.find((run) => run.role === "coordinator")?.output;
    if (!coordinatorJson) throw new Error("REQUEST_EPIC_COORDINATOR_OUTPUT_MISSING");
    const coordinatorOutput = CoordinatorOutputSchema.parse(JSON.parse(coordinatorJson));
    assertFixturePlan(coordinatorOutput.plan);
    assertFixturePlan({ epic: plan.epic, tasks: plan.tasks });
    expect({ epic: plan.epic, tasks: plan.tasks }).toEqual(coordinatorOutput.plan);
    const decisions = validatePlanningDecisions(plan.planningDecisions);
    for (const role of ["product_manager", "architect"] as const) {
      const actual = pending.runs.find((run) => run.role === role)?.output;
      if (!actual) throw new Error("REQUEST_EPIC_PLANNING_DECISION_NOT_PERSISTED");
      expect(JSON.parse(actual)).toEqual(role === "architect" ? decisions.architect : decisions.productManager);
    }
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_request_role_runs WHERE request_id=$id", { id: requestId })?.count).toBe(2);
    assertPreApprovalIsolation(database, draft.projectId, prePlanningBaseline);
    await stopChild(first);

    const second = launchChild(home, port, undefined, true);
    children.push(second);
    await waitForReady(second, origin);
    expect(snapshotDigest(requestSnapshot(database, requestId))).toBe(snapshotDigest(pending));
    assertPreApprovalIsolation(database, draft.projectId, prePlanningBaseline);
    const secondAuth = await login(origin, password);
    const approveUrl = `${origin}/api/v1/projects/${draft.projectId}/epics/plans/${pending.plan.id}/approve-run`;
    // First prove the HTTP gate rejects a request without an authenticated session.
    const unauthenticated = await fetch(approveUrl, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ requestId }) });
    expect([401, 403]).toContain(unauthenticated.status);
    expect(snapshotDigest(requestSnapshot(database, requestId))).toBe(snapshotDigest(pending));
    assertPreApprovalIsolation(database, draft.projectId, prePlanningBaseline);

    // Explicit test-human POST uses the actual session/CSRF gate. The endpoint waits
    // for workflow completion, so this request deliberately remains in flight at the
    // child checkpoint after durable approval, before the first workspace/AgentRun.
    let approvalResponseStatus: number | null | undefined;
    const approvalRequest = fetch(approveUrl, {
      method: "POST", headers: { origin, cookie: secondAuth.cookie, "x-csrf-token": secondAuth.csrf, "content-type": "application/json" },
      body: JSON.stringify({ requestId }), signal: AbortSignal.timeout(90_000),
    }).then((approvalResponse) => { approvalResponseStatus = approvalResponse.status; }, () => { approvalResponseStatus = null; });
    const approvalDeadline = Date.now() + 60_000;
    while (second.approvalEpicId === null) {
      if (approvalResponseStatus !== undefined || second.process.exitCode !== null || second.process.signalCode !== null || Date.now() > approvalDeadline) {
        throw new Error(`REQUEST_EPIC_API_APPROVAL_CHECKPOINT_NOT_REACHED:HTTP_${approvalResponseStatus ?? "UNAVAILABLE"}`);
      }
      await sleep(50);
    }
    expect(requestSnapshot(database, requestId).plan.status).toBe("APPROVED");
    expect(database.get<{ approved_by: string; approved_at: string | null }>("SELECT approved_by,approved_at FROM planning_plans WHERE id=$id", { id: pending.plan.id })).toMatchObject({ approved_by: "local-user", approved_at: expect.any(String) });
    const approvalEvents = database.all<{ id: string; payload_json: string }>("SELECT id,payload_json FROM outbox_events WHERE type='PlanApproved' AND aggregate_id=$id", { id: pending.plan.id });
    expect(approvalEvents).toHaveLength(1);
    const approvalEvent = approvalEvents[0];
    if (!approvalEvent) throw new Error("REQUEST_EPIC_APPROVAL_EVENT_MISSING");
    expect(JSON.parse(approvalEvent.payload_json)).toMatchObject({ planId: pending.plan.id, approvedBy: "local-user" });
    const epicId = requestSnapshot(database, requestId).plan.epic_id;
    if (!epicId) throw new Error("REQUEST_EPIC_APPROVAL_DID_NOT_MATERIALIZE_EPIC");
    expect(second.approvalEpicId).toBe(epicId);
    expect(snapshotDigest(runs(database))).toBe(snapshotDigest(pending.runs));
    expect(database.all("SELECT * FROM worktrees ORDER BY id")).toEqual(prePlanningBaseline.worktrees);
    expect(database.all("SELECT * FROM git_operations ORDER BY id")).toEqual(prePlanningBaseline.gitOperations);
    const taskIds = database.all<{ id: string }>("SELECT id FROM tasks WHERE epic_id=$id ORDER BY id", { id: epicId }).map((task) => task.id);
    expect(taskIds).toHaveLength(2);
    await crashCheckpointChild(second, runs(database));
    // SingleInstanceLock deliberately fails closed on any existing file. Clear only
    // this fixture's verified owner record after the checkpoint process is fully closed.
    await removeExitedFixtureLock(home, second);
    await approvalRequest;
    expect(approvalResponseStatus).toBeNull();
    const third = launchChild(home, port);
    children.push(third);
    await waitForReady(third, origin, 25 * 60_000, database, epicId);
    const orchestration = database.get<{ stage: string; final_approval_id: string | null; recovery_failure_code: string | null }>("SELECT stage,final_approval_id,recovery_failure_code FROM epic_orchestrations WHERE epic_id=$id", { id: epicId });
    expect(orchestration).toMatchObject({ stage: "FINAL_APPROVAL", recovery_failure_code: null });
    if (!orchestration?.final_approval_id) throw new Error("REQUEST_EPIC_FINAL_APPROVAL_MISSING");
    const finalApproval = database.get<{ id: string; status: string; subject_id: string; type: string }>("SELECT id,status,subject_id,type FROM approvals WHERE id=$id", { id: orchestration.final_approval_id });
    expect(finalApproval).toEqual({ id: orchestration.final_approval_id, status: "PENDING", subject_id: epicId, type: "FINAL_MERGE" });
    const finalRuns = runs(database);
    finalRuns.forEach(assertLiveRun);
    expect(finalRuns).toHaveLength(15);
    const activeProjectConfig = database.get<ActiveProjectConfigRevision>(`SELECT revision.revision_id,revision.revision_hash
      FROM project_config_state state
      JOIN project_config_revisions revision ON revision.revision_id=state.active_revision_id AND revision.project_id=state.project_id
      JOIN approvals approval ON approval.id=revision.approval_id AND approval.subject_id=revision.project_id
        AND approval.subject_type='PROJECT' AND approval.type='WORKFLOW_CHANGE' AND approval.status='APPROVED'
      WHERE state.project_id=$projectId`, { projectId: draft.projectId });
    if (!activeProjectConfig || !/^[0-9a-f]{64}$/u.test(activeProjectConfig.revision_hash)) {
      throw new Error("REQUEST_EPIC_ACTIVE_PROJECT_CONFIG_REVISION_UNAVAILABLE");
    }
    const qaRuns = finalRuns.filter((candidate) => candidate.role.toLowerCase() === "qa");
    expect(qaRuns.length).toBeGreaterThan(0);
    for (const run of qaRuns) {
      assertRunUsesActiveProjectConfig(run, activeProjectConfig);
    }
    const phases = database.all<{ id: string; agent_run_id: string; status: string; validated: number }>("SELECT id,agent_run_id,status,validated FROM orchestration_phase_runs WHERE epic_id=$id ORDER BY id", { id: epicId });
    expect(phases).toHaveLength(12);
    expect(new Set(phases.map((phase) => phase.agent_run_id)).size).toBe(phases.length);
    expect(phases.every((phase) => phase.status === "COMPLETED" && phase.validated === 1)).toBe(true);
    assertTaskPhaseRoleCoverage(
      database.all<{ task_id: string | null; phase: string; role: string }>(
        "SELECT task_id,phase,role FROM orchestration_phase_runs WHERE epic_id=$id", { id: epicId }),
      taskIds,
    );
    expect(database.all<{ id: string; status: string }>("SELECT id,status FROM tasks WHERE epic_id=$id ORDER BY id", { id: epicId })).toEqual(taskIds.map((id) => ({ id, status: "INTEGRATED_INTO_EPIC" })));
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")?.count).toBe(0);
    expect(await gitSucceeded(repository, ["rev-parse", "master"])).toBe(initialMaster);
    const epicWorktree = database.get<{ path: string }>("SELECT path FROM worktrees WHERE id=$id", { id: `epic:${epicId}` });
    if (!epicWorktree) throw new Error("REQUEST_EPIC_MANAGED_WORKTREE_UNAVAILABLE");
    expect(createHash("sha256").update(await readFile(join(epicWorktree.path, "test/smoke.js"))).digest("hex")).toBe(smokeHash);
    const finalRequest = requestSnapshot(database, requestId);
    expect(finalRequest.request.status).toBe("MATERIALIZED");
    const approvalsBefore = database.all<{ id: string; status: string }>("SELECT id,status FROM approvals WHERE subject_id=$id AND type='FINAL_MERGE' ORDER BY id", { id: epicId });
    expect(approvalsBefore).toEqual([{ id: orchestration.final_approval_id, status: "PENDING" }]);
    await stopChild(third);

    const fourth = launchChild(home, port);
    children.push(fourth);
    await waitForReady(fourth, origin);
    expect(snapshotDigest(requestSnapshot(database, requestId))).toBe(snapshotDigest(finalRequest));
    expect(database.all("SELECT id,agent_run_id,status,validated FROM orchestration_phase_runs WHERE epic_id=$id ORDER BY id", { id: epicId })).toEqual(phases);
    expect(database.all("SELECT id,status FROM approvals WHERE subject_id=$id AND type='FINAL_MERGE' ORDER BY id", { id: epicId })).toEqual(approvalsBefore);
    expect(database.all<{ id: string }>("SELECT id FROM tasks WHERE epic_id=$id ORDER BY id", { id: epicId }).map((task) => task.id)).toEqual(taskIds);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_requests")?.count).toBe(1);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(1);
    expect(database.all("SELECT id,payload_json FROM outbox_events WHERE type='PlanApproved' AND aggregate_id=$id", { id: pending.plan.id })).toEqual(approvalEvents);
    expect(await gitSucceeded(repository, ["rev-parse", "master"])).toBe(initialMaster);
    await stopChild(fourth);
    const evidenceDirectory = await mkdtemp(join(tmpdir(), "ebb-request-epic-evidence-"));
    const evidencePath = join(evidenceDirectory, "project-config-revision.json");
    await writeFile(evidencePath, `${JSON.stringify({ revisionId: activeProjectConfig.revision_id, revisionHash: activeProjectConfig.revision_hash })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`REQUEST_EPIC_HERMES_FLOW_VERIFIED:planningRuns=3:epicRuns=12:restarts=3:stage=FINAL_APPROVAL:finalMerge=PENDING:evidenceFile=${evidencePath}\n`);
  }, 60 * 60_000);
});
