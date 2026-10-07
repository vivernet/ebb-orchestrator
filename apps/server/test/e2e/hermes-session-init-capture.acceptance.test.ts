import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { effectiveRunToolIds, RunService } from "../../src/modules/runtime/run-service.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";
import type { PreparedRunContext } from "../../src/modules/context/context-types.js";
import { digestRunPromptBytesV1 } from "../../src/modules/context/context-provenance.js";
import type { HermesSessionCapture, HermesSessionCapturePort } from "../../src/modules/runtime/hermes-session-capture-port.js";
import { HermesStreamSessionObserver } from "../../src/modules/runtime/hermes/hermes-stream-session-observer.js";
import { HermesRuntimeAdapter } from "../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../src/modules/runtime/hermes/hermes-provider-selection.js";
import type { HermesRunSelection } from "../../src/modules/runtime/hermes/hermes-run-selection.js";
import { createHermesAuthRouteFixture } from "../helpers/hermes-auth-route-fixture.js";
import { createHermesLaunchTicket } from "../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../src/platform/process/process-inspector.js";
import type { Database } from "../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { ProcessExecutor } from "../../src/platform/process/process-executor.js";
import type { ProcessScopeLaunchRequest, ProcessScopeSupervisor } from "../../src/platform/process/run-scope-supervisor.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";

const encoder = new TextEncoder();
const UNALLOWLISTED_FIXTURE_FIELD_MARKER = "fixture-unallowlisted-field-marker";
let database: Database | undefined;
let directory = "";

class CaptureFixtureRuntime extends FakeAgentRuntime implements HermesSessionCapturePort {
  captureHandler: ((capture: HermesSessionCapture) => Promise<void>) | undefined;

  setHermesSessionCaptureHandler(handler: (capture: HermesSessionCapture) => Promise<void>): void {
    this.captureHandler = handler;
  }
}

class ControlledCaptureSupervisor implements ProcessScopeSupervisor {
  private observation: ProcessScopeObservation = { state: "UNKNOWN", reason: "TEST_OWNER_MISSING" };
  captureWhileLive: { session_id: string | null; capture_state: string; owner_state: string } | undefined;

