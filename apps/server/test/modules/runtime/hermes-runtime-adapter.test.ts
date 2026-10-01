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
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { InMemorySecretStore } from "../../../src/platform/security/secret-store.js";
import {
  ProcessExecutor,
  ExitCodeError,
  type ProcessOptions,
  type ProcessResult,
} from "../../../src/platform/process/process-executor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../../src/platform/process/process-inspector.js";
import type { ProcessScopeLaunchRequest, ProcessScopeSupervisor } from "../../../src/platform/process/run-scope-supervisor.js";

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
  launchCalls = 0;
  payloadDispatches = 0;
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
    this.observations.set(owner.containmentId, { state: "LIVE", identity });
    await persistVerifiedIdentity(identity);
    await this.beforeProcessExecution?.(owner, request);
    if (request.signal?.aborted) {
      const stopped = await this.stop({ ...identity, state: "STOPPING" });
      if (stopped.state !== "STOPPED") throw new Error("TEST_PROCESS_SCOPE_STOP_UNPROVEN");
      throw new Error("PROCESS_SCOPE_LAUNCH_CANCELLED");
    }
    const env = { ...request.environment };
    if (request.secret !== undefined) env.EBB_HERMES_PROVIDER_API_KEY = request.secret;
    this.payloadDispatches += 1;
    const completion = this.executor.exec(request.executable, [...request.args], {
      cwd: request.cwd,
      env,
      timeout: request.timeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    }).catch((error: unknown) => {
      if (error instanceof ExitCodeError) {
        return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
      }
      throw error;
    }).finally(() => {
      this.observations.set(owner.containmentId, { state: "STOPPED", evidence: "TEST_SCOPE_EMPTY" });
    });
    return { completion };
  }

  async inspect(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    return this.observations.get(owner.containmentId) ?? { state: "STOPPED", evidence: "TEST_SCOPE_ABSENT" };
  }

  async stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    this.stopCalls.push(owner);
    const stopped: ProcessScopeObservation = { state: "STOPPED", evidence: "TEST_SCOPE_EMPTY" };
    this.observations.set(owner.containmentId, stopped);
    return stopped;
  }

  async waitForStopped(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    return this.inspect(owner);
  }
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
): HermesRuntimeAdapter {
  return new HermesRuntimeAdapter(executor, artifactStore, config, new MockProcessScopeSupervisor(executor));
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
        id: "isolated-home-run", role: "Developer", runtime: "hermes", model: "default",
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
        id: "unscoped-run", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED", sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      })).rejects.toThrow("PROCESS_SCOPE_SUPERVISOR_REQUIRED");
      expect(mockExecutor.getCalls()).toHaveLength(0);
    });

    it("resolves provider credentials per run without writing them to Hermes profile files", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-provider-bridge-"));
      const secrets = new InMemorySecretStore();
      const scopeSupervisor = new MockProcessScopeSupervisor(mockExecutor);
      await secrets.store("hermes-provider", "acceptance", "secret-value");
      adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        secretStore: secrets,
        provider: { baseUrl: "https://models.example.test/v1", secretName: "acceptance" },
      }, scopeSupervisor);
      mockExecutor.setNextResult({ exitCode: 0, stdout: "provider secret-value", stderr: "rejected secret-value" });
      const run = {
        id: "provider-bridge-run", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      await adapter.startRun(run);

      const call = mockExecutor.getCalls()[0];
      expect(call?.options?.env?.EBB_HERMES_PROVIDER_API_KEY).toBe("secret-value");
      const scopeRequest = scopeSupervisor.lastRequest;
      expect(scopeRequest).toBeDefined();
      if (!scopeRequest) throw new Error("Expected the fake process-scope supervisor to receive a launch request.");
      expect(scopeRequest.secret).toBe("secret-value");
      expect(scopeRequest.environment).not.toHaveProperty("EBB_HERMES_PROVIDER_API_KEY");
      expect(scopeRequest.args.join(" ")).not.toContain("secret-value");
      const profile = await fs.readFile(path.join(resultDirectory, "profiles", run.id, "config.yaml"), "utf8");
      expect(profile).toContain('provider: "custom:orchestrator-managed"');
      expect(profile).not.toContain("secret-value");
      const artifacts = mockArtifactStore.getArtifacts(run.id);
      expect(artifacts?.stdout).toBe("provider [REDACTED_PROVIDER_CREDENTIAL]");
      expect(artifacts?.stderr).toBe("rejected [REDACTED_PROVIDER_CREDENTIAL]");
      const runOutcome = await adapter.runResult(run.id);
      expect(runOutcome.output).not.toContain("secret-value");
      const promptPath = mockExecutor.getCalls()[0]?.args[2];
      expect(promptPath).toBeDefined();
      expect(await fs.readFile(promptPath!, "utf8")).not.toContain("secret-value");
      await fs.rm(path.dirname(promptPath!), { recursive: true, force: true });
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("does not dispatch Hermes when cancellation arrives before the first asynchronous preparation completes", async () => {
      const scopeSupervisor = new MockProcessScopeSupervisor(mockExecutor);
      adapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, scopeSupervisor);
      const run = {
        id: "cancel-before-launch-run", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
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
      const run = {
        id: "cancel-during-launch-run", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
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

    it("fails closed without spawning Hermes when the configured provider credential is absent", async () => {
      const secrets = new InMemorySecretStore();
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        secretStore: secrets,
        provider: { baseUrl: "https://models.example.test/v1", secretName: "missing" },
      });
      const run = {
        id: "provider-bridge-missing", role: "Developer", runtime: "hermes", model: "model-x",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };

      await expect(adapter.startRun(run)).rejects.toThrow("Hermes provider credentials are unavailable");
      expect(mockExecutor.getCalls()).toHaveLength(0);
    });

    it("uses the persisted capability workspace as the Hermes process cwd", async () => {
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
          executable_identity TEXT, state TEXT NOT NULL, stop_evidence TEXT, updated_at TEXT NOT NULL
        )
      `);
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
          id: "persisted-workspace-run",
          role: "Developer",
          runtime: "hermes",
          model: "default",
          status: "STARTED",
          task_id: "persisted-task",
          epic_id: null,
          capability_ref: "persisted-capability",
          capability_json: JSON.stringify({
            runId: "persisted-workspace-run",
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
      database.run(
        `INSERT INTO run_process_owners(
          run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,
          systemd_invocation_id,systemd_control_group,supervisor_pid,supervisor_start_identity,pid,platform,
          process_start_identity,executable_identity,state,stop_evidence,updated_at
        ) VALUES($runId,$sourceTag,$hermesHome,$kind,$containmentId,$launchNonce,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'PREPARED',NULL,$now)`,
        {
          runId: "persisted-workspace-run",
          sourceTag: "ebb-run:persisted-workspace-run",
          hermesHome: path.join(resultDirectory, "profiles", "persisted-workspace-run"),
          kind: process.platform === "win32" ? "windows-job" : "systemd-user-service",
          containmentId: "a".repeat(64),
          launchNonce: "b".repeat(64),
          now: new Date().toISOString(),
        },
      );
      const run = {
        id: "persisted-workspace-run", role: "Developer", runtime: "hermes", model: "default",
        taskId: "persisted-task", epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        capabilityRef: "persisted-capability",
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
        mockExecutor.setNextResult({ exitCode: 0, stdout: "session: persisted", stderr: "" });

        await adapter.startRun(run);

        expect(mockExecutor.getCalls()[0]?.options?.cwd).toBe(workspace);
        expect(scopeSupervisor.lastRequest?.args.slice(
          scopeSupervisor.lastRequest.args.indexOf("--source"),
          scopeSupervisor.lastRequest.args.indexOf("--source") + 2,
        )).toEqual(["--source", `ebb-run:${run.id}`]);
        expect(database.get<{ session_id: string | null }>(
          "SELECT session_id FROM agent_runs WHERE id=$id", { id: run.id },
        )?.session_id).toBeNull();
        expect(database.get<{ state: string; stop_evidence: string | null }>(
          "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
        )).toEqual({ state: "STOPPED", stop_evidence: "TEST_SCOPE_EMPTY" });

        const failedRun = { ...run, id: "owner-callback-failure-run", capabilityRef: "failed-capability" };
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
            process_start_identity,executable_identity,state,stop_evidence,updated_at
          ) VALUES($runId,$sourceTag,$hermesHome,$kind,$containmentId,$launchNonce,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'PREPARED',NULL,$now)`,
          {
            runId: failedRun.id,
            sourceTag: `ebb-run:${failedRun.id}`,
            hermesHome: path.join(resultDirectory, "profiles", failedRun.id),
            kind: process.platform === "win32" ? "windows-job" : "systemd-user-service",
            containmentId: "c".repeat(64),
            launchNonce: "d".repeat(64),
            now: new Date().toISOString(),
          },
        );
        database.exec(`CREATE TRIGGER reject_live_owner_identity BEFORE UPDATE OF state ON run_process_owners
          WHEN NEW.run_id='${failedRun.id}' AND NEW.state='LIVE'
          BEGIN SELECT RAISE(ABORT,'test identity persistence failure'); END;`);
        const failingSupervisor = new MockProcessScopeSupervisor(mockExecutor);
        const failingAdapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
          databasePath,
          resultDirectory,
          checkpointDirectory,
        }, failingSupervisor);
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
        await expect(failingSupervisor.inspect(stoppedScope)).resolves.toMatchObject({ state: "STOPPED", evidence: "TEST_SCOPE_EMPTY" });
        expect(failingSupervisor.payloadDispatches).toBe(0);
        expect(mockExecutor.getCalls()).toHaveLength(1);
        expect(database.get<{ state: string; stop_evidence: string | null }>(
          "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId: failedRun.id },
        )).toEqual({ state: "LAUNCHING", stop_evidence: null });

        database.exec("DROP TRIGGER reject_live_owner_identity");
        const stopPersistenceRun = { ...run, id: "stop-proof-persistence-failure-run", capabilityRef: "stop-proof-failure-capability" };
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
            process_start_identity,executable_identity,state,stop_evidence,updated_at
          ) VALUES($runId,$sourceTag,$hermesHome,$kind,$containmentId,$launchNonce,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'PREPARED',NULL,$now)`,
          {
            runId: stopPersistenceRun.id,
            sourceTag: `ebb-run:${stopPersistenceRun.id}`,
            hermesHome: path.join(resultDirectory, "profiles", stopPersistenceRun.id),
            kind: process.platform === "win32" ? "windows-job" : "systemd-user-service",
            containmentId: "e".repeat(64),
            launchNonce: "f".repeat(64),
            now: new Date().toISOString(),
          },
        );
        database.exec(`CREATE TRIGGER reject_stopped_owner BEFORE UPDATE OF state ON run_process_owners
          WHEN NEW.run_id='${stopPersistenceRun.id}' AND NEW.state='STOPPED'
          BEGIN SELECT RAISE(ABORT,'injected STOPPED evidence persistence failure'); END;`);
        const stopFailSupervisor = new MockProcessScopeSupervisor(mockExecutor);
        const stopFailAdapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
          databasePath,
          resultDirectory,
          checkpointDirectory,
        }, stopFailSupervisor);
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
        id: "missing-workspace-run", role: "Developer", runtime: "hermes", model: "default",
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

    it("wires the exact run result path into the authenticated MCP config", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-result-wiring-"));
      adapter = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        resultDirectory,
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      });
      const run = {
        id: "wired-run-id", role: "Developer", runtime: "hermes", model: "default",
        taskId: null, epicId: null, status: "STARTED" as const, sessionId: null, attempt: null,
        triggerReason: null, contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(),
        endedAt: null, exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      };
      await adapter.startRun(run);
      const config = await fs.readFile(path.join(resultDirectory, "profiles", run.id, "config.yaml"), "utf8");
      expect(config).toContain(`- ${JSON.stringify(path.join(resultDirectory, `${run.id}.json`))}`);
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("builds correct launch command for new run", async () => {
      const run = {
        id: "test-run-id",
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
      expect(args).toContain("--model");
      expect(args).toContain("claude-3-5-sonnet");
      expect(args).toContain("--toolsets");
      expect(args).toContain("mcp-orchestrator");
      expect(args).toContain("--in");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--source");
      const sourceIndex = args.indexOf("--source");
      expect(args.slice(sourceIndex, sourceIndex + 2)).toEqual(["--source", `ebb-run:${run.id}`]);
      expect(args).toContain("--max-turns");
    });

    it("writes prompt body to file and passes with --query-file", async () => {
      const run = {
        id: "test-run-id-2",
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

    it("never adds --worktree flag", async () => {
      const run = {
        id: "test-run-id-3",
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
        id: "test-run-id-4",
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
        id: "test-run-id-5",
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
        id: "test-run-id-6",
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
    it("does not enable production resume before Task 5C", async () => {
      const productionAdapter = new HermesRuntimeAdapter(mockExecutor, mockArtifactStore, {
        databasePath: path.join(os.tmpdir(), "task5a-resume-disabled.sqlite"),
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
      }, new MockProcessScopeSupervisor(mockExecutor));
      await expect(productionAdapter.resumeRun("existing-run", { sessionId: "late-session-id", attempt: 1 }))
        .rejects.toThrow("HERMES_RESUME_REQUIRES_TASK_5C");
      expect(mockExecutor.getCalls()).toHaveLength(0);
    });

    it("updates run state with session info", async () => {
    // Сначала запускаем выполнение.
      const startRun = {
        id: "resume-run-id",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-resume",
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

    // Теперь возобновляем выполнение.
      mockExecutor.setNextResult({ exitCode: 0, stdout: "resumed", stderr: "" });
      await adapter.resumeRun(startRun.id, { sessionId: "existing-session-456", attempt: 1 });

       const state = await adapter.inspectRun(startRun.id);
      expect(state.sessionId).toBe("existing-session-456");
      expect(state.attempt).toBe(1);
      expect(state.status).toBe("IN_PROGRESS");
    });

    it("sets status to IN_PROGRESS on resume", async () => {
      const startRun = {
        id: "resume-run-id-2",
        role: "Developer",
        runtime: "hermes",
        model: "claude-3",
        taskId: "task-resume-2",
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

      mockExecutor.setNextResult({ exitCode: 0, stdout: "resumed", stderr: "" });
      await adapter.resumeRun(startRun.id, { sessionId: "existing-session-789", attempt: 2 });

       const state = await adapter.inspectRun(startRun.id);
      expect(state.status).toBe("IN_PROGRESS");
    });
  });

  describe("cancelRun", () => {
    it("sends graceful signal first", async () => {
    // Сначала запускаем выполнение.
      const startRun = {
        id: "cancel-run-id",
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
    it("returns AGENT_OUTPUT_MISSING when process exits without valid submitted result", async () => {
    // Сначала запускаем выполнение.
      const startRun = {
        id: "missing-result-run",
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

    it("does not consume another run's exact result file and returns diagnostics", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-results-"));
      await fs.writeFile(path.join(resultDirectory, "other-run.json"), JSON.stringify({ version: "1.0", outcome: "COMPLETED" }));
      const run = {
        id: "exact-run", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-exact",
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
        exitCode: 7,
        artifactReferences: [path.join(resultDirectory, "exact-run.json"), `run-artifacts://${run.id}`],
      });
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("re-reads and validates the exact run result at collection time", async () => {
      const resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-results-recheck-"));
      const run = {
        id: "recheck-run", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-recheck",
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
      await fs.writeFile(path.join(resultDirectory, `${run.id}.json`), JSON.stringify({ version: "1", outcome: "COMPLETED" }));
      expect((await exactAdapter.collectResult(run.id)).validatedSubmission).toBe(true);
      await fs.writeFile(path.join(resultDirectory, `${run.id}.json`), JSON.stringify({ version: "1", outcome: "INVALID" }));
      const invalid = await exactAdapter.collectResult(run.id);
      expect(invalid.validatedSubmission).toBe(false);
      expect(invalid.output).toBe("AGENT_OUTPUT_MISSING");
      await fs.rm(resultDirectory, { recursive: true, force: true });
    });

    it("rejects forbidden credentials in supplied runtime overlays", async () => {
      const restricted = createTestRuntimeAdapter(mockExecutor, mockArtifactStore, {
        managedWorktree: path.join(os.tmpdir(), "hermes-test-workspace"),
        checkpointDirectory: sharedCheckpointDirectory,
        environment: { GITHUB_TOKEN: "secret" },
      });
      await expect(restricted.startRun({
        id: "credential-run", role: "Developer", runtime: "hermes", model: "claude-3", taskId: "task-credential",
        epicId: null, status: "STARTED" as const, sessionId: null, attempt: null, triggerReason: null,
        contextVersion: "v1", outputSchemaVersion: "v1", startedAt: new Date(), endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
      })).rejects.toThrow("Forbidden credential");
    });
  });

  describe("inspectRun", () => {
    it("returns current state of a run", async () => {
      const run = {
        id: "inspect-run-id",
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
        model: "claude-3-5-sonnet",
        toolsets: ["mcp-orchestrator"],
        worktree: "/managed/worktree",
        ignoreRules: true,
        source: "tool",
        maxTurns: 20,
      });

      expect(args).toContain("chat");
      expect(args).toContain("--query-file");
      expect(args).toContain("/tmp/prompt.txt");
      expect(args).toContain("--model");
      expect(args).toContain("claude-3-5-sonnet");
      expect(args).toContain("--toolsets");
      expect(args).toContain("mcp-orchestrator");
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
        toolsets: ["mcp-orchestrator"],
        worktree: "/managed/worktree",
        ignoreRules: true,
        source: "tool",
        maxTurns: 20,
      });

      expect(args).toContain("chat");
      expect(args).toContain("--resume");
      expect(args).toContain("resume-123");
      expect(args).toContain("--in");
      expect(args).toContain("/managed/worktree");
    });
  });
});
