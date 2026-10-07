import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { effectiveRunToolIds, RunService } from "../../../src/modules/runtime/run-service.js";
import { FakeAgentRuntime } from "../../fakes/fake-agent-runtime.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import type { PreparedRunContext } from "../../../src/modules/context/context-types.js";
import { digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import type { HermesSessionCapture, HermesSessionCapturePort } from "../../../src/modules/runtime/hermes-session-capture-port.js";
import type { ProcessScopeIdentity } from "../../../src/platform/process/process-inspector.js";
import { transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";
import { HermesRuntimeAdapter } from "../../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-provider-selection.js";
import { createHermesAuthRouteFixture } from "../../helpers/hermes-auth-route-fixture.js";
import { createHermesLaunchTicket } from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { ProcessExecutor } from "../../../src/platform/process/process-executor.js";
import type { ProcessScopeLaunchRequest, ProcessScopeSupervisor } from "../../../src/platform/process/run-scope-supervisor.js";
import type { ProcessScopeObservation } from "../../../src/platform/process/process-inspector.js";

class CapturableRuntime extends FakeAgentRuntime implements HermesSessionCapturePort {
  handler: ((capture: HermesSessionCapture) => Promise<void>) | undefined;

  setHermesSessionCaptureHandler(handler: (capture: HermesSessionCapture) => Promise<void>): void {
    this.handler = handler;
  }
}

class CompletionFailureSupervisor implements ProcessScopeSupervisor {
  liveIdentity: ProcessScopeIdentity | undefined;
  stopped = false;
  stopCalls: ProcessScopeIdentity[] = [];

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ) {
    this.liveIdentity = owner.containmentKind === "windows-job"
      ? { ...owner, state: "LIVE", platform: "win32", supervisorPid: 202, supervisorStartIdentity: "supervisor-start",
          pid: 303, processStartIdentity: "process-start", executableIdentity: "sha256:" + "d".repeat(64) }
      : { ...owner, state: "LIVE", platform: "linux", pid: 303,
          systemdInvocationId: "12345678-1234-1234-1234-123456789abc",
          systemdControlGroup: `/user.slice/ebb-${owner.containmentId}.service` };
    await persistVerifiedIdentity(this.liveIdentity);
    if (request.onStdoutChunk) {
      await request.onStdoutChunk(new TextEncoder().encode(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: "session-before-transport-error" })}\n`,
      ));
    }
    return { completion: Promise.reject(new Error("SIMULATED_STDOUT_TRANSPORT_FAILURE")) };
  }

  async inspect(): Promise<ProcessScopeObservation> {
    if (this.stopped) return { state: "STOPPED", evidence: this.stoppedEvidence() };
    return this.liveIdentity ? { state: "LIVE", identity: this.liveIdentity } : { state: "UNKNOWN", reason: "TEST_OWNER_MISSING" };
  }

  async stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    this.stopCalls.push(owner);
    this.stopped = true;
    return { state: "STOPPED", evidence: this.stoppedEvidence() };
  }

  private stoppedEvidence(): string {
    return this.liveIdentity?.containmentKind === "windows-job" ? "WINDOWS_JOB_EMPTY" : "SYSTEMD_CGROUP_EMPTY";
  }

  async waitForStopped(): Promise<ProcessScopeObservation> {
    return this.inspect();
  }
}

describe("Hermes live session capture bridge", () => {
  let database: Database | undefined;
  let tempDirectory = "";

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = "";
  });

  async function setup() {
    tempDirectory = await mkdtemp(join(tmpdir(), "ebb-hermes-capture-test-"));
    database = createSqliteDatabase(join(tempDirectory, "capture.db"));
    runMigrations(database, loadTestMigrations());
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const taskId = randomUUID();
    database.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'capture','Capture','ACTIVE',$now,$now)", { id: projectId, now });
    database.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'CAPTURE-1','Capture','READY','{}',1,$now,$now)", { id: taskId, projectId, now });

    const runtime = new CapturableRuntime();
    const service = new RunService(database, runtime, {
      prepare: (_tx, input) => ({
        finalPrompt: input.prompt,
        subject: { type: "TASK", id: taskId },
        role: "developer",
        contractDigest: null,
        items: [],
        contextBuilderVersion: "1.0.0",
        promptHash: digestRunPromptBytesV1(new TextEncoder().encode(input.prompt)),
        contextHash: "b".repeat(64),
        initialTokenSize: null,
        workspaceFingerprint: "c".repeat(64),
      } satisfies PreparedRunContext),
    });
    const run = service.prepareRun({
      role: "developer", model: "test-model", taskId, epicId: null, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
      contextInput: {
        prompt: "safe test prompt", subject: { type: "TASK", id: taskId }, role: "developer", roleInputs: {},
        versions: { roleVersion: null, runtime: "default", runtimeVersion: null, model: "test-model", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1" },
        execution: { workspaceIdentity: { repository: "repo", workspace: "workspace", worktree: "worktree" }, targetHead: null,
          targetBranch: null, effectiveCapabilityIds: effectiveRunToolIds("developer"),
          policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null } },
      },
    });
    const row = database.get<{
      source_tag: string; hermes_home: string; containment_kind: "windows-job" | "systemd-user-service";
      containment_id: string; launch_nonce: string;
    }>("SELECT source_tag,hermes_home,containment_kind,containment_id,launch_nonce FROM run_process_owners WHERE run_id=$runId", { runId: run.id });
    if (!row) throw new Error("test owner missing");
    const baseIdentity: ProcessScopeIdentity = {
      runId: run.id, containmentKind: row.containment_kind, containmentId: row.containment_id, launchNonce: row.launch_nonce,
      systemdInvocationId: null, systemdControlGroup: null, supervisorPid: null, supervisorStartIdentity: null,
      pid: null, platform: null, processStartIdentity: null, executableIdentity: null, state: "LIVE",
    };
    const liveIdentity: ProcessScopeIdentity = process.platform === "win32"
      ? { ...baseIdentity, platform: "win32", supervisorPid: 102, supervisorStartIdentity: "supervisor-start", pid: 103,
          processStartIdentity: "process-start", executableIdentity: "sha256:" + "d".repeat(64) }
      : { ...baseIdentity, platform: "linux", pid: 103, systemdInvocationId: "12345678-1234-1234-1234-123456789abc",
          systemdControlGroup: `/user.slice/ebb-${row.containment_id}.service` };
    database.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, {
        runId: run.id, expectedState: "LAUNCHING", nextState: "LIVE",
        identity: {
          systemdInvocationId: liveIdentity.systemdInvocationId,
          systemdControlGroup: liveIdentity.systemdControlGroup,
          supervisorPid: liveIdentity.supervisorPid,
          supervisorStartIdentity: liveIdentity.supervisorStartIdentity,
          pid: liveIdentity.pid, platform: liveIdentity.platform,
          processStartIdentity: liveIdentity.processStartIdentity, executableIdentity: liveIdentity.executableIdentity,
        },
      });
    });
    return { runtime, service, run, liveIdentity, owner: row, projectId, taskId };
  }

  it("binds the narrow Hermes capture port and atomically persists one exact live init ID", async () => {
    const fixture = await setup();
    expect(fixture.runtime.handler).toBeTypeOf("function");
    const handler = fixture.runtime.handler;
    if (!handler) throw new Error("RunService did not bind the Hermes capture handler");

    await handler({
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "captured", sessionId: "session-123",
    });
    await handler({
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "captured", sessionId: "session-123",
    });

    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: "session-123" });
    expect(database!.get<{ capture_state: string; state: string }>("SELECT capture_state,state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "BOUND", state: "LIVE" });
  });

  it("clears a BOUND session only after a retried durable invalidation succeeds", async () => {
    const fixture = await setup();
    const handler = fixture.runtime.handler!;
    const capture = {
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "captured" as const, sessionId: "session-123",
    };
    const invalidation = { ...capture, status: "invalid" as const, reason: "STREAM_FINISHED" as const };
    await handler(capture);
    database!.exec(`CREATE TRIGGER reject_first_capture_invalidation BEFORE UPDATE OF capture_state ON run_process_owners
      WHEN NEW.capture_state='INVALID' BEGIN SELECT RAISE(ABORT,'injected invalidation persistence failure'); END`);

    await expect(handler(invalidation)).rejects.toThrow("HERMES_SESSION_CAPTURE_INVALIDATION_FAILED");
    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: "session-123" });
    expect(database!.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "BOUND" });

    database!.exec("DROP TRIGGER reject_first_capture_invalidation");
    await handler(invalidation);
    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: null });
    expect(database!.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "INVALID" });
  });

  it("clears durable BOUND capture after live init followed by supervisor stdout transport failure", async () => {
    const fixture = await setup();
    const workspace = join(tempDirectory, "workspace");
    const repository = join(tempDirectory, "repository");
    const resultDirectory = join(tempDirectory, "runtime-results");
    await mkdir(workspace);
    await mkdir(repository);
    const now = new Date().toISOString();
    const approvalId = randomUUID();
    database!.run(
      `INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at)
       VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)`,
      { id: approvalId, projectId: fixture.projectId, now },
    );
    database!.run(
      `INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at)
       VALUES($projectId,$repository,'{}',$proposed,'ACTIVE',$approvalId,$now,$now)`,
      { projectId: fixture.projectId,
        repository, proposed: JSON.stringify({ defaultBranch: "master" }), approvalId, now },
    );
    database!.run(
      "INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$repository,$workspace,$branch,$now)",
      { id: fixture.taskId, repository, workspace, branch: `task/${fixture.taskId}`, now },
    );
    database!.run(
      `INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at)
       VALUES($id,'CREATE_WORKTREE','VERIFIED',$repository,$branch,$worktreeId,'master',$now,$now)`,
      { id: randomUUID(), repository, branch: `task/${fixture.taskId}`, worktreeId: fixture.taskId, now },
    );
    const persistedRun = database!.get<{ capability_json: string | null }>(
      "SELECT capability_json FROM agent_runs WHERE id=$runId", { runId: fixture.run.id },
    );
    if (!persistedRun?.capability_json) throw new Error("test capability missing");
    const capability = JSON.parse(persistedRun.capability_json) as Record<string, unknown>;
    capability.workspace = workspace;
    database!.run("UPDATE agent_runs SET capability_json=$capability WHERE id=$runId", {
      runId: fixture.run.id, capability: JSON.stringify(capability),
    });
    database!.run(
      `UPDATE run_process_owners SET hermes_home=$home,state='PREPARED',stop_evidence=NULL,
         systemd_invocation_id=NULL,systemd_control_group=NULL,supervisor_pid=NULL,supervisor_start_identity=NULL,
         pid=NULL,platform=NULL,process_start_identity=NULL,executable_identity=NULL,capture_state='UNBOUND'
        WHERE run_id=$runId`,
      { runId: fixture.run.id, home: join(resultDirectory, "profiles", `ebb-orchestrator-run-${fixture.run.id}`) },
    );
    const supervisor = new CompletionFailureSupervisor();
    const platform = process.platform === "win32" ? "win32" as const : "linux" as const;
    const objectIdentity = platform === "win32"
      ? { platform, volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" } as const
      : { platform, device: "1", inode: "1" } as const;
    const adapter = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, {
      databasePath: join(tempDirectory, "capture.db"), resultDirectory,
      checkpointDirectory: join(tempDirectory, "checkpoints"),
      hermesLaunchTicketFactory: async (input) => {
        const sourceSnapshotKey = JSON.stringify({
          formatVersion: 1,
          hermesVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
          manifestDigest: "c".repeat(64),
          ...(platform === "win32" ? { materializationPolicyVersion: 2 } : {}),
          sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
          sourceTree: "d".repeat(40),
        });
        const snapshotId = createHash("sha256").update(sourceSnapshotKey).digest("hex");
        const sourceSnapshotRoot = join(tempDirectory, "source-snapshots", snapshotId);
        const sourceProjectionPath = join(tempDirectory, "source-snapshots", `${snapshotId}.native-v1.bin`);
        const argsPrefix = ["-I", "-B", "-S", "-c", "test bootstrap"];
        const profileHomeTargetIdentities = platform === "win32" ? {
          home: { ...objectIdentity, fileId: "7".repeat(32) },
          config: { ...objectIdentity, fileId: "8".repeat(32) },
        } : undefined;
        return {
          executablePath: join(tmpdir(), platform === "win32" ? "python.exe" : "python3"),
          argsPrefix,
          ticket: createHermesLaunchTicket({
            runId: input.runId,
            attempt: input.attempt,
            platform,
            hermesExecutablePath: join(tmpdir(), platform === "win32" ? "hermes.exe" : "hermes"),
            hermesExecutableIdentity: objectIdentity,
            executablePath: join(tmpdir(), platform === "win32" ? "python.exe" : "python3"),
            executableIdentity: objectIdentity,
            executableArgsPrefix: argsPrefix,
            profileHome: input.profileHome,
            profileHomeIdentity: objectIdentity,
            ...(profileHomeTargetIdentities ? { profileHomeTargetIdentities } : {}),
            ...(input.profileHomePathChain ? { profileHomePathChain: input.profileHomePathChain } : {}),
            hermesSourceSnapshotKey: sourceSnapshotKey,
            hermesSourceSnapshotRoot: sourceSnapshotRoot,
            hermesSourceSnapshotRootIdentity: objectIdentity,
            hermesSourceManifestDigest: "c".repeat(64),
            hermesSourceProjectionPath: sourceProjectionPath,
            hermesSourceProjectionSha256: "f".repeat(64),
            hermesSourceProjectionSize: 128,
            environment: input.environment,
          }),
        };
      },
      hermesRunProfileConfigWriter: async ({ profileHome, configYaml }) => {
        await mkdir(join(profileHome, "home"), { recursive: true });
        await writeFile(join(profileHome, "config.yaml"), configYaml);
      },
    }, supervisor);
    vi.spyOn(adapter as unknown as { assertNativeHermesAuthReady(): void }, "assertNativeHermesAuthReady")
      .mockImplementation(() => undefined);
    new RunService(database!, adapter);

    const sourceSnapshotKey = JSON.stringify({
      formatVersion: 1,
      hermesVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      manifestDigest: "c".repeat(64),
      ...(platform === "win32" ? { materializationPolicyVersion: 2 } : {}),
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceTree: "d".repeat(40),
    });
    const authFixture = await createHermesAuthRouteFixture(fixture.run.id, "openai-codex", fixture.run.model, resultDirectory);
    const { profileHome } = authFixture;
    await expect(adapter.startRun({
      ...fixture.run,
      hermesSelection: {
        runId: fixture.run.id,
        providerId: "openai-codex",
        modelId: fixture.run.model,
        endpointIdentity: "hermes-provider:openai-codex",
        endpointRevision: HERMES_PROVIDER_SELECTION_SOURCE.commit,
        sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
        sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
        sourceSnapshotKey,
        profileHome,
        ...(authFixture.profileHomePathChain ? { profileHomePathChain: authFixture.profileHomePathChain } : {}),
        authRouteEvidence: authFixture.authRouteEvidence,
      },
    })).rejects.toThrow("SIMULATED_STDOUT_TRANSPORT_FAILURE");

    expect(database!.get<{ session_id: string | null; capture_state: string; owner_state: string }>(
      `SELECT run.session_id, owner.capture_state, owner.state AS owner_state
         FROM agent_runs run JOIN run_process_owners owner ON owner.run_id=run.id WHERE run.id=$runId`,
      { runId: fixture.run.id },
    )).toEqual({ session_id: null, capture_state: "INVALID", owner_state: "STOPPED" });
    expect(supervisor.stopCalls).toHaveLength(1);
    expect(supervisor.stopCalls[0]).toMatchObject({
      runId: fixture.run.id, containmentId: fixture.owner.containment_id, launchNonce: fixture.owner.launch_nonce,
    });
  });

  it("treats a callback with mismatched source provenance as stale without mutating the current owner", async () => {
    const fixture = await setup();
    const handler = fixture.runtime.handler!;
    await expect(handler({
      runId: fixture.run.id, attempt: null, sourceTag: "wrong-source", hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "captured", sessionId: "session-123",
    })).rejects.toThrow("HERMES_SESSION_CAPTURE_STALE");

    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: null });
    expect(database!.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "UNBOUND" });
  });

  it("makes malformed or duplicate live stream evidence sticky INVALID", async () => {
    const fixture = await setup();
    const handler = fixture.runtime.handler!;
    await handler({
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "invalid", reason: "DUPLICATE_INIT",
    });

    expect(database!.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "INVALID" });
    await expect(handler({
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "captured", sessionId: "too-late",
    })).rejects.toThrow("HERMES_SESSION_CAPTURE_INVALID");
    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: null });
  });

  it("invalidates a late callback for the same owner after the process has stopped", async () => {
    const fixture = await setup();
    const containmentKind = database!.get<{ containment_kind: string }>(
      "SELECT containment_kind FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id },
    )?.containment_kind;
    const stopEvidence = containmentKind === "windows-job" ? "WINDOWS_JOB_EMPTY" : "SYSTEMD_CGROUP_EMPTY";
    database!.run("UPDATE run_process_owners SET state='STOPPED',stop_evidence=$stopEvidence WHERE run_id=$runId", {
      runId: fixture.run.id, stopEvidence,
    });
    await expect(fixture.runtime.handler!({
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "captured", sessionId: "late-session",
    })).rejects.toThrow("HERMES_SESSION_CAPTURE_INVALID");

    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: null });
    expect(database!.get<{ capture_state: string; state: string }>("SELECT capture_state,state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "INVALID", state: "STOPPED" });
  });

  it.each(["hermes_home", "native_identity"] as const)("does not let a stale callback invalidate a replacement owner with reused containment and nonce (%s)", async (changedField) => {
    const fixture = await setup();
    if (changedField === "hermes_home") {
      database!.run("UPDATE run_process_owners SET hermes_home=$home,capture_state='BOUND' WHERE run_id=$runId", {
        runId: fixture.run.id, home: fixture.owner.hermes_home + "-replacement",
      });
    } else if (fixture.liveIdentity.platform === "win32") {
      database!.run("UPDATE run_process_owners SET supervisor_pid=supervisor_pid+1,capture_state='BOUND' WHERE run_id=$runId", { runId: fixture.run.id });
    } else {
      database!.run("UPDATE run_process_owners SET systemd_invocation_id='87654321-4321-4321-4321-cba987654321',capture_state='BOUND' WHERE run_id=$runId", { runId: fixture.run.id });
    }
    database!.run("UPDATE agent_runs SET session_id='replacement-session' WHERE id=$runId", { runId: fixture.run.id });

    await expect(fixture.runtime.handler!({
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "invalid", reason: "MALFORMED_JSON",
    })).rejects.toThrow("HERMES_SESSION_CAPTURE_STALE");

    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: "replacement-session" });
    expect(database!.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "BOUND" });
  });

  it("falls back to sticky INVALID when the BOUND owner CAS fails", async () => {
    const fixture = await setup();
    database!.exec(`CREATE TRIGGER reject_capture_bound BEFORE UPDATE OF capture_state ON run_process_owners
      WHEN NEW.capture_state='BOUND' BEGIN SELECT RAISE(ABORT,'injected capture CAS failure'); END`);
    await expect(fixture.runtime.handler!({
      runId: fixture.run.id, attempt: null, sourceTag: fixture.owner.source_tag, hermesHome: fixture.owner.hermes_home,
      owner: fixture.liveIdentity, status: "captured", sessionId: "session-123",
    })).rejects.toThrow("HERMES_SESSION_CAPTURE_INVALID");

    expect(database!.get<{ session_id: string | null }>("SELECT session_id FROM agent_runs WHERE id=$runId", { runId: fixture.run.id }))
      .toEqual({ session_id: null });
    expect(database!.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.run.id }))
      .toEqual({ capture_state: "INVALID" });
  });
});
