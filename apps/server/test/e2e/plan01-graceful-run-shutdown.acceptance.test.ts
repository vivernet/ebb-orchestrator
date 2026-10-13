import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import { effectiveRunToolIds, RunService } from "../../src/modules/runtime/run-service.js";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { digestRunPromptBytesV1 } from "../../src/modules/context/context-provenance.js";
import type { PreparedRunContext } from "../../src/modules/context/context-types.js";
import { transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { shutdownSystem, StatusTracker, type BackgroundWorker } from "../../src/platform/process/system-lifecycle.js";
import { loadTestMigrations } from "../helpers/migrations.js";

const migrations = loadTestMigrations();
const enabled = process.platform === "win32" || process.platform === "linux";

describe.skipIf(!enabled)("Plan 01 graceful shutdown with an active Run scope", () => {
  let root: string | undefined;
  let database: ReturnType<typeof createSqliteDatabase> | undefined;

  afterEach(async () => {
    database?.close();
    database = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("stops a live Run scope before database close and lock release", async () => {
    const fixture = await createFixture();
    const { db, runService, runtime, runId, steps } = fixture;
    expect(runtime.scope.live).toBe(true);

    const worker: BackgroundWorker = {
      start: async () => {},
      stop: async () => { steps.push("workers"); },
    };
    const lock = { release: async () => { steps.push("lock release"); } };
    let ownerAtClose: { state: string; stop_evidence: string | null } | undefined;
    let runAtClose: { status: string } | undefined;

    await shutdownSystem({
      status: new StatusTracker(),
      stopIngress: async () => { steps.push("ingress"); },
      workers: [worker],
      stopRuntimeScopes: () => runService.stopActiveRuntimeScopes(),
      database: { open: async () => {}, close: () => {
        ownerAtClose = db.get("SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId });
        runAtClose = db.get("SELECT status FROM agent_runs WHERE id=$runId", { runId });
        steps.push("database close");
        db.close();
        database = undefined;
      } },
      instanceLock: lock,
    });

    expect(steps).toEqual(["ingress", "workers", "scope stopped", "STOPPED proof", "database close", "lock release"]);
    expect(runtime.scope.live).toBe(false);
    expect(ownerAtClose).toMatchObject({ state: "STOPPED", stop_evidence: enabledStopEvidence() });
    expect(runAtClose).toEqual({ status: "IN_PROGRESS" });
  });

  it("keeps the database and lock open when the active scope stop proof is unknown", async () => {
    const fixture = await createFixture({ stopMode: "unknown" });
    const { db, runService, runtime, steps } = fixture;
    const closed = { value: false };
    const released = { value: false };

    await expect(shutdownSystem({
      status: new StatusTracker(),
      stopIngress: async () => { steps.push("ingress"); },
      workers: [{ start: async () => {}, stop: async () => { steps.push("workers"); } }],
      stopRuntimeScopes: () => runService.stopActiveRuntimeScopes(),
      database: { open: async () => {}, close: () => { closed.value = true; steps.push("database close"); } },
      instanceLock: { release: async () => { released.value = true; steps.push("lock release"); } },
    })).rejects.toThrow("RUN_PROCESS_SCOPE_STOP_UNPROVEN");

    expect(runtime.scope.live).toBe(false);
    expect(steps).toEqual(["ingress", "workers", "scope stopped", "UNKNOWN observation"]);
    expect(closed.value).toBe(false);
    expect(released.value).toBe(false);
    expect(db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: fixture.runId }))
      .toEqual({ status: "IN_PROGRESS" });
  });

  it("keeps the database and lock open when live scope stop exceeds the shutdown deadline", async () => {
    const fixture = await createFixture({ stopMode: "blocked" });
    const { db, runService, runtime, steps } = fixture;
    const closed = { value: false };
    const released = { value: false };
    const shutdown = shutdownSystem({
      status: new StatusTracker(),
      stopIngress: async () => { steps.push("ingress"); },
      workers: [{ start: async () => {}, stop: async () => { steps.push("workers"); } }],
      stopRuntimeScopes: () => runService.stopActiveRuntimeScopes(),
      database: { open: async () => {}, close: () => { closed.value = true; } },
      instanceLock: { release: async () => { released.value = true; } },
      timeoutMs: 20,
    });
    const result = await shutdown.then(() => undefined, (error: unknown) => error);

    expect(result).toMatchObject({ message: "SHUTDOWN_RUNTIME_STOP_TIMEOUT" });
    expect(runtime.scope.live).toBe(true);
    expect(closed.value).toBe(false);
    expect(released.value).toBe(false);
    expect(db.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId: fixture.runId }))
      .toEqual({ state: "LIVE" });

    runtime.scope.allowStop();
    await runtime.scope.stopFinished;
    expect(runtime.scope.live).toBe(false);
    expect(closed.value).toBe(false);
    expect(released.value).toBe(false);
  });

  async function createFixture(options: { stopMode?: "proof" | "unknown" | "blocked" } = {}) {
    root = await mkdtemp(join(tmpdir(), "ebb-plan01-shutdown-"));
    const db = createSqliteDatabase(join(root, "orchestrator.db"));
    database = db;
    runMigrations(db, migrations);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'shutdown','Shutdown','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'TASK-SHUTDOWN','Shutdown scope','READY','{}',1,$now,$now)", { id: taskId, projectId, now });
    const steps: string[] = [];
    const runtime = new ControlledScopeRuntime(db, steps, options.stopMode ?? "proof");
    const runService = new RunService(db, runtime, {
      prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
    });
    const prompt = "Provider-free graceful shutdown acceptance fixture";
    const run = runService.prepareRun({
      runId,
      model: "default",
      epicId: null,
      taskId,
      role: "developer",
      triggerReason: "task-assignment",
      contextVersion: "1",
      outputSchemaVersion: "1",
      contextInput: {
        prompt,
        subject: { type: "TASK", id: taskId },
        role: "developer",
        roleInputs: {},
        versions: { roleVersion: null, runtime: "default", runtimeVersion: null, model: "default", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1" },
        execution: {
          workspaceIdentity: { repository: "fixture", workspace: "fixture", worktree: "fixture" },
          targetHead: null,
          targetBranch: null,
          effectiveCapabilityIds: effectiveRunToolIds("developer"),
          policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
        },
      },
    });
    if (run.id !== runId) throw new Error("RunService did not preserve the fixture Run ID");
    db.transaction((tx) => {
      tx.run("UPDATE agent_runs SET status='IN_PROGRESS' WHERE id=$runId", { runId });
      const owner = tx.get<{ containment_kind: string }>("SELECT containment_kind FROM run_process_owners WHERE run_id=$runId", { runId });
      if (!owner) throw new Error("RunService did not persist a process owner");
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, {
        runId,
        expectedState: "LAUNCHING",
        nextState: "LIVE",
        identity: process.platform === "win32"
          ? { platform: "win32", supervisorPid: 1, supervisorStartIdentity: "fixture-supervisor", pid: 2, processStartIdentity: "fixture-process", executableIdentity: "fixture-runtime" }
          : { platform: "linux", systemdInvocationId: "fixture-invocation", systemdControlGroup: "/user.slice/fixture.scope", pid: 2 },
      });
    });
    runtime.scope.live = true;
    return { db, runService, runtime, runId, steps };
  }
});