  constructor(private readonly database: Database) {}

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ) {
    const identity: ProcessScopeIdentity = process.platform === "win32"
      ? { ...owner, state: "LIVE", platform: "win32", pid: 303, supervisorPid: 202,
          supervisorStartIdentity: "fixture-supervisor-start", processStartIdentity: "fixture-process-start",
          executableIdentity: request.executable }
      : { ...owner, state: "LIVE", platform: "linux", pid: 303,
          systemdInvocationId: "12345678-1234-1234-1234-123456789abc",
          systemdControlGroup: `/user.slice/ebb-${owner.containmentId}.service` };
    this.observation = { state: "LIVE", identity };
    await persistVerifiedIdentity(identity);
    const initEvent = encoder.encode(`${JSON.stringify({
      type: "system", subtype: "init", session_id: "session-adapter-live-001",
      text: UNALLOWLISTED_FIXTURE_FIELD_MARKER,
    })}\n`);
    await request.onStdoutChunk?.(initEvent);
    this.captureWhileLive = this.database.get(
      `SELECT run.session_id,owner.capture_state,owner.state AS owner_state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: owner.runId },
    );
    expect(identity.state).toBe("LIVE");
    expect(this.captureWhileLive).toEqual({
      session_id: "session-adapter-live-001", capture_state: "BOUND", owner_state: "LIVE",
    });

    return {
      completion: Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }).then((result) => {
        this.observation = { state: "STOPPED", evidence: this.stoppedEvidence() };
        return result;
      }),
    };
  }

  async inspect(): Promise<ProcessScopeObservation> {
    return this.observation;
  }

  async stop(): Promise<ProcessScopeObservation> {
    this.observation = { state: "STOPPED", evidence: this.stoppedEvidence() };
    return this.observation;
  }

  private stoppedEvidence(): string {
    return process.platform === "win32" ? "WINDOWS_JOB_EMPTY" : "SYSTEMD_CGROUP_EMPTY";
  }

  async waitForStopped(): Promise<ProcessScopeObservation> {
    return this.observation;
  }
}

describe("Hermes init capture bridge — controlled protocol fixture only", () => {
  afterEach(async () => {
    database?.close();
    database = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("projects one fixture init ID and durably binds it to the exact LIVE SQLite owner", async () => {
    const fixture = await setup();
    const observer = new HermesStreamSessionObserver();
    const rawEvent = encoder.encode(`${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-fixture-001",
      text: UNALLOWLISTED_FIXTURE_FIELD_MARKER,
      provider: UNALLOWLISTED_FIXTURE_FIELD_MARKER,
    })}\n`);
    const observed = observer.push(rawEvent);

    expect(observed).toEqual({
      status: "captured",
      projection: { type: "system", subtype: "init", sessionId: "session-fixture-001" },
    });
    if (observed.status !== "captured" || !observed.projection || !fixture.captureHandler) {
      throw new Error("SESSION_CAPTURE_FIXTURE_SETUP_FAILED");
    }

    await fixture.captureHandler({
      runId: fixture.run.id,
      attempt: null,
      sourceTag: fixture.owner.sourceTag,
      hermesHome: fixture.owner.hermesHome,
      owner: fixture.identity,
      status: "captured",
      sessionId: observed.projection.sessionId,
    });

    expect(database!.get<{ session_id: string | null }>(
      "SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id },
    )).toEqual({ session_id: "session-fixture-001" });
    expect(database!.get<{ capture_state: string; state: string }>(
      "SELECT capture_state,state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id },
    )).toEqual({ capture_state: "BOUND", state: "LIVE" });
    // Ограничено allowlisted observer projection и явно выбранными SQLite-полями; проверка
    // не инспектирует логи, артефакты или остальные таблицы/поля базы данных.
    const selectedSafeColumns = database!.get(
      `SELECT run.session_id,owner.capture_state,owner.state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: fixture.run.id },
    );
    expect(JSON.stringify({ observerProjection: observed, selectedSafeColumns }))
      .not.toContain(UNALLOWLISTED_FIXTURE_FIELD_MARKER);

    database!.close();
    database = createSqliteDatabase(join(directory, "capture.sqlite"));
    expect(database.get<{ session_id: string | null; capture_state: string; state: string }>(
      `SELECT run.session_id,owner.capture_state,owner.state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: fixture.run.id },
    )).toEqual({ session_id: "session-fixture-001", capture_state: "BOUND", state: "LIVE" });
  });

  it("keeps duplicate-init protocol violations invalid and prevents a later fixture callback from rebinding", async () => {
    const fixture = await setup();
    const observer = new HermesStreamSessionObserver();
    const first = observer.push(encodeInit("session-fixture-002"));
    const duplicate = observer.push(encodeInit("session-fixture-003"));

    expect(first.status).toBe("captured");
    expect(duplicate).toEqual({ status: "invalid", reason: "DUPLICATE_INIT" });
    if (duplicate.status !== "invalid" || !fixture.captureHandler) {
      throw new Error("SESSION_CAPTURE_FIXTURE_SETUP_FAILED");
    }

    await fixture.captureHandler({
      runId: fixture.run.id,
      attempt: null,
      sourceTag: fixture.owner.sourceTag,
      hermesHome: fixture.owner.hermesHome,
      owner: fixture.identity,
      status: "invalid",
      reason: duplicate.reason,
    });
    await expect(fixture.captureHandler!({
      runId: fixture.run.id,
      attempt: null,
      sourceTag: fixture.owner.sourceTag,
      hermesHome: fixture.owner.hermesHome,
      owner: fixture.identity,
      status: "captured",
      sessionId: "session-fixture-002",
    })).rejects.toThrow("HERMES_SESSION_CAPTURE_INVALID");

    expect(database!.get<{ session_id: string | null; capture_state: string; state: string }>(
      `SELECT run.session_id,owner.capture_state,owner.state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: fixture.run.id },
    )).toEqual({ session_id: null, capture_state: "INVALID", state: "LIVE" });
  });

  it("persists the adapter-observed init through RunService while the controlled owner is LIVE", async () => {
    const fixture = await setup({ leaveOwnerPrepared: true, workspace: true, mechanicsOnlyAdapter: true });
    if (!(fixture.runtime instanceof HermesRuntimeAdapter)) throw new Error("SESSION_CAPTURE_FIXTURE_ADAPTER_MISSING");
    const authRoot = join(directory, "hermes-auth-root");
    const profileHome = join(authRoot, "profiles", `ebb-orchestrator-run-${fixture.run.id}`);
    const selection = await createMechanicsSelection(fixture.run.id, fixture.run.model, authRoot);
    expect(selection.profileHome).toBe(profileHome);
    await fixture.runtime.startRun({ ...fixture.run, runtime: "hermes", hermesSelection: selection });
    expect(fixture.mechanicsSupervisor?.captureWhileLive).toEqual({
      session_id: "session-adapter-live-001", capture_state: "BOUND", owner_state: "LIVE",
    });
    expect(database!.get<{ state: string }>(
      "SELECT state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id },
    )).toEqual({ state: "STOPPED" });

    database!.close();
    database = createSqliteDatabase(join(directory, "capture.sqlite"));
    expect(database.get<{ session_id: string | null; capture_state: string; state: string }>(
      `SELECT run.session_id,owner.capture_state,owner.state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id
        WHERE run.id=$runId`,
      { runId: fixture.run.id },
    )).toEqual({ session_id: "session-adapter-live-001", capture_state: "BOUND", state: "STOPPED" });
  });
});

