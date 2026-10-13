/**
 * Проверяет адаптер среды выполнения Hermes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { HermesRuntimeAdapter } from "../../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { validatePlatform } from "../../../src/platform/config/app-config.js";
import * as orchestratorHomeModule from "../../../src/platform/home/orchestrator-home.js";
import { HermesCliBuilder } from "../../../src/modules/runtime/hermes/hermes-cli.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-source-identity.js";
import { createHermesLaunchTicket, type HermesLaunchTicketFactory } from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import {
  ProcessExecutor,
  ExitCodeError,
  type ProcessOptions,
  type ProcessResult,
} from "../../../src/platform/process/process-executor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../../src/platform/process/process-inspector.js";
import { ProcessScopeLaunchNotDispatchedError, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "../../../src/platform/process/run-scope-supervisor.js";
import { insertRunProcessOwnerTx, prepareRunProcessOwner } from "../../../src/modules/runtime/run-process-owner.js";
import type { HermesSessionCapture } from "../../../src/modules/runtime/hermes-session-capture-port.js";
import type { HermesManagedRunSelection, HermesRuntimeSelection } from "../../../src/modules/runtime/hermes/hermes-run-selection.js";

// Имитация исполнителя процессов для тестов.
class MockProcessExecutor extends ProcessExecutor {
  private execCalls: Array<{ file: string; args: string[]; options?: ProcessOptions }> = [];
  private nextResult: ProcessResult | Error | null = null;
  private nextThrows = false;

  getCalls() {
    return [...this.execCalls];
  }

  setNextResult(result: ProcessResult) {
    this.nextResult = result;
    this.nextThrows = false;
  }

  setNextError(error: Error) {
    this.nextResult = error;
    this.nextThrows = true;
  }

  override async exec(
    file: string,
    args: string[],
    options?: ProcessOptions
  ): Promise<ProcessResult> {
    this.execCalls.push({ file, args, options: options ?? {} });

    if (this.nextThrows && this.nextResult instanceof Error) {
      throw this.nextResult;
    }

    if (this.nextResult && !(this.nextResult instanceof Error)) {
      return this.nextResult;
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }

  reset() {
    this.execCalls = [];
    this.nextResult = null;
    this.nextThrows = false;
  }
}

class MockProcessScopeSupervisor implements ProcessScopeSupervisor {
  private readonly observations = new Map<string, ProcessScopeObservation>();
  lastRequest: ProcessScopeLaunchRequest | undefined;
  lastLiveIdentity: ProcessScopeIdentity | undefined;
  launchCalls = 0;
  payloadDispatches = 0;
  stdoutChunks: Uint8Array[] = [];
  stderrChunks: Uint8Array[] = [];
  completionError: Error | undefined;
  maskPayloadCallbackFailure = false;
  stopCalls: ProcessScopeIdentity[] = [];
  beforeProcessExecution: ((owner: ProcessScopeIdentity, request: ProcessScopeLaunchRequest) => void | Promise<void>) | undefined;

  constructor(private readonly executor: ProcessExecutor) {}

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ) {
    this.launchCalls += 1;
    this.lastRequest = request;
    const identity: ProcessScopeIdentity = process.platform === "win32"
      ? { ...owner, state: "LIVE", platform: "win32", pid: 303, supervisorPid: 202,
          supervisorStartIdentity: "test-supervisor-start", processStartIdentity: "test-process-start",
          executableIdentity: request.executable }
      : { ...owner, state: "LIVE", platform: "linux", pid: 303,
          systemdInvocationId: "12345678-1234-1234-1234-123456789abc",
          systemdControlGroup: `/user.slice/test-${owner.containmentId}.service` };
    this.lastLiveIdentity = identity;
    this.observations.set(owner.containmentId, { state: "LIVE", identity });
    await persistVerifiedIdentity(identity);
    await this.beforeProcessExecution?.(owner, request);
    if (request.signal?.aborted) {
      const stopped = await this.stop({ ...identity, state: "STOPPING" });
      if (stopped.state !== "STOPPED") throw new Error("TEST_PROCESS_SCOPE_STOP_UNPROVEN");
      throw new Error("PROCESS_SCOPE_LAUNCH_CANCELLED");
    }
    const env = { ...request.environment };
    this.payloadDispatches += 1;
    for (const chunk of this.stdoutChunks) {
      try {
        await request.onStdoutChunk?.(chunk);
      } catch (error) {
        if (this.maskPayloadCallbackFailure) throw new Error("WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED", { cause: error });
        throw error;
      }
    }
    for (const chunk of this.stderrChunks) request.onStderrChunk?.(chunk);
    const execution = this.completionError ? Promise.reject(this.completionError) : this.executor.exec(request.executable, [...request.args], {
      cwd: request.cwd,
      env,
      timeout: request.timeoutMs,
      ...(request.captureOutput === false ? { captureOutput: false } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const completion = execution.catch((error: unknown) => {
      if (error instanceof ExitCodeError) {
        return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
      }
      throw error;
    }).finally(() => {
      this.observations.set(owner.containmentId, { state: "STOPPED", evidence: stoppedEvidence(owner) });
    });
    return { completion };
  }

  async inspect(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    return this.observations.get(owner.containmentId) ?? { state: "STOPPED", evidence: stoppedEvidence(owner) };
  }

  async stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    this.stopCalls.push(owner);
    const stopped: ProcessScopeObservation = { state: "STOPPED", evidence: stoppedEvidence(owner) };
    this.observations.set(owner.containmentId, stopped);
    return stopped;
  }

  async waitForStopped(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    return this.inspect(owner);
  }
}

function stoppedEvidence(owner: ProcessScopeIdentity): string {
  return owner.containmentKind === "windows-job" ? "WINDOWS_JOB_EMPTY" : "SYSTEMD_CGROUP_EMPTY";
}

function createProcessOwnerGenerationFixture(database: ReturnType<typeof createSqliteDatabase>): void {
  database.exec(`ALTER TABLE run_process_owners ADD COLUMN current_generation INTEGER NOT NULL DEFAULT 1`);
  database.exec(`CREATE TABLE run_process_owner_generations (
    run_id TEXT NOT NULL, generation INTEGER NOT NULL, run_attempt INTEGER,
    source_tag TEXT NOT NULL, hermes_home TEXT NOT NULL, hermes_source_snapshot_key TEXT,
    capture_state TEXT NOT NULL, containment_kind TEXT NOT NULL, containment_id TEXT NOT NULL,
    launch_nonce TEXT NOT NULL, systemd_invocation_id TEXT, systemd_control_group TEXT,
    supervisor_pid INTEGER, supervisor_start_identity TEXT, pid INTEGER, platform TEXT,
    process_start_identity TEXT, executable_identity TEXT, state TEXT NOT NULL,
    stop_evidence TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(run_id,generation)
  )`);
}

function insertCurrentProcessOwnerGenerationFixture(database: ReturnType<typeof createSqliteDatabase>, runId: string): void {
  database.run(`INSERT INTO run_process_owner_generations(
    run_id,generation,run_attempt,source_tag,hermes_home,hermes_source_snapshot_key,capture_state,
    containment_kind,containment_id,launch_nonce,systemd_invocation_id,systemd_control_group,
    supervisor_pid,supervisor_start_identity,pid,platform,process_start_identity,executable_identity,
    state,stop_evidence,updated_at
  ) SELECT run_id,1,NULL,source_tag,hermes_home,hermes_source_snapshot_key,'UNBOUND',
    containment_kind,containment_id,launch_nonce,systemd_invocation_id,systemd_control_group,
    supervisor_pid,supervisor_start_identity,pid,platform,process_start_identity,executable_identity,
    state,stop_evidence,updated_at FROM run_process_owners WHERE run_id=$runId`, { runId });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createTestRuntimeAdapter(
  executor: ProcessExecutor,
  artifactStore?: MockArtifactStore,
  config?: ConstructorParameters<typeof HermesRuntimeAdapter>[2],
  supervisor?: ProcessScopeSupervisor,
): HermesRuntimeAdapter {
  return allowTestManagedHermesSelection(new HermesRuntimeAdapter(executor, artifactStore, {
    ...config,
    hermesLaunchTicketFactory: config?.hermesLaunchTicketFactory ?? testHermesLaunchTicketFactory,
  }, supervisor ?? new MockProcessScopeSupervisor(executor)), async (run) => run.hermesSelection ?? await testHermesSelection(
    run.id,
    run.model,
    config?.resultDirectory ?? path.join(os.tmpdir(), "orchestrator-hermes-results"),
  ));
}

const testHermesLaunchTicketFactory: HermesLaunchTicketFactory = async (input) => {
  const platform = process.platform === "win32" ? "win32" : "linux";
  const paths = platform === "win32" ? path.win32 : path.posix;
  const executablePath = paths.join(os.tmpdir(), platform === "win32" ? "python.exe" : "python3");
  const hermesExecutablePath = paths.join(os.tmpdir(), platform === "win32" ? "hermes.exe" : "hermes");
  const objectIdentity = platform === "win32"
    ? { platform, volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" } as const
    : { platform, device: "1", inode: "1" } as const;
  const argsPrefix = ["-I", "-B", "-S", "-c", "test bootstrap"];
  return {
    executablePath,
    argsPrefix,
    ticket: createHermesLaunchTicket({
      runId: input.runId,
      attempt: input.attempt,
      platform,
      hermesExecutablePath,
      hermesExecutableIdentity: objectIdentity,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      executablePath,
      executableIdentity: objectIdentity,
      executableArgsPrefix: argsPrefix,
      hermesHome: input.hermesHome,
      environment: input.environment,
    }),
  };
};

async function testHermesSelection(runId: string, _modelId: string, resultDirectory = path.join(os.tmpdir(), "orchestrator-hermes-results")): Promise<HermesManagedRunSelection> {
  return {
    mode: "HERMES_MANAGED", runId, hermesHome: path.join(resultDirectory, "configured-hermes"),
    runtimeIdentity: "fixture-runtime",
  };
}

function allowTestManagedHermesSelection(
  adapter: HermesRuntimeAdapter,
  selectionForRun?: (run: Parameters<HermesRuntimeAdapter["startRun"]>[0]) => HermesRuntimeSelection | undefined | Promise<HermesRuntimeSelection | undefined>,
): HermesRuntimeAdapter {
  (adapter as unknown as { hermesLaunchTicketFactory: HermesLaunchTicketFactory }).hermesLaunchTicketFactory ??= testHermesLaunchTicketFactory;
  const proofs = (adapter as unknown as { verifiedManagedSelections: WeakSet<HermesManagedRunSelection> }).verifiedManagedSelections;
  const originalStart = adapter.startRun.bind(adapter);
  vi.spyOn(adapter, "startRun").mockImplementation(async (run) => {
    const projected = selectionForRun?.(run);
    const selection = projected && typeof projected === "object" && "then" in projected ? await projected : projected ?? run.hermesSelection ?? await testHermesSelection(run.id, run.model);
    if (selection && "mode" in selection) proofs.add(selection);
    if (!selection) throw new Error("Managed selection fixture missing");
    return originalStart({ ...run, capabilityRef: run.capabilityRef ?? "fixture-capability", hermesSelection: selection });
  });
  return adapter;
}

// Имитация хранилища артефактов.
class MockArtifactStore {
  private artifacts: Record<string, { stdout: string; stderr: string; exitCode: number }> = {};

  saveArtifacts(
    runId: string,
    stdout: string,
    stderr: string,
    exitCode: number
  ) {
    this.artifacts[runId] = { stdout, stderr, exitCode };
  }

  getArtifacts(runId: string) {
    return this.artifacts[runId];
  }
}

describe("HermesRuntimeAdapter", () => {
  let adapter: HermesRuntimeAdapter;
  let mockExecutor: MockProcessExecutor;
  let mockArtifactStore: MockArtifactStore;
  let sharedCheckpointDirectory: string;

  beforeEach(async () => {
    mockExecutor = new MockProcessExecutor();
    mockArtifactStore = new MockArtifactStore();
    sharedCheckpointDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-checkpoints-"));
    adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
      managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
      checkpointDirectory: sharedCheckpointDirectory,
    });
  });

  afterEach(async () => {
    await fs.rm(sharedCheckpointDirectory, { recursive: true, force: true });
  });

  it("selects the configured Hermes root without reading or creating its profile", async () => {
    const runId = "f672e56f-07ed-4fc4-9aca-2f91b3d7bc82";
    const hermesRoot = path.join(os.tmpdir(), `hermes-managed-${runId}`);
    const installedCommit = "9244275491" + "0".repeat(30);
    vi.resetModules();
    vi.doMock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js", () => ({
      resolveHermesExecutable: vi.fn(async () => ({
        hermesConfigHome: hermesRoot, hermesProjectRoot: "fixture-source",
        sourceCommit: installedCommit,
        executableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "a".repeat(32) },
        runtimeExecutableIdentity: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "b".repeat(32) },
      })),
    }));
    try {
      const { HermesRuntimeAdapter: ManagedAdapter } = await import("../../../src/modules/runtime/hermes/hermes-runtime-adapter.js");
      const runtime = new ManagedAdapter(new ProcessExecutor());
      const preflight = await runtime.prepareHermesRunSelection(runId);
      expect(preflight.selection).toEqual({ mode: "HERMES_MANAGED", runId, hermesHome: hermesRoot,
        runtimeIdentity: JSON.stringify({ platform: "win32",
          hermes: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "a".repeat(32) },
          python: { platform: "win32", volumeSerial: "0123456789abcdef", fileId: "b".repeat(32) } }) });
      expect(Object.keys(preflight)).toEqual(["selection"]);
      await expect(fs.stat(hermesRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.doUnmock("../../../src/modules/runtime/hermes/hermes-executable-resolver.js");
      vi.resetModules();
    }
  });

  it("fails closed before preparing a process when managed selection verification is absent", async () => {
    const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-auth-policy-red-"));
    const supervisor = new MockProcessScopeSupervisor(mockExecutor);
    const adapterWithoutTestAuthBypass = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
      resultDirectory,
      checkpointDirectory: sharedCheckpointDirectory,
      managedWorktree: path.join(os.tmpdir(), "hermes-auth-policy-workspace"),
      hermesLaunchTicketFactory: testHermesLaunchTicketFactory,
    }, supervisor);
    const promptWrite = vi.spyOn(adapterWithoutTestAuthBypass as unknown as { writePromptFile(run: Parameters<HermesRuntimeAdapter["startRun"]>[0]): Promise<string> }, "writePromptFile");
    const runId = "b8617c18-bb88-4ce3-af9e-9f7f206c27ac";
    const run = {
      id: runId, role: "Developer", runtime: "hermes", model: "model-x",
      taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
      triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
      endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      hermesSelection: await testHermesSelection(runId, "model-x", resultDirectory),
    };

    try {
      await expect(adapterWithoutTestAuthBypass.startRun(run)).rejects.toThrow("HERMES_RUN_SELECTION_UNAVAILABLE");
      expect(promptWrite).not.toHaveBeenCalled();
      expect(supervisor.launchCalls).toBe(0);
      expect(mockExecutor.getCalls()).toHaveLength(0);
    } finally {
      promptWrite.mockRestore();
      await fs.rm(resultDirectory, { recursive: true, force: true });
    }
  });

  it("uses the configured checkpoint directory instead of the OS home", () => {
    const configuredDirectory = path.join(os.tmpdir(), "orchestrator-home", "runtime", "checkpoints");
    const AdapterWithCheckpointDirectory = HermesRuntimeAdapter as unknown as new (
      executor: ProcessExecutor,
      artifactStore: MockArtifactStore,
      config: { checkpointDirectory: string },
    ) => HermesRuntimeAdapter;
    const configured = new AdapterWithCheckpointDirectory(mockExecutor, mockArtifactStore, {
      checkpointDirectory: configuredDirectory,
    });

    expect((configured as unknown as { checkpointDirectory: string }).checkpointDirectory)
      .toBe(configuredDirectory);
  });

  it.each(["linux", "darwin", "win32"] as const)("validates supported platform %s", (platform) => {
    expect(validatePlatform(platform)).toBe(platform);
  });

  it("rejects unsupported platform values with a descriptive Russian error", () => {
    expect(() => validatePlatform("freebsd")).toThrow(/платформ/i);
  });

  it("uses an explicitly selected platform home path without filesystem writes", () => {
    const selected = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
      platform: "win32",
      homeEnvironment: { EBB_ORCHESTRATOR_HOME: "C:\\isolated\\app" },
    });
    expect((selected as unknown as { checkpointDirectory: string }).checkpointDirectory)
      .toBe("C:\\isolated\\app\\runtime\\checkpoints");
  });

  it("rejects unsupported default process.platform before calling the home resolver", () => {
    const originalProcess = process;
    const resolverSpy = vi.spyOn(orchestratorHomeModule, "resolveOrchestratorHome");
    try {
      vi.stubGlobal("process", new Proxy(originalProcess, {
        get(target, property, receiver) {
          return property === "platform" ? "freebsd" : Reflect.get(target, property, receiver);
        },
      }));
      expect(() => new HermesRuntimeAdapter(mockExecutor, mockArtifactStore))
        .toThrow(/платформ/i);
      expect(resolverSpy).not.toHaveBeenCalled();
    } finally {
      resolverSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("creates checkpoints only under the injected orchestrator home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-regression-"));
    const checkpoints = path.join(root, "runtime", "checkpoints");
    const defaultHomeCheckpoints = path.join(root, ".ebb-orchestrator", "checkpoints");
    const hostProfileCandidates = [
      path.join(os.homedir(), ".ebb-orchestrator", "checkpoints"),
      process.platform === "win32" && process.env.USERPROFILE
        ? path.win32.join(process.env.USERPROFILE, ".ebb-orchestrator", "checkpoints")
        : null,
    ].filter((candidate): candidate is string => candidate !== null);
    const readHostProfileStates = async () => Promise.all(hostProfileCandidates.map(async (candidate) => {
      try {
        const stats = await fs.stat(candidate);
        return {
          candidate,
          exists: true,
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
        };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return { candidate, exists: false };
        }
        throw error;
      }
    }));
    const hostProfileStatesBefore = await readHostProfileStates();
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("HOME", root);
    try {
      const runtime = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        homeEnvironment: { EBB_ORCHESTRATOR_HOME: root },
        platform: validatePlatform(process.platform),
      });
      await runtime.startRun({
        id: "8b758a7a-2075-4872-86b7-53369d01c04b", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED", sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      });
      expect((await fs.stat(checkpoints)).isDirectory()).toBe(true);
      expect((runtime as unknown as { checkpointDirectory: string }).checkpointDirectory).toBe(checkpoints);
      await expect(fs.stat(defaultHomeCheckpoints)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readHostProfileStates()).toEqual(hostProfileStatesBefore);
      expect(mockExecutor.getCalls()[0]?.options?.env).not.toHaveProperty("EBB_ORCHESTRATOR_HOME");
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  describe("startRun", () => {
    it("fails closed before process dispatch when no process-scope supervisor is configured", async () => {
      const unscoped = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      });
      await expect(unscoped.startRun({
        id: "9b2484a2-89ac-47e3-b8ad-c7e2b9a1ed11", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED", sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        hermesSelection: await testHermesSelection("9b2484a2-89ac-47e3-b8ad-c7e2b9a1ed11", "model-x"),
      })).rejects.toThrow("PROCESS_SCOPE_SUPERVISOR_REQUIRED");
      expect(mockExecutor.getCalls()).toHaveLength(0);
    });

    it("forwards bounded live stdout init evidence through the exact LIVE owner and retains no raw output", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-live-capture-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const rawMarker = "raw-jsonl-must-not-escape";
      supervisor.stdoutChunks = [new TextEncoder().encode(`${JSON.stringify({
        type: "system", subtype: "init", session_id: "session-live-123", text: rawMarker,
      })}\n`)];
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        environment: {
          HERMES_HOME: path.join(resultDirectory, "configured-hermes"),
          HERMES_DATA_DIR_SUFFIX: "-custom",
          HERMES_RUNTIME_DIR: path.join(resultDirectory, "runtime"),
          USERPROFILE: "C:\\Users\\test",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
        },
      }, supervisor);
      const captures: HermesSessionCapture[] = [];
      adapter.setHermesSessionCaptureHandler(async (capture) => { captures.push(capture); });
      mockExecutor.setNextResult({ exitCode: 0, stdout: rawMarker, stderr: rawMarker });
      const run = {
        id: "d439431f-2339-44b6-bd97-b072c72b447c", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      try {
        await adapter.startRun(run);

        expect(captures).toHaveLength(1);
        expect(captures[0]).toEqual({
          runId: run.id, attempt: null, sourceTag: `ebb-run:${run.id}`,
          hermesHome: path.join(resultDirectory, "configured-hermes"),
          owner: supervisor.lastLiveIdentity,
          status: "captured", sessionId: "session-live-123",
        });
        expect(supervisor.lastRequest?.captureOutput).toBe(false);
        expect(supervisor.lastRequest?.environment).toMatchObject({
          HERMES_HOME: path.join(resultDirectory, "configured-hermes"),
          USERPROFILE: "C:\\Users\\test",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          HERMES_DATA_DIR_SUFFIX: "-custom",
          HERMES_RUNTIME_DIR: path.join(resultDirectory, "runtime"),
        });
        expect(mockArtifactStore.getArtifacts(run.id)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
        expect(JSON.stringify(captures)).not.toContain(rawMarker);
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("preserves only a known capture failure reason across the supervisor callback boundary", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-capture-callback-diagnostic-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      supervisor.maskPayloadCallbackFailure = true;
      const secret = "raw-provider-output-must-not-escape";
      supervisor.stdoutChunks = [new TextEncoder().encode(`${secret}\n`)];
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      adapter.setHermesSessionCaptureHandler(async () => undefined);
      const run = {
        id: "5ce80561-dd6f-4a77-b62c-b18e7180241e", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      try {
        const failure = await adapter.startRun(run).then(() => undefined, (error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED:MALFORMED_JSON");
        expect((failure as Error).stack).not.toContain(secret);
        expect(supervisor.stopCalls).toHaveLength(1);
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("keeps the generic supervisor callback code when no capture callback reason is known", async () => {
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      supervisor.completionError = new Error("WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED");
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      adapter.setHermesSessionCaptureHandler(async () => undefined);
      const run = {
        id: "4e0b8271-2325-4265-a4eb-d6240b7e7bb1", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      await expect(adapter.startRun(run)).rejects.toThrow("WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED");
      await expect(adapter.startRun(run)).rejects.toThrow(/^WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED$/u);
    });

    it("reports only the fixed Hermes MCP registration failure marker from stderr", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-registration-diagnostic-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      adapter.setHermesSessionCaptureHandler(async () => undefined);
      const run = {
        id: "24807021-4403-49d3-9349-dd375a3e0563", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      try {
        const marker = "HERMES_EBB_MCP_REGISTRATION_FAILED";
        supervisor.stderrChunks = [new TextEncoder().encode(`${marker}\nsecret-tail-must-not-escape`)];
        mockExecutor.setNextResult({ exitCode: 1, stdout: "", stderr: `${marker}\n` });
        const markerFailure = await adapter.startRun(run).then(
          () => "unexpected success", (error: unknown) => error instanceof Error ? error.message : String(error),
        );
        expect(markerFailure).toBe(marker);
        expect(markerFailure).not.toContain("secret-tail-must-not-escape");

        const unrelatedStderr = `provider detail ${marker} must not escape`;
        supervisor.stderrChunks = [new TextEncoder().encode(unrelatedStderr)];
        mockExecutor.setNextResult({ exitCode: 1, stdout: "", stderr: unrelatedStderr });
        const unrelatedFailure = await adapter.startRun({ ...run, id: "db9857cf-0fb1-49ed-99d3-d514ad93ee65" })
          .then(() => "unexpected success", (error: unknown) => error instanceof Error ? error.message : String(error));
        expect(unrelatedFailure).toBe("HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_1:CATEGORY_OTHER");
        expect(unrelatedFailure).not.toContain(unrelatedStderr);

        supervisor.stderrChunks = [new TextEncoder().encode("401 unauthorized\nprivate credential must not escape")];
        mockExecutor.setNextResult({ exitCode: 103, stdout: "", stderr: "" });
        const categorizedFailure = await adapter.startRun({ ...run, id: "b77f61a8-a292-4d93-b33a-1213ee95ddc0" })
          .then(() => "unexpected success", (error: unknown) => error instanceof Error ? error.message : String(error));
        expect(categorizedFailure).toBe("HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_103:CATEGORY_AUTH");
        expect(categorizedFailure).not.toContain("private credential");
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it.each([
      ["ModuleNotFoundError", "HERMES_PYTHON_STARTUP_EXCEPTION:ModuleNotFoundError"],
      ["PermissionError", "HERMES_PYTHON_STARTUP_EXCEPTION:PermissionError"],
      ["UnknownProviderError", "HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_1:CATEGORY_PROCESS_ERROR"],
      ["detail ModuleNotFoundError", "HERMES_SESSION_STREAM_INVALID:MISSING_INIT:EXIT_1:CATEGORY_PROCESS_ERROR"],
    ])("reports only the allowlisted Python startup exception class %s", async (exceptionClass, expected) => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-python-diagnostic-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const secret = "secret-must-not-escape".repeat(40);
      const encoder = new TextEncoder();
      supervisor.stderrChunks = [
        encoder.encode("Traceback (most recent call last):\n  private-path-must-not-escape\n"),
        encoder.encode(exceptionClass.slice(0, 4)),
        encoder.encode(`${exceptionClass.slice(4)}: ${secret}\n`),
      ];
      mockExecutor.setNextResult({ exitCode: 1, stdout: "", stderr: "" });
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory, managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      const captures: HermesSessionCapture[] = [];
      adapter.setHermesSessionCaptureHandler(async (capture) => { captures.push(capture); });
      const run = {
        id: "035e9033-1b14-49cf-adb3-fbb2c668b07f", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      try {
        const failure = await adapter.startRun(run).then(() => undefined, (error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(expected);
        expect((failure as Error).stack).not.toContain("secret-must-not-escape");
        expect((failure as Error).stack).not.toContain("private-path-must-not-escape");
        expect(supervisor.lastRequest?.captureOutput).toBe(false);
        expect(mockArtifactStore.getArtifacts(run.id)).toBeUndefined();
        expect(JSON.stringify(captures)).not.toContain("secret-must-not-escape");
        expect(JSON.stringify(captures)).not.toContain("private-path-must-not-escape");
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it.each([[123, 45, 10], [0, 0, 0]])("collects live Hermes terminal token counts %i/%i with unknown cost and no raw output retention", async (inputTokens, outputTokens, cachedInputTokens) => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-live-usage-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      supervisor.stdoutChunks = [new TextEncoder().encode([
        JSON.stringify({ type: "system", subtype: "init", session_id: "usage-session" }),
        JSON.stringify({ type: "result", session_id: "usage-session",
          tokens: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens, cache_read: cachedInputTokens, cache_write: 0 },
          text: "private-answer", error: "private-error" }), "",
      ].join("\n"))];
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory, managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      const captures: HermesSessionCapture[] = [];
      adapter.setHermesSessionCaptureHandler(async (capture) => { captures.push(capture); });
      const run = {
        id: "059fa3de-d204-49a8-b6a6-7cc3491aebf9", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      try {
        await adapter.startRun(run);
        await expect(adapter.collectUsage(run.id)).resolves.toEqual({
          inputTokens, outputTokens, cachedInputTokens, cost: null,
        });
        expect(supervisor.lastRequest?.captureOutput).toBe(false);
        expect(mockArtifactStore.getArtifacts(run.id)).toEqual({ stdout: "", stderr: "", exitCode: 0 });
        expect(JSON.stringify(captures)).not.toContain("private-answer");
        expect(JSON.stringify(captures)).not.toContain("private-error");
        supervisor.stdoutChunks = [new TextEncoder().encode(
          `${JSON.stringify({ type: "system", subtype: "init", session_id: "usage-session" })}\n`,
        )];
        const withoutResult = { ...run, id: "45380b48-e4f9-49e9-b9c7-975757f371d4" };
        await adapter.startRun(withoutResult);
        await expect(adapter.collectUsage(withoutResult.id)).rejects.toThrow("HERMES_USAGE_MISSING");
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("retries a rejected sticky invalidation callback and clears a previously bound session", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-capture-retry-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const encoder = new TextEncoder();
      supervisor.stdoutChunks = [
        encoder.encode(`${JSON.stringify({ type: "system", subtype: "init", session_id: "session-retry-123" })}\n`),
        encoder.encode('{"type":\n'),
      ];
      const durable = { sessionId: null as string | null, captureState: "UNBOUND" as "UNBOUND" | "BOUND" | "INVALID" };
      const callbacks: HermesSessionCapture[] = [];
      let failFirstInvalidation = true;
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      adapter.setHermesSessionCaptureHandler(async (capture) => {
        callbacks.push(capture);
        if (capture.status === "captured") {
          durable.sessionId = capture.sessionId;
          durable.captureState = "BOUND";
          return;
        }
        if (failFirstInvalidation) {
          failFirstInvalidation = false;
          throw new Error("injected durable invalidation failure");
        }
        durable.sessionId = null;
        durable.captureState = "INVALID";
      });
      const run = {
        id: "2cb555ae-7d1f-44b2-8bc4-fc0f162c3d81", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      try {
        await expect(adapter.startRun(run)).rejects.toThrow();
        expect(callbacks.filter((capture) => capture.status === "invalid")).toHaveLength(2);
        expect(durable).toEqual({ sessionId: null, captureState: "INVALID" });
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("invalidates a bound session when supervisor completion reports stdout transport failure", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-stream-error-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      supervisor.stdoutChunks = [new TextEncoder().encode(`${JSON.stringify({
        type: "system", subtype: "init", session_id: "session-before-stream-error",
      })}\n`)];
      supervisor.completionError = new Error("simulated stdout transport failure");
      const durable = { sessionId: null as string | null, captureState: "UNBOUND" as "UNBOUND" | "BOUND" | "INVALID" };
      const captures: HermesSessionCapture[] = [];
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      adapter.setHermesSessionCaptureHandler(async (capture) => {
        captures.push(capture);
        if (capture.status === "captured") {
          durable.sessionId = capture.sessionId;
          durable.captureState = "BOUND";
        } else {
          durable.sessionId = null;
          durable.captureState = "INVALID";
        }
      });
      const run = {
        id: "fb674310-1f04-4f44-9ce3-a6f1ff788a21", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      try {
        await expect(adapter.startRun(run)).rejects.toThrow("simulated stdout transport failure");
        expect(captures.map((capture) => capture.status)).toEqual(["captured", "invalid"]);
        expect(durable).toEqual({ sessionId: null, captureState: "INVALID" });
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("preserves inherited Hermes selection rather than replacing it with Run metadata", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-home-mismatch-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        environment: { HERMES_HOME: path.join(resultDirectory, "other-profile"), HERMES_PROFILE: "chosen-profile", HOME: "existing-home", HERMES_CONFIG: "existing-config" },
      }, supervisor);
      const run = {
        id: "c044e33a-705a-4b5b-83b6-721773542a9a", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      try {
        await adapter.startRun(run);
        expect(supervisor.launchCalls).toBe(1);
        expect(supervisor.lastRequest?.environment.HERMES_HOME).toBe(path.join(resultDirectory, "other-profile"));
        expect(supervisor.lastRequest?.environment.HERMES_PROFILE).toBe("chosen-profile");
        expect(supervisor.lastRequest?.environment.HOME).toBe("existing-home");
        expect(supervisor.lastRequest?.environment.HERMES_CONFIG).toBe("existing-config");
        expect(supervisor.lastRequest?.environment.HERMES_MODEL).toBeUndefined();

      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("keeps absent Hermes selection variables absent for the ordinary configured default", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-env-absent-"));
      const previous = new Map(["HERMES_HOME", "HERMES_CONFIG", "HERMES_PROFILE"].map((name) => [name, process.env[name]]));
      for (const name of previous.keys()) delete process.env[name];
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const captures: HermesSessionCapture[] = [];
      supervisor.stdoutChunks = [new TextEncoder().encode(`${JSON.stringify({
        type: "system", subtype: "init", session_id: "session-shared-home-123",
      })}\n`)];
      mockExecutor.setNextResult({ exitCode: 0, stdout: "", stderr: "" });
      const adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory, managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"), checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      adapter.setHermesSessionCaptureHandler(async (capture) => { captures.push(capture); });
      const run = {
        id: "c044e33a-705a-4b5b-83b6-721773542a9a", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      try {
        await adapter.startRun(run);
        for (const name of previous.keys()) expect(supervisor.lastRequest?.environment).not.toHaveProperty(name);
        expect(captures).toMatchObject([{
          hermesHome: path.join(resultDirectory, "configured-hermes"),
          status: "captured", sessionId: "session-shared-home-123",
        }]);
      } finally {
        for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("leaves configured provider selection to Hermes without reading the legacy Ebb SecretStore", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-provider-bridge-"));
      const resolveForService = vi.fn().mockResolvedValue("legacy-credential-must-not-be-read");
      const scopeSupervisor = new MockProcessScopeSupervisor(mockExecutor);
      adapter = allowTestManagedHermesSelection(new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        secretStore: { resolveForService },
        provider: { baseUrl: "https://models.example.test/v1", secretName: "legacy" },
      } as unknown as ConstructorParameters<typeof HermesRuntimeAdapter>[2], scopeSupervisor));
      const run = {
        id: "52ed5533-5a27-4547-94a7-43f04d55df73", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        hermesSelection: await testHermesSelection("52ed5533-5a27-4547-94a7-43f04d55df73", "model-x", resultDirectory),
      };

      await expect(adapter.startRun(run)).resolves.toBeUndefined();

      expect(resolveForService).not.toHaveBeenCalled();
      expect(scopeSupervisor.launchCalls).toBe(1);
      expect(scopeSupervisor.lastRequest?.environment.HERMES_HOME)
        .toBe(process.env.HERMES_HOME);
      expect(mockExecutor.getCalls()[0]?.args).not.toContain("--model");
      expect(mockExecutor.getCalls()[0]?.args).not.toContain("--provider");
      await expect(fs.stat(path.join(resultDirectory, "configured-hermes", "config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("does not create or write a Hermes profile during launch", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-profile-write-"));
      const runId = "b8617c18-bb88-4ce3-af9e-9f7f206c27ac";
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      } as unknown as ConstructorParameters<typeof HermesRuntimeAdapter>[2]);
      const run = {
        id: runId, role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        hermesSelection: await testHermesSelection(runId, "model-x", resultDirectory),
      };

      try {
        await adapter.startRun(run);
        await expect(fs.stat(path.join(resultDirectory, "configured-hermes", "config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(resultDirectory, "profiles"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("does not dispatch Hermes when cancellation arrives before the first asynchronous preparation completes", async () => {
      const scopeSupervisor = new MockProcessScopeSupervisor(mockExecutor);
      adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, scopeSupervisor);
      allowTestManagedHermesSelection(adapter);
      const run = {
        id: "93a15f8a-52f4-4bdb-9da2-e302095d4391", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        hermesSelection: await testHermesSelection("93a15f8a-52f4-4bdb-9da2-e302095d4391", "model-x"),
      };

      const starting = adapter.startRun(run);
      const cancelling = adapter.cancelRun(run.id);
      await Promise.all([starting, cancelling]);

      expect(scopeSupervisor.launchCalls).toBe(0);
      expect(scopeSupervisor.payloadDispatches).toBe(0);
      expect(mockExecutor.getCalls()).toHaveLength(0);
    });

    it("waits for a pending launch to prove stop and withholds Hermes dispatch when cancelled before launch authorization", async () => {
      const scopeSupervisor = new MockProcessScopeSupervisor(mockExecutor);
      const launchEntered = deferred<void>();
      const releaseLaunch = deferred<void>();
      scopeSupervisor.beforeProcessExecution = async () => {
        launchEntered.resolve();
        await releaseLaunch.promise;
      };
      adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, scopeSupervisor);
      allowTestManagedHermesSelection(adapter);
      const run = {
        id: "6e9f65c6-79c8-4da9-93a7-e29a1566d4f0", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        hermesSelection: await testHermesSelection("6e9f65c6-79c8-4da9-93a7-e29a1566d4f0", "model-x"),
      };

      const starting = adapter.startRun(run);
      await launchEntered.promise;
      let cancellationSettled = false;
      const cancelling = adapter.cancelRun(run.id).then(() => { cancellationSettled = true; });
      await Promise.resolve();
      try {
        expect(cancellationSettled).toBe(false);
      } finally {
        releaseLaunch.resolve();
      }
      await Promise.all([starting, cancelling]);

      expect(scopeSupervisor.payloadDispatches).toBe(0);
      expect(scopeSupervisor.stopCalls).toHaveLength(1);
      expect(await scopeSupervisor.inspect({
        runId: run.id, containmentKind: process.platform === "win32" ? "windows-job" : "systemd-user-service",
        containmentId: "unused", launchNonce: "unused", systemdInvocationId: null, systemdControlGroup: null,
        supervisorPid: null, supervisorStartIdentity: null, pid: null, platform: null,
        processStartIdentity: null, executableIdentity: null, state: "STOPPING",
      })).toMatchObject({ state: "STOPPED" });
    });

    it("persists LAUNCH_NOT_DISPATCHED only after the typed supervisor no-dispatch result", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-launch-no-dispatch-"));
      const databasePath = path.join(root, "state.sqlite");
      const database = createSqliteDatabase(databasePath);
      database.exec(`CREATE TABLE run_process_owners (
        run_id TEXT PRIMARY KEY, source_tag TEXT NOT NULL, hermes_home TEXT NOT NULL,
        containment_kind TEXT NOT NULL, containment_id TEXT NOT NULL, launch_nonce TEXT NOT NULL,
        systemd_invocation_id TEXT, systemd_control_group TEXT, supervisor_pid INTEGER,
        supervisor_start_identity TEXT, pid INTEGER, platform TEXT, process_start_identity TEXT,
        executable_identity TEXT, state TEXT NOT NULL, stop_evidence TEXT, updated_at TEXT NOT NULL,
        hermes_source_snapshot_key TEXT, capture_state TEXT NOT NULL DEFAULT 'UNBOUND'
      )`);
      createProcessOwnerGenerationFixture(database);
      const runId = "09ef53bd-819b-43a0-aabd-286c15e0d36f";
      const resultDirectory = path.join(root, "results");
      const selection = await testHermesSelection(runId, "model-x", resultDirectory);
      const preparedOwner = prepareRunProcessOwner(runId, selection.hermesHome,
        process.platform === "win32" ? "windows-job" : "systemd-user-service");
      database.transaction((tx) => insertRunProcessOwnerTx(tx, preparedOwner));

      const launchEntered = deferred<void>();
      const releaseLaunch = deferred<void>();
      const supervisor: ProcessScopeSupervisor = {
        launch: async () => {
          launchEntered.resolve();
          await releaseLaunch.promise;
          throw new ProcessScopeLaunchNotDispatchedError();
        },
        inspect: async () => ({ state: "UNKNOWN", reason: "NOT_USED" }),
        stop: async () => ({ state: "UNKNOWN", reason: "NOT_USED" }),
        waitForStopped: async () => ({ state: "UNKNOWN", reason: "NOT_USED" }),
      };
      adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        databasePath, managedWorktree: path.join(root, "workspace"), resultDirectory,
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      (adapter as unknown as { getManagedWorktree(run: { id: string }): string }).getManagedWorktree = () => path.join(root, "workspace");
      allowTestManagedHermesSelection(adapter);
      expect(() => (adapter as unknown as {
        persistLaunchNotDispatched(id: string, error: unknown): void;
      }).persistLaunchNotDispatched(runId, new Error("forged generic Error"))).toThrow(TypeError);
      expect(database.get<{ state: string; stop_evidence: string | null }>(
        "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId },
      )).toEqual({ state: "PREPARED", stop_evidence: null });
      const run = {
        id: runId, role: "Developer", runtime: "hermes", model: "model-x", taskId: null, epicId: null,
        status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        hermesSelection: selection,
      };

      try {
        const started = adapter.startRun(run).then(
          () => ({ status: "completed" as const }),
          (error: unknown) => ({ status: "failed" as const, error }),
        );
        const launchGate = await Promise.race([
          launchEntered.promise.then(() => "launch" as const),
          started.then((result) => ({ status: "start-settled" as const, result })),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
        ]);
        if (launchGate !== "launch") {
          if (launchGate === "timeout") throw new Error("TEST_LAUNCH_NOT_REACHED_IN_TIME");
          throw new Error("TEST_START_SETTLED_BEFORE_SUPERVISOR_LAUNCH", { cause: launchGate.result.status === "failed" ? launchGate.result.error : undefined });
        }
        const cancelled = adapter.cancelRun(runId);
        releaseLaunch.resolve();
        const [startResult] = await Promise.all([started, cancelled]);

        expect(startResult.status).toBe("completed");
        expect(database.get<{ state: string; stop_evidence: string | null }>(
          "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId },
        )).toEqual({ state: "STOPPED", stop_evidence: "LAUNCH_NOT_DISPATCHED" });
      } finally {
        database.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it.each(["start", "resume"] as const)("uses the persisted capability workspace for Hermes %s", async (operation) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-persisted-workspace-"));
      const workspace = path.join(root, "managed-worktree");
      const repository = path.join(root, "repository");
      const databasePath = path.join(root, "state.sqlite");
      const resultDirectory = path.join(root, "results");
      const checkpointDirectory = path.join(root, "checkpoints");
      await fs.mkdir(workspace);
      await fs.mkdir(repository);
      const database = createSqliteDatabase(databasePath);
      database.exec(`
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          runtime TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          task_id TEXT,
          epic_id TEXT,
          session_id TEXT,
          capability_ref TEXT UNIQUE,
          capability_json TEXT
        )
      `);
      database.exec(`
        CREATE TABLE run_process_owners (
          run_id TEXT PRIMARY KEY, source_tag TEXT NOT NULL, hermes_home TEXT NOT NULL,
          containment_kind TEXT NOT NULL, containment_id TEXT NOT NULL, launch_nonce TEXT NOT NULL,
          systemd_invocation_id TEXT, systemd_control_group TEXT, supervisor_pid INTEGER,
          supervisor_start_identity TEXT, pid INTEGER, platform TEXT, process_start_identity TEXT,
          executable_identity TEXT, state TEXT NOT NULL, stop_evidence TEXT, updated_at TEXT NOT NULL,
          hermes_source_snapshot_key TEXT, capture_state TEXT NOT NULL DEFAULT 'UNBOUND'
        )
      `);
      createProcessOwnerGenerationFixture(database);
      database.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE epics (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, display_id TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, epic_id TEXT);
        CREATE TABLE approvals (id TEXT PRIMARY KEY, subject_id TEXT, subject_type TEXT, type TEXT, status TEXT);
        CREATE TABLE onboarding_configs (project_id TEXT, repository_path TEXT, facts_json TEXT, proposed_json TEXT, status TEXT, approval_id TEXT);
        CREATE TABLE worktrees (id TEXT PRIMARY KEY, repo_path TEXT, path TEXT, branch TEXT, removed_at TEXT);
        CREATE TABLE git_operations (id TEXT PRIMARY KEY, type TEXT, status TEXT, repo_path TEXT, branch_name TEXT, worktree_id TEXT, target_ref TEXT, created_at TEXT, verified_at TEXT);
      `);
      database.run("INSERT INTO projects VALUES ('project-1','ACTIVE')");
      database.run("INSERT INTO tasks VALUES ('persisted-task','project-1',NULL)");
      database.run("INSERT INTO approvals VALUES ('onboarding-approval','project-1','PROJECT','WORKFLOW_CHANGE','APPROVED')");
      database.run(
        "INSERT INTO onboarding_configs VALUES ('project-1',$repository,'{}',$proposed,'ACTIVE','onboarding-approval')",
        { repository, proposed: JSON.stringify({ defaultBranch: "master" }) },
      );
      database.run(
        "INSERT INTO agent_runs (id, role, runtime, model, status, task_id, epic_id, capability_ref, capability_json) VALUES ($id, $role, $runtime, $model, $status, $task_id, $epic_id, $capability_ref, $capability_json)",
        {
          id: "dc20d357-c4a5-4f42-a31a-320cfade61ec",
          role: "Developer",
          runtime: "hermes",
          model: "default",
          status: "STARTED",
          task_id: "persisted-task",
          epic_id: null,
          capability_ref: "persisted-capability",
          capability_json: JSON.stringify({
            runId: "dc20d357-c4a5-4f42-a31a-320cfade61ec",
            capabilityRef: "persisted-capability",
            role: "developer",
            workspace,
            allowedTools: ["submit_result"],
          }),
        },
      );
      database.run(
        "INSERT INTO worktrees (id, repo_path, path, branch, removed_at) VALUES ($id, $repoPath, $path, $branch, NULL)",
        { id: "persisted-task", repoPath: repository, path: workspace, branch: "task/persisted-task" },
      );
      const verifiedAt = new Date().toISOString();
      database.run(
        "INSERT INTO git_operations (id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES ('worktree-op','CREATE_WORKTREE','VERIFIED',$repoPath,'task/persisted-task','persisted-task','master',$verifiedAt,$verifiedAt)",
        { repoPath: repository, verifiedAt },
      );
      const persistedSelection = await testHermesSelection("dc20d357-c4a5-4f42-a31a-320cfade61ec", "default", resultDirectory);
      database.run(
        `INSERT INTO run_process_owners(
          run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,
          systemd_invocation_id,systemd_control_group,supervisor_pid,supervisor_start_identity,pid,platform,
          process_start_identity,executable_identity,state,stop_evidence,updated_at,hermes_source_snapshot_key
        ) VALUES($runId,$sourceTag,$hermesHome,$kind,$containmentId,$launchNonce,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'PREPARED',NULL,$now,$snapshotKey)`,
        {
          runId: "dc20d357-c4a5-4f42-a31a-320cfade61ec",
          sourceTag: "ebb-run:dc20d357-c4a5-4f42-a31a-320cfade61ec",
          hermesHome: persistedSelection.hermesHome,
          snapshotKey: null,
          kind: process.platform === "win32" ? "windows-job" : "systemd-user-service",
          containmentId: "a".repeat(64),
          launchNonce: "b".repeat(64),
          now: new Date().toISOString(),
        },
      );
      insertCurrentProcessOwnerGenerationFixture(database, "dc20d357-c4a5-4f42-a31a-320cfade61ec");
      const run = {
        id: "dc20d357-c4a5-4f42-a31a-320cfade61ec", role: "Developer", runtime: "hermes", model: "default",
        taskId: "persisted-task", epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        capabilityRef: "persisted-capability",
        hermesSelection: persistedSelection,
      };

      try {
        const scopeSupervisor = new MockProcessScopeSupervisor(mockExecutor);
        scopeSupervisor.beforeProcessExecution = (owner) => {
          expect(owner.state).toBe("LAUNCHING");
          expect(database.get<{ state: string; pid: number | null }>(
            "SELECT state,pid FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
          )).toEqual({ state: "LIVE", pid: 303 });
        };
        adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
          databasePath,
          resultDirectory,
          checkpointDirectory,
        }, scopeSupervisor);
        allowTestManagedHermesSelection(adapter);
        mockExecutor.setNextResult({ exitCode: 0, stdout: "session: persisted", stderr: "" });

        if (operation === "resume") {
          database.exec(`ALTER TABLE agent_runs ADD COLUMN attempt INTEGER;
            ALTER TABLE agent_runs ADD COLUMN output TEXT;
            ALTER TABLE agent_runs ADD COLUMN ended_at TEXT;
            ALTER TABLE agent_runs ADD COLUMN prompt TEXT;
            CREATE TABLE run_resume_bindings (run_id TEXT PRIMARY KEY, original_session_id TEXT NOT NULL);`);
          const originalPrompt = "Original task: implement the requested feature.\nAcceptance: preserve existing user data.\nContract: use submit_result with the Developer output schema.";
          database.run("UPDATE agent_runs SET status='IN_PROGRESS',attempt=1,session_id='saved-session',prompt=$prompt WHERE id=$runId", { runId: run.id, prompt: originalPrompt });
          database.run("INSERT INTO run_resume_bindings VALUES ($runId,'saved-session')", { runId: run.id });
          const proofs = (adapter as unknown as { verifiedManagedSelections: WeakSet<HermesManagedRunSelection> }).verifiedManagedSelections;
          proofs.add(persistedSelection);
          database.run("UPDATE agent_runs SET prompt=NULL WHERE id=$runId", { runId: run.id });
          await expect(adapter.resumeRun(run.id, { sessionId: "saved-session", attempt: 1, hermesSelection: persistedSelection }))
            .rejects.toThrow("HERMES_RESUME_PROMPT_UNAVAILABLE");
          expect(scopeSupervisor.launchCalls).toBe(0);
          database.run("UPDATE agent_runs SET prompt=$prompt WHERE id=$runId", { runId: run.id, prompt: originalPrompt });
          await adapter.resumeRun(run.id, { sessionId: "saved-session", attempt: 1, hermesSelection: persistedSelection });
          const resumeArgs = scopeSupervisor.lastRequest!.args;
          expect(resumeArgs.slice(resumeArgs.indexOf("--resume"), resumeArgs.indexOf("--resume") + 2))
            .toEqual(["--resume", "saved-session"]);
          expect(resumeArgs).toContain("--no-restore-cwd");
          const maxTurnsIndex = resumeArgs.indexOf("--max-turns");
          expect(resumeArgs.slice(maxTurnsIndex, maxTurnsIndex + 2)).toEqual(["--max-turns", "500"]);
          const queryFile = resumeArgs[resumeArgs.indexOf("--query-file") + 1];
          expect(resumeArgs).toContain("--query-file");
          const continuation = await fs.readFile(queryFile!, "utf8");
          // Hermes can emit init before persisting its first user turn; recovery must carry the task itself.
          expect(continuation).toContain(originalPrompt);
          expect(continuation).toContain("First inspect the restored conversation and current workspace state");
          expect(continuation).toContain("Continue only the remaining work");
        } else {
          await adapter.startRun(run);
        }

        expect(mockExecutor.getCalls()[0]?.options?.cwd).toBe(workspace);
        expect(scopeSupervisor.lastRequest?.args.slice(
          scopeSupervisor.lastRequest.args.indexOf("--source"),
          scopeSupervisor.lastRequest.args.indexOf("--source") + 2,
        )).toEqual(["--source", `ebb-run:${run.id}`]);
        expect(database.get<{ session_id: string | null }>(
          "SELECT session_id FROM agent_runs WHERE id=$id", { id: run.id },
        )?.session_id).toBe(operation === "resume" ? "saved-session" : null);
        expect(database.get<{ state: string; stop_evidence: string | null }>(
          "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
        )).toEqual({ state: "STOPPED", stop_evidence: stoppedEvidence(scopeSupervisor.lastLiveIdentity!) });

        const failedRun = {
          ...run, id: "837923a5-32b2-4724-8efc-0b0ef8b989bb", capabilityRef: "failed-capability",
          hermesSelection: await testHermesSelection("837923a5-32b2-4724-8efc-0b0ef8b989bb", "default", resultDirectory),
        };
        database.run(
          "INSERT INTO agent_runs (id,role,runtime,model,status,task_id,epic_id,session_id,capability_ref,capability_json) VALUES ($id,$role,$runtime,$model,$status,$taskId,NULL,NULL,$capabilityRef,$capabilityJson)",
          {
            id: failedRun.id,
            role: failedRun.role,
            runtime: failedRun.runtime,
            model: failedRun.model,
            status: failedRun.status,
            taskId: failedRun.taskId,
            capabilityRef: failedRun.capabilityRef,
            capabilityJson: JSON.stringify({
              runId: failedRun.id,
              capabilityRef: failedRun.capabilityRef,
              role: "developer",
              workspace,
              allowedTools: ["submit_result"],
            }),
          },
        );
        database.run(
          `INSERT INTO run_process_owners(
            run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,
            systemd_invocation_id,systemd_control_group,supervisor_pid,supervisor_start_identity,pid,platform,
            process_start_identity,executable_identity,state,stop_evidence,updated_at,hermes_source_snapshot_key
          ) VALUES($runId,$sourceTag,$hermesHome,$kind,$containmentId,$launchNonce,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'PREPARED',NULL,$now,$snapshotKey)`,
          {
            runId: failedRun.id,
            sourceTag: `ebb-run:${failedRun.id}`,
            hermesHome: failedRun.hermesSelection.hermesHome,
            snapshotKey: null,
            kind: process.platform === "win32" ? "windows-job" : "systemd-user-service",
            containmentId: "c".repeat(64),
            launchNonce: "d".repeat(64),
            now: new Date().toISOString(),
          },
        );
        insertCurrentProcessOwnerGenerationFixture(database, failedRun.id);
        database.exec(`CREATE TRIGGER reject_live_owner_identity BEFORE UPDATE OF state ON run_process_owners
          WHEN NEW.run_id='${failedRun.id}' AND NEW.state='LIVE'
          BEGIN SELECT RAISE(ABORT,'test identity persistence failure'); END;`);
        const failingSupervisor = new MockProcessScopeSupervisor(mockExecutor);
        const failingAdapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
          databasePath,
          resultDirectory,
          checkpointDirectory,
        }, failingSupervisor);
        allowTestManagedHermesSelection(failingAdapter);
        const ownerRead = vi.spyOn(failingAdapter as unknown as {
          readPersistedOwnerState(runId: string): string | undefined;
        }, "readPersistedOwnerState").mockImplementationOnce(() => {
          expect(failingSupervisor.stopCalls).toHaveLength(1);
          throw new Error("injected owner-state read failure");
        });
        await expect(failingAdapter.startRun(failedRun)).rejects.toThrow(/injected owner-state read failure/);
        expect(ownerRead).toHaveBeenCalledTimes(1);
        expect(failingSupervisor.stopCalls).toHaveLength(1);
        const stoppedScope = failingSupervisor.stopCalls[0];
        expect(stoppedScope).toMatchObject({ runId: failedRun.id, containmentId: "c".repeat(64) });
        if (!stoppedScope) throw new Error("Expected the exact scope to be stopped.");
        await expect(failingSupervisor.inspect(stoppedScope)).resolves.toMatchObject({ state: "STOPPED", evidence: stoppedEvidence(stoppedScope) });
        expect(failingSupervisor.payloadDispatches).toBe(0);
        expect(mockExecutor.getCalls()).toHaveLength(1);
        expect(database.get<{ state: string; stop_evidence: string | null }>(
          "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId: failedRun.id },
        )).toEqual({ state: "LAUNCHING", stop_evidence: null });

        database.exec("DROP TRIGGER reject_live_owner_identity");
        const stopPersistenceRun = {
          ...run, id: "3075c8e3-dbbe-4cdb-a3e1-58c02f61720f", capabilityRef: "stop-proof-failure-capability",
          hermesSelection: await testHermesSelection("3075c8e3-dbbe-4cdb-a3e1-58c02f61720f", "default", resultDirectory),
        };
        database.run(
          "INSERT INTO agent_runs (id,role,runtime,model,status,task_id,epic_id,session_id,capability_ref,capability_json) VALUES ($id,$role,$runtime,$model,$status,$taskId,NULL,NULL,$capabilityRef,$capabilityJson)",
          {
            id: stopPersistenceRun.id,
            role: stopPersistenceRun.role,
            runtime: stopPersistenceRun.runtime,
            model: stopPersistenceRun.model,
            status: stopPersistenceRun.status,
            taskId: stopPersistenceRun.taskId,
            capabilityRef: stopPersistenceRun.capabilityRef,
            capabilityJson: JSON.stringify({
              runId: stopPersistenceRun.id,
              capabilityRef: stopPersistenceRun.capabilityRef,
              role: "developer",
              workspace,
              allowedTools: ["submit_result"],
            }),
          },
        );
        database.run(
          `INSERT INTO run_process_owners(
            run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,
            systemd_invocation_id,systemd_control_group,supervisor_pid,supervisor_start_identity,pid,platform,
            process_start_identity,executable_identity,state,stop_evidence,updated_at,hermes_source_snapshot_key
          ) VALUES($runId,$sourceTag,$hermesHome,$kind,$containmentId,$launchNonce,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'PREPARED',NULL,$now,$snapshotKey)`,
          {
            runId: stopPersistenceRun.id,
            sourceTag: `ebb-run:${stopPersistenceRun.id}`,
            hermesHome: stopPersistenceRun.hermesSelection.hermesHome,
            snapshotKey: null,
            kind: process.platform === "win32" ? "windows-job" : "systemd-user-service",
            containmentId: "e".repeat(64),
            launchNonce: "f".repeat(64),
            now: new Date().toISOString(),
          },
        );
        insertCurrentProcessOwnerGenerationFixture(database, stopPersistenceRun.id);
        database.exec(`CREATE TRIGGER reject_stopped_owner BEFORE UPDATE OF state ON run_process_owners
          WHEN NEW.run_id='${stopPersistenceRun.id}' AND NEW.state='STOPPED'
          BEGIN SELECT RAISE(ABORT,'injected STOPPED evidence persistence failure'); END;`);
        const stopFailSupervisor = new MockProcessScopeSupervisor(mockExecutor);
        const stopFailAdapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
          databasePath,
          resultDirectory,
          checkpointDirectory,
        }, stopFailSupervisor);
        allowTestManagedHermesSelection(stopFailAdapter);
        mockExecutor.setNextResult({ exitCode: 0, stdout: "session: stop-persistence", stderr: "" });

        await expect(stopFailAdapter.startRun(stopPersistenceRun))
          .rejects.toThrow(/injected STOPPED evidence persistence failure/);
        expect(database.get<{ status: string; capability_ref: string | null }>(
          "SELECT status,capability_ref FROM agent_runs WHERE id=$runId", { runId: stopPersistenceRun.id },
        )).toEqual({ status: "STARTED", capability_ref: stopPersistenceRun.capabilityRef });
        expect(database.get<{ state: string; stop_evidence: string | null }>(
          "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId: stopPersistenceRun.id },
        )).toEqual({ state: "STOPPING", stop_evidence: null });
        expect(stopFailSupervisor.payloadDispatches).toBe(1);
      } finally {
        database.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("fails closed when the run has no persisted capability workspace", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-missing-workspace-"));
      const databasePath = path.join(root, "state.sqlite");
      const resultDirectory = path.join(root, "results");
      const checkpointDirectory = path.join(root, "checkpoints");
      const database = createSqliteDatabase(databasePath);
      database.exec(`
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          runtime TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          task_id TEXT,
          epic_id TEXT,
          capability_ref TEXT UNIQUE,
          capability_json TEXT
        )
      `);
      const run = {
        id: "ef0d8916-b3bb-4638-832e-8f8cf985e259", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        capabilityRef: "missing-capability",
      };

      try {
        adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
          databasePath,
          resultDirectory,
          checkpointDirectory,
        });

        await expect(adapter.startRun(run)).rejects.toThrow(/workspace.*capability|capability.*workspace/i);
        expect(mockExecutor.getCalls()).toHaveLength(0);
      } finally {
        database.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it("wires the exact run result path into the in-memory MCP registration", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-result-wiring-"));
      const factory = vi.fn(testHermesLaunchTicketFactory);
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory, hermesLaunchTicketFactory: factory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      });
      const run = {
        id: "d0187208-0551-45f8-b0d6-18c36d596c72", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      await adapter.startRun(run);
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({ mcpServer: expect.objectContaining({
        args: expect.arrayContaining(["--capability-ref", "fixture-capability", "--result-file", path.join(resultDirectory, `${run.id}.json`)]),
      }) }));
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("builds correct launch command for new run", async () => {
      const run = {
        id: "18cb708d-4bc6-4151-829f-a5334b6068e6",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3-5-sonnet",
        taskId: "task-123",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc123", stderr: "" });

      await adapter.startRun(run);

      const calls = mockExecutor.getCalls();
      expect(calls).toHaveLength(1);

       const call = calls[0];
       if (!call) throw new Error("Expected at least one call");
       const { args } = call;
      expect(args).toContain("chat");
      expect(args).toContain("--query-file");
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--provider");
      expect(args).toContain("--toolsets");
      expect(args).toContain("mcp-ebb-orchestrator");
      expect(args).toContain("--in");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--source");
      const sourceIndex = args.indexOf("--source");
      expect(args.slice(sourceIndex, sourceIndex + 2)).toEqual(["--source", `ebb-run:${run.id}`]);
      expect(args).toContain("--max-turns");
      const maxTurnsIndex = args.indexOf("--max-turns");
      expect(args.slice(maxTurnsIndex, maxTurnsIndex + 2)).toEqual(["--max-turns", "500"]);

      const overrideExecutor = new MockProcessExecutor();
      const overrideAdapter = createTestRuntimeAdapter(overrideExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        roleLimit: 7,
      });
      overrideExecutor.setNextResult({ exitCode: 0, stdout: "session: override", stderr: "" });
      await overrideAdapter.startRun(run);
      const overrideArgs = overrideExecutor.getCalls()[0]!.args;
      const overrideMaxTurnsIndex = overrideArgs.indexOf("--max-turns");
      expect(overrideArgs.slice(overrideMaxTurnsIndex, overrideMaxTurnsIndex + 2)).toEqual(["--max-turns", "7"]);
    });

    it("writes prompt body to file and passes with --query-file", async () => {
      const run = {
        id: "3cba9cf2-8310-4d53-b6b3-d763e715e77c",
        role: "QA",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-456",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: xyz789", stderr: "" });

      await adapter.startRun(run);

      const calls = mockExecutor.getCalls();
       const call = calls[0];
       if (!call) throw new Error("Expected at least one call");
       const queryFileArg = call.args.find((a, i) => a === "--query-file" && i + 1 < call.args.length);
      expect(queryFileArg).toBeDefined();
      expect(call.args[call.args.indexOf("--query-file") + 1]).toMatch(/\.txt$/);
    });

    it("fallback prompt allows retry after validation errors but only one successful submission", async () => {
      const run = {
        id: "fallback-prompt-contract",
        role: "Developer",
        runtime: "hermes",
        model: "test",
        taskId: null,
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      } satisfies Parameters<HermesRuntimeAdapter["startRun"]>[0];
      const writePromptFile = (adapter as unknown as {
        writePromptFile(run: Parameters<HermesRuntimeAdapter["startRun"]>[0]): Promise<string>;
      }).writePromptFile.bind(adapter);
      const promptPath = await writePromptFile(run);
      try {
        const prompt = await fs.readFile(promptPath, "utf8");
        expect(prompt).toContain("Submit one successful structured result with submit_result before ending.");
        expect(prompt).toContain("If submit_result returns a validation error, correct the payload and retry");
        expect(prompt).toContain("after success, do not call submit_result again");
        expect(prompt).not.toMatch(/submit_result exactly once|exactly once[^\n]*submit_result/i);
      } finally {
        await fs.rm(path.dirname(promptPath), { recursive: true, force: true });
      }
    });

    it("never adds --worktree flag", async () => {
      const run = {
        id: "bf8c2a9b-b76b-4af0-98e6-72e683fcd012",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-789",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc", stderr: "" });

      await adapter.startRun(run);

       const calls = mockExecutor.getCalls();
       expect(calls[0]?.args).not.toContain("--worktree");
    });

    it("never adds --yolo flag", async () => {
      const run = {
        id: "fe1dc5a3-76a0-49ef-9cee-04d19ddc95a0",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-101",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc", stderr: "" });

      await adapter.startRun(run);

       const calls = mockExecutor.getCalls();
       expect(calls[0]?.args).not.toContain("--yolo");
    });

    it("keeps post-close stdout session IDs diagnostic-only", async () => {
      const run = {
        id: "2cabf888-f404-4f5e-8ed5-4a4bd0f53b33",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-202",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({
        exitCode: 0,
        stdout: "Initializing Hermes...\nsession: captured-session-123\nReady",
        stderr: "",
      });

      await adapter.startRun(run);

      const runState = await adapter.inspectRun(run.id);
      expect(runState.sessionId).toBeNull();
      const runResult = await adapter.runResult(run.id);
      expect(runResult.diagnostics?.sessionId).toBe("captured-session-123");
    });

    it("captures process PID", async () => {
      const run = {
        id: "8d31a54f-ec09-4262-9cbc-f0a54c0d0863",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-303",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: abc", stderr: "" });

      await adapter.startRun(run);

       const runState = await adapter.inspectRun(run.id);
      expect(runState).toBeDefined();
    });
  });

  describe("resumeRun", () => {
    it("rejects resume when no durable Run database and process supervisor are configured", async () => {
      await expect(adapter.resumeRun("existing-run", { sessionId: "saved-session", attempt: 1 }))
        .rejects.toThrow("HERMES_RESUME_DURABLE_RUNTIME_REQUIRED");
      expect(mockExecutor.getCalls()).toHaveLength(0);
    });
  });

  describe("cancelRun", () => {
    it("sends graceful signal first", async () => {
    // Сначала запускаем выполнение.
      const startRun = {
        id: "f0c1352c-4176-4355-8b4a-96dd0e09563f",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-cancel",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: test", stderr: "" });
      await adapter.startRun(startRun);

      await adapter.cancelRun(startRun.id);

       const runState = await adapter.inspectRun(startRun.id);
      expect(runState.status).toBe("CANCELLED");
    });
  });

  describe("collectResult", () => {
    it("exposes fixed tool counters for accepted submissions without retaining stream content", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-accepted-tool-counts-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const secretMarker = "accepted-stream-private-payload";
      supervisor.stdoutChunks = [new TextEncoder().encode([
        JSON.stringify({ type: "system", subtype: "init", session_id: "accepted-counts-session" }),
        JSON.stringify({ type: "tool_use", name: "mcp__ebb_orchestrator__workspace_read", input: { path: "src/health.js" } }),
        JSON.stringify({ type: "tool_result", name: "mcp__ebb_orchestrator__workspace_read", is_error: true, output: { error: `NOT_AVAILABLE: ${secretMarker}` } }),
        JSON.stringify({ type: "tool_use", name: "mcp__ebb_orchestrator__workspace_patch", input: { content: secretMarker } }),
        JSON.stringify({ type: "tool_result", name: "mcp__ebb_orchestrator__workspace_patch", is_error: false, output: secretMarker }),
        JSON.stringify({ type: "tool_use", name: "mcp__ebb_orchestrator__git_commit", input: { message: secretMarker } }),
        JSON.stringify({ type: "tool_result", name: "mcp__ebb_orchestrator__git_commit", is_error: true, output: { error: `PERMISSION_DENIED: ${secretMarker}` } }),
        JSON.stringify({ type: "tool_use", name: "mcp__untrusted__secret_tool", input: { secret: secretMarker } }),
        JSON.stringify({ type: "tool_result", name: "mcp__untrusted__secret_tool", is_error: true, output: secretMarker }),
      ].join("\n") + "\n")];
      const countsAdapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      countsAdapter.setHermesSessionCaptureHandler(async () => undefined);
      const run = {
        id: "7275730b-8cca-4cb7-b6c8-586c0db6c7d3", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: "task-accepted-counts", epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      try {
        await fs.writeFile(path.join(resultDirectory, `${run.id}.json`), JSON.stringify({
          version: "1.0.0", outcome: "COMPLETED", commitSha: "a".repeat(40),
        }), "utf8");
        mockExecutor.setNextResult({ exitCode: 0, stdout: "", stderr: "" });
        await countsAdapter.startRun(run);
        const outcome = await countsAdapter.collectResult(run.id);
        expect(outcome.validatedSubmission).toBe(true);
        expect(outcome.diagnostics?.toolCounts).toMatchObject({
          "workspace.read": { uses: 1, errors: 1, errorCategories: { NOT_AVAILABLE: 1 } },
          "workspace.patch": { uses: 1, errors: 0 },
          "git.commit": { uses: 1, errors: 1, errorCategories: { PERMISSION_DENIED: 1 } },
          submit_result: { uses: 0, errors: 0 },
        });
        expect(JSON.stringify(outcome.diagnostics?.toolCounts)).not.toContain(secretMarker);
        expect(JSON.stringify(outcome.diagnostics?.toolCounts)).not.toContain("untrusted");
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("exposes only submit_result summary counts when the validated result is missing", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-submit-counts-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const secretMarker = "submit-result-secret-payload";
      supervisor.stdoutChunks = [new TextEncoder().encode([
        JSON.stringify({ type: "system", subtype: "init", session_id: "counts-session" }),
        JSON.stringify({ type: "tool_use", name: "mcp__ebb_orchestrator__submit_result", input: { secret: secretMarker } }),
        JSON.stringify({ type: "tool_result", name: "mcp__ebb_orchestrator__submit_result", is_error: true, output: secretMarker }),
      ].join("\n") + "\n")];
      const countsAdapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      countsAdapter.setHermesSessionCaptureHandler(async () => undefined);
      const run = {
        id: "80d791dc-bf62-4320-a43a-08626bd29312", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: "task-submit-counts", epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      mockExecutor.setNextResult({ exitCode: 0, stdout: secretMarker, stderr: "" });

      try {
        await countsAdapter.startRun(run);
        const outcome = await countsAdapter.collectResult(run.id);
        expect(outcome.diagnostics).toMatchObject({ submitResultCalls: 1, submitResultErrors: 1 });
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(secretMarker);
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("returns AGENT_OUTPUT_MISSING when process exits without valid submitted result", async () => {
    // Сначала запускаем выполнение.
      const startRun = {
        id: "dcaebd41-2236-44ef-8e3e-4a38fdab73fd",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-no-result",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: test", stderr: "" });
      await adapter.startRun(startRun);

       // Вручную обновляем состояние выполнения, чтобы обозначить ошибку.
       const state = (adapter as unknown as { runs: Map<string, { exitCode?: number }> }).runs.get(startRun.id);
       if (state) {
         state.exitCode = 1;
       }

      const outcome = await adapter.collectResult(startRun.id);
      expect(outcome.success).toBe(false);
      expect(outcome.exitCode).toBe(1);
    });

    it("keeps only a bounded stderr category when managed capture disables process stderr output", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-managed-stderr-category-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const secret = "OPENAI_API_KEY=stderr-secret-marker";
      supervisor.stdoutChunks = [new TextEncoder().encode('{"type":"system","subtype":"init","session_id":"managed-stderr-category"}\n')];
      supervisor.stderrChunks = [new TextEncoder().encode(`HTTP 429 rate limit ${secret}\n`)];
      const managedAdapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      managedAdapter.setHermesSessionCaptureHandler(async () => undefined);
      const run = {
        id: "901def44-8ee8-4f6a-9612-f84205f55c11", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      try {
        mockExecutor.setNextResult({ exitCode: 1, stdout: "", stderr: "" });
        await managedAdapter.startRun(run);
        const outcome = await managedAdapter.collectResult(run.id);
        expect(supervisor.lastRequest?.captureOutput).toBe(false);
        expect(outcome.output).toBe("AGENT_OUTPUT_MISSING");
        expect(outcome.diagnostics?.stderr).toBe("");
        expect(outcome.diagnostics?.stderrCategory).toBe("RATE_LIMIT");
        expect(JSON.stringify(outcome.diagnostics)).not.toContain(secret);
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("does not consume another run's exact result file and returns diagnostics", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-results-"));
      await fs.writeFile(path.join(resultDirectory, "other-run.json"), JSON.stringify({ version: "1.0", outcome: "COMPLETED" }));
      const run = {
        id: "57742c2b-45b5-48b9-8bb9-6513fdac3be3", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-exact",
        epicId: null, status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      mockExecutor.setNextResult({ exitCode: 7, stdout: "session: exact-session", stderr: "agent failed" });
      const exactAdapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      });
      await exactAdapter.startRun(run);

      const outcome = await exactAdapter.collectResult(run.id);
      expect(outcome.output).toBe("AGENT_OUTPUT_MISSING");
      expect(outcome.diagnostics).toEqual({
        runId: run.id,
        sessionId: "exact-session",
        stderr: "agent failed",
        stderrCategory: "PROCESS_ERROR",
        exitCode: 7,
        artifactReferences: [path.join(resultDirectory, `${run.id}.json`), `run-artifacts://${run.id}`],
      });
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("re-reads and validates the exact run result at collection time", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-results-recheck-"));
      const run = {
        id: "cbe20714-7be8-4d55-9a23-b4e9397ff001", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-recheck",
        epicId: null, status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: recheck", stderr: "" });
      const exactAdapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      });
      await exactAdapter.startRun(run);
      await fs.writeFile(path.join(resultDirectory, `${run.id}.json`), JSON.stringify({ version: "1", outcome: "COMPLETED", commitSha: "test-commit-sha" }));
      expect((await exactAdapter.collectResult(run.id)).validatedSubmission).toBe(true);
      await fs.writeFile(path.join(resultDirectory, `${run.id}.json`), JSON.stringify({ version: "1", outcome: "INVALID" }));
      const invalid = await exactAdapter.collectResult(run.id);
      expect(invalid.validatedSubmission).toBe(false);
      expect(invalid.output).toBe("AGENT_OUTPUT_MISSING");
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("rejects provider-key overlays before they enter the Hermes child request", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-provider-env-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      const sentinel = "dummy-provider-env-sentinel";
      const child = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        environment: { OPENAI_API_KEY: sentinel },
      }, supervisor);
      const run = {
        id: "abcf7629-9c91-4754-8ca5-f746c566cd53", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-credential",
        epicId: null, status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      try {
        await expect(child.startRun(run)).rejects.toThrow(/Forbidden (credential|or unknown Hermes environment variable)/u);
        expect(supervisor.lastRequest).toBeUndefined();
        expect(mockExecutor.getCalls()).toHaveLength(0);
        expect(mockArtifactStore.getArtifacts(run.id)).toBeUndefined();
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });

    it("classifies only fixed live Hermes pre-init markers when session capture fails", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-startup-diagnostic-"));
      const supervisor = new MockProcessScopeSupervisor(mockExecutor);
      supervisor.stderrChunks = [new TextEncoder().encode("secret detail\nHERMES_EBB_MCP_REGISTRATION_FAILED\n")];
      mockExecutor.setNextResult({ exitCode: 1, stdout: "", stderr: "" });
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory, managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"), checkpointDirectory: sharedCheckpointDirectory,
      }, supervisor);
      adapter.setHermesSessionCaptureHandler(async () => undefined);
      const run = {
        id: "f6772d14-8cc9-4701-b79e-2aafc8d9a199", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      try {
        await expect(adapter.startRun(run)).rejects.toThrow("HERMES_EBB_MCP_REGISTRATION_FAILED");
      } finally {
        await fs.rm(resultDirectory, { recursive: true, force: true });
      }
    });
  });

  describe("inspectRun", () => {
    it("returns current state of a run", async () => {
      const run = {
        id: "ed5c0a45-a09c-4a22-8b80-d4084c01cd9f",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-inspect",
        epicId: null,
        status: "STARTED" as const,
        sessionId: null,
        attempt: null,
        triggerReason: null,
        contextVersion: "v1",
        outputSchemaVersion: "v1",
        startedAt: new Date(),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
      };

      mockExecutor.setNextResult({ exitCode: 0, stdout: "session: inspect-session", stderr: "" });

      await adapter.startRun(run);

       const state = await adapter.inspectRun(run.id);
      expect(state.id).toBe(run.id);
      expect(state.role).toBe("Developer");
    });
  });

  describe("healthCheck", () => {
    it("returns true when runtime is healthy", async () => {
      const healthy = await adapter.healthCheck();
      expect(healthy).toBe(true);
    });
  });

  describe("HermesCliBuilder", () => {
    it("builds launch args for new run", () => {
      const builder = new HermesCliBuilder();
      const args = builder.buildLaunchArgs({
        queryFile: "/tmp/prompt.txt",
        toolsets: ["mcp-ebb-orchestrator"],
        worktree: "/managed/worktree",
        ignoreRules: true,
        source: "tool",
        maxTurns: 20,
      });

      expect(args).toContain("chat");
      expect(args).toContain("--query-file");
      expect(args).toContain("/tmp/prompt.txt");
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--provider");
      expect(args).toContain("--toolsets");
      expect(args).toContain("mcp-ebb-orchestrator");
      expect(args).toContain("--in");
      expect(args).toContain("/managed/worktree");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--source");
      expect(args).toContain("tool");
      expect(args).toContain("--max-turns");
      expect(args).toContain("20");
    });

    it("builds resume args", () => {
      const builder = new HermesCliBuilder();
      const args = builder.buildResumeArgs({
        sessionId: "resume-123",
        queryFile: "/tmp/continuation.txt",
        toolsets: ["mcp-ebb-orchestrator"],
        worktree: "/managed/worktree",
        ignoreRules: true,
        source: "tool",
        maxTurns: 20,
      });

      expect(args).toContain("chat");
      expect(args).toContain("--resume");
      expect(args).toContain("resume-123");
      expect(args.slice(args.indexOf("--query-file"), args.indexOf("--query-file") + 2)).toEqual(["--query-file", "/tmp/continuation.txt"]);
      expect(args).toContain("--no-restore-cwd");
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--provider");
      expect(args.slice(args.indexOf("--format"), args.indexOf("--format") + 2)).toEqual(["--format", "stream-json"]);
      expect(args).toContain("--in");
      expect(args).toContain("/managed/worktree");
    });

  });
});