class ControlledScopeRuntime implements AgentRuntime {
  active = 1;
  maxActive = 1;
  readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  readonly scope = {
    live: false,
    allowStop: () => {},
    stopFinished: Promise.resolve(),
  };
  private resolveStop: (() => void) | undefined;
  private resolveStopFinished: (() => void) | undefined;

  constructor(
    private readonly db: ReturnType<typeof createSqliteDatabase>,
    private readonly steps: string[],
    private readonly stopMode: "proof" | "unknown" | "blocked",
  ) {
    this.scope.stopFinished = new Promise<void>((resolve) => { this.resolveStopFinished = resolve; });
  }

  async startRun(_run: AgentRun): Promise<void> {}
  async resumeRun(_runId: string, _options: { sessionId: string; attempt: number }): Promise<void> {}
  async inspectRun(_runId: string): Promise<AgentRun> { throw new Error("fixture does not inspect Runs"); }
  async collectResult(_runId: string): Promise<RunOutcome> { throw new Error("fixture has no provider result"); }
  async collectUsage(_runId: string) { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: null }; }
  async runResult(_runId: string): Promise<RunOutcome> { throw new Error("fixture has no provider result"); }
  async healthCheck(): Promise<boolean> { return true; }

  async cancelRun(runId: string): Promise<void> {
    if (!this.scope.live) throw new Error("fixture scope was not live");
    if (this.stopMode === "blocked") {
      await new Promise<void>((resolve) => {
        this.resolveStop = resolve;
        this.scope.allowStop = resolve;
      });
    }
    this.scope.live = false;
    this.steps.push("scope stopped");
    if (this.stopMode === "unknown") {
      this.db.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId, expectedState: "LIVE", nextState: "UNKNOWN", evidence: "FIXTURE_STOP_UNPROVEN",
      }));
      this.steps.push("UNKNOWN observation");
      this.resolveStopFinished?.();
      return;
    }
    this.db.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "LIVE", nextState: "STOPPING" });
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "STOPPING", nextState: "STOPPED", evidence: enabledStopEvidence() });
    });
    this.steps.push("STOPPED proof");
    this.resolveStopFinished?.();
  }
}

function enabledStopEvidence(): "WINDOWS_JOB_EMPTY" | "SYSTEMD_CGROUP_EMPTY" {
  return process.platform === "win32" ? "WINDOWS_JOB_EMPTY" : "SYSTEMD_CGROUP_EMPTY";
}

function preparedContext(prompt: string, role: string, subject: PreparedRunContext["subject"]): PreparedRunContext {
  return {
    finalPrompt: prompt,
    subject,
    role: role as PreparedRunContext["role"],
    contractDigest: null,
    items: [],
    contextBuilderVersion: "1.0.0",
    promptHash: digestRunPromptBytesV1(new TextEncoder().encode(prompt)),
    contextHash: "b".repeat(64),
    initialTokenSize: null,
    workspaceFingerprint: "c".repeat(64),
  };
}