async function setup(options: { leaveOwnerPrepared?: boolean; workspace?: string | true; mechanicsOnlyAdapter?: boolean } = {}) {
  directory = await mkdtemp(join(tmpdir(), "ebb-hermes-session-init-fixture-"));
  database = createSqliteDatabase(join(directory, "capture.sqlite"));
  runMigrations(database, loadTestMigrations());

  const now = new Date().toISOString();
  const projectId = randomUUID();
  const taskId = randomUUID();
  database.run(
    "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'capture-fixture','Capture Fixture','ACTIVE',$now,$now)",
    { id: projectId, now },
  );
  database.run(
    "INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'CAPTURE-FIXTURE','Capture fixture','READY','{}',1,$now,$now)",
    { id: taskId, projectId, now },
  );
  if (options.workspace) {
    const approvalService = new ApprovalService(database);
    const approval = approvalService.request({
      type: "WORKFLOW_CHANGE", subjectId: projectId, subjectType: "PROJECT", requestedBy: "fixture",
    });
    approvalService.approve(approval.id, "fixture");
    database.run(
      `INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at)
       VALUES($projectId,$workspace,'{}',$proposed,'ACTIVE',$approvalId,$now,$now,$now)`,
      { projectId, workspace: options.workspace === true ? directory : options.workspace,
        proposed: JSON.stringify({ defaultBranch: "master" }), approvalId: approval.id, now },
    );
    database.run(
      "INSERT INTO worktrees(id,repo_path,path,branch,created_at,removed_at) VALUES($taskId,$workspace,$workspace,$branch,$now,NULL)",
      { taskId, workspace: options.workspace === true ? directory : options.workspace, branch: `task/${taskId}`, now },
    );
    database.run(
      `INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at)
       VALUES($id,'CREATE_WORKTREE','VERIFIED',$workspace,$branch,$taskId,'master',$now,$now)`,
      { id: randomUUID(), taskId, workspace: options.workspace === true ? directory : options.workspace,
        branch: `task/${taskId}`, now },
    );
  }

  const mechanicsRuntime = options.mechanicsOnlyAdapter
    ? createProviderFreeHermesMechanicsRuntime(database, directory)
    : undefined;
  const runtime = mechanicsRuntime?.adapter ?? new CaptureFixtureRuntime();
  const runService = new RunService(database, runtime, {
    prepare: (_tx, input) => ({
      finalPrompt: input.prompt,
      subject: { type: "TASK", id: taskId },
      role: "developer",
      contractDigest: null,
      items: [],
      contextBuilderVersion: "1.0.0",
      promptHash: digestRunPromptBytesV1(encoder.encode(input.prompt)),
      contextHash: createHash("sha256").update("fixture-context").digest("hex"),
      initialTokenSize: null,
      workspaceFingerprint: createHash("sha256").update("fixture-workspace").digest("hex"),
    } satisfies PreparedRunContext),
  });
  const runOptions = {
    role: "developer",
    model: "fixture-model",
    taskId,
    epicId: null,
    triggerReason: "task-assignment",
    contextVersion: "mechanics-fixture-v1",
    outputSchemaVersion: "1",
      contextInput: {
      prompt: "Provider-free session capture mechanics fixture.",
      subject: { type: "TASK", id: taskId },
      role: "developer",
      roleInputs: {},
      versions: {
        roleVersion: null,
        runtime: "fixture",
        runtimeVersion: null,
        model: "fixture-model",
        modelVersion: null,
        outputSchemaVersion: "1",
        contextVersion: "mechanics-fixture-v1",
      },
      execution: {
        workspaceIdentity: { repository: "fixture-repo", workspace: "fixture-workspace", worktree: "fixture-worktree" },
        targetHead: null,
        targetBranch: null,
        effectiveCapabilityIds: effectiveRunToolIds("developer"),
        policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "fixture", runtimePolicyId: null },
      },
    },
    ...(options.workspace ? { capability: { workspace: options.workspace === true ? directory : options.workspace } } : {}),
  } satisfies StartRunOptions;
  const run = runtime instanceof HermesRuntimeAdapter
    ? await runService.prepareRunWithHermesPreflight(runOptions)
    : runService.prepareRun(runOptions);

  const owner = database.get<{
    source_tag: string;
    hermes_home: string;
    containment_kind: "windows-job" | "systemd-user-service";
    containment_id: string;
    launch_nonce: string;
  }>(
    "SELECT source_tag,hermes_home,containment_kind,containment_id,launch_nonce FROM run_process_owners WHERE run_id=$runId",
    { runId: run.id },
  );
  if (!owner) throw new Error("SESSION_CAPTURE_FIXTURE_OWNER_MISSING");

  const identity: ProcessScopeIdentity = {
    runId: run.id,
    containmentKind: owner.containment_kind,
    containmentId: owner.containment_id,
    launchNonce: owner.launch_nonce,
    systemdInvocationId: process.platform === "linux" ? "12345678-1234-1234-1234-123456789abc" : null,
    systemdControlGroup: process.platform === "linux" ? `/user.slice/ebb-${owner.containment_id}.service` : null,
    supervisorPid: process.platform === "win32" ? 202 : null,
    supervisorStartIdentity: process.platform === "win32" ? "fixture-supervisor-start" : null,
    pid: 303,
    platform: process.platform,
    processStartIdentity: process.platform === "win32" ? "fixture-process-start" : null,
    executableIdentity: process.platform === "win32" ? `sha256:${"d".repeat(64)}` : null,
    state: "LIVE",
  };
  if (!options.leaveOwnerPrepared) {
    database.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, {
        runId: run.id,
        expectedState: "LAUNCHING",
        nextState: "LIVE",
        identity: {
          systemdInvocationId: identity.systemdInvocationId,
          systemdControlGroup: identity.systemdControlGroup,
          supervisorPid: identity.supervisorPid,
          supervisorStartIdentity: identity.supervisorStartIdentity,
          pid: identity.pid,
          platform: identity.platform,
          processStartIdentity: identity.processStartIdentity,
          executableIdentity: identity.executableIdentity,
        },
      });
    });
  }

  return {
    identity,
    owner: { sourceTag: owner.source_tag, hermesHome: owner.hermes_home },
    run,
    runtime,
    captureHandler: runtime instanceof CaptureFixtureRuntime ? runtime.captureHandler : undefined,
    mechanicsSupervisor: mechanicsRuntime?.supervisor,
  };
}

function createSourceSnapshotKey(): string {
  return JSON.stringify({
    formatVersion: 1,
    hermesVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
    manifestDigest: "c".repeat(64),
    ...(process.platform === "win32" ? { materializationPolicyVersion: 2 } : {}),
    sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    sourceTree: "d".repeat(40),
  });
}

/**
 * Создаёт тестовый Hermes runtime только для механики stdout capture → RunService CAS.
 * Selection/auth readiness синтетические и явно не являются provider acceptance.
 */
function createProviderFreeHermesMechanicsRuntime(database: Database, fixtureRoot: string): {
  adapter: HermesRuntimeAdapter;
  supervisor: ControlledCaptureSupervisor;
} {
  const platform = process.platform === "win32" ? "win32" as const : "linux" as const;
  const objectIdentity = platform === "win32"
    ? { platform, volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" } as const
    : { platform, device: "1", inode: "1" } as const;
  const profileHomeTargetIdentities = platform === "win32" ? {
    home: { ...objectIdentity, fileId: "7".repeat(32) },
    config: { ...objectIdentity, fileId: "8".repeat(32) },
  } : undefined;
  const argsPrefix = ["-I", "-B", "-S", "-c", "mechanics-only bootstrap"];
  const sourceSnapshotKey = createSourceSnapshotKey();
  const snapshotDirectoryId = createHash("sha256").update(sourceSnapshotKey).digest("hex");
  const supervisor = new ControlledCaptureSupervisor(database);
  const adapter = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, {
    databasePath: join(fixtureRoot, "capture.sqlite"),
    resultDirectory: join(fixtureRoot, "results"),
    checkpointDirectory: join(fixtureRoot, "checkpoints"),
    hermesLaunchTicketFactory: async (input) => ({
      executablePath: join(fixtureRoot, platform === "win32" ? "python.exe" : "python3"),
      argsPrefix,
      ticket: createHermesLaunchTicket({
        runId: input.runId,
        attempt: input.attempt,
        platform,
        hermesExecutablePath: join(fixtureRoot, platform === "win32" ? "hermes.exe" : "hermes"),
        hermesExecutableIdentity: objectIdentity,
        executablePath: join(fixtureRoot, platform === "win32" ? "python.exe" : "python3"),
        executableIdentity: objectIdentity,
        executableArgsPrefix: argsPrefix,
        profileHome: input.profileHome,
        profileHomeIdentity: objectIdentity,
        ...(profileHomeTargetIdentities ? { profileHomeTargetIdentities } : {}),
        ...(input.profileHomePathChain ? { profileHomePathChain: input.profileHomePathChain } : {}),
        hermesSourceSnapshotKey: sourceSnapshotKey,
        hermesSourceSnapshotRoot: join(fixtureRoot, "source-snapshots", snapshotDirectoryId),
        hermesSourceSnapshotRootIdentity: objectIdentity,
        hermesSourceManifestDigest: "c".repeat(64),
        hermesSourceProjectionPath: join(fixtureRoot, "source-snapshots", `${snapshotDirectoryId}.native-v1.bin`),
        hermesSourceProjectionSha256: "f".repeat(64),
        hermesSourceProjectionSize: 128,
        environment: input.environment,
      }),
    }),
    hermesRunProfileConfigWriter: async ({ profileHome, configYaml }) => {
      await mkdir(join(profileHome, "home"), { recursive: true });
      await writeFile(join(profileHome, "config.yaml"), configYaml, "utf8");
    },
  }, supervisor);

  vi.spyOn(adapter, "prepareHermesRunSelection").mockImplementation(async (runId) => ({
    selection: await createMechanicsSelection(runId, "fixture-model", join(fixtureRoot, "hermes-auth-root")),
    cleanup: async () => undefined,
  }));
  // Unit mechanics only: this named test helper bypasses auth-proof verification and has no
  // production constructor option, environment switch, or provider setup.
  const authGateTestSeam = adapter as unknown as { assertNativeHermesAuthReady: (...args: unknown[]) => void };
  vi.spyOn(authGateTestSeam, "assertNativeHermesAuthReady").mockImplementation(() => undefined);
  return { adapter, supervisor };
}

async function createMechanicsSelection(runId: string, modelId: string, authRoot: string): Promise<HermesRunSelection> {
  const fixture = await createHermesAuthRouteFixture(runId, "openai-codex", modelId, authRoot);
  const { profileHome } = fixture;
  return Object.freeze({
    runId,
    providerId: "openai-codex",
    modelId,
    endpointIdentity: "hermes-provider:openai-codex",
    endpointRevision: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
    sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
    sourceSnapshotKey: createSourceSnapshotKey(),
    profileHome,
    ...(fixture.profileHomePathChain ? { profileHomePathChain: fixture.profileHomePathChain } : {}),
    authRouteEvidence: fixture.authRouteEvidence,
  });
}

function encodeInit(sessionId: string): Uint8Array {
  return encoder.encode(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
}
