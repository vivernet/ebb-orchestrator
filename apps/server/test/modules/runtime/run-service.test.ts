import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { REDACTED_PLACEHOLDER } from "../../../src/platform/security/redact.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { createRunContextInput, effectiveRunToolIds, RunService } from "../../../src/modules/runtime/run-service.js";
import { FakeAgentRuntime } from "../../fakes/fake-agent-runtime.js";
import type { RunOutcome, StartRunOptions } from "../../../src/modules/runtime/run-types.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { createHermesManagedSelectionFixture } from "../../helpers/hermes-managed-selection-fixture.js";
import { digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import type { PreparedRunContext } from "../../../src/modules/context/context-types.js";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import { containmentKindForPlatform, getRunProcessOwner, isAuthoritativeRunProcessStopEvidence, rotateRunProcessOwnerForResumeTx,
  syncCurrentRunProcessGenerationTx, transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";
import { captureWorkspaceSnapshotV1, createResumeContextBaselineV1, digestResumeBindingV1 } from "../../../src/modules/context/resume-eligibility.js";
import { seedApprovedProjectConfig } from "../../helpers/approved-project-config.js";
import { ownerIdentityForContainmentKind, stopEvidenceForContainmentKind } from "../../helpers/run-process-owner-fixture.js";
import { McpServer } from "../../../src/modules/execution/mcp/mcp-server.js";
import { loadValidatedCapability } from "../../../src/modules/execution/capability-validation.js";
import type { RunCapability } from "../../../src/modules/execution/run-capability.js";
import { AgentEventBus, type AgentEvent, type AgentEventSink } from "../../../src/modules/runtime/agent-events.js";
import { createProductionComposition } from "../../../src/platform/home/production-composition.js";
import { resolveOrchestratorHome } from "../../../src/platform/home/orchestrator-home.js";
import type { Platform } from "../../../src/platform/config/app-config.js";
import type { ITracingStore } from "../../../src/modules/runtime/tracing/tracing-store.js";

const fixtureRuntimeIdentity = "fixture-installed-hermes";

const migrations = loadTestMigrations();

describe("RunService with FakeAgentRuntime", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let runService: RunService;
  let fakeRuntime: FakeAgentRuntime;

  const _projectId = randomUUID();
  const epicId = randomUUID();
  const taskId = randomUUID();

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-runtime-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setup(): Promise<void> {
    db = await setupDb();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'runtime','Runtime','ACTIVE',$now,$now)", { id: _projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'TASK-RUN','Runtime task','READY','{}',1,$now,$now)", { id: taskId, projectId: _projectId, now });
    fakeRuntime = new FakeAgentRuntime();
    runService = new RunService(db, fakeRuntime, {
      prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
    });
    fakeRuntime.cancelRun = async (runId) => {
      const owner = db!.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId });
      if (owner?.state === "PREPARED") {
        db!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
          runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
        }));
      }
    };
  }

  function preparedContext(
    finalPrompt: string,
    role = "developer",
    subject: PreparedRunContext["subject"] = { type: "TASK", id: taskId },
  ): PreparedRunContext {
    return {
      finalPrompt,
      subject,
      role: role as PreparedRunContext["role"],
      contractDigest: null,
      items: [],
      contextBuilderVersion: "1.0.0",
      promptHash: digestRunPromptBytesV1(new TextEncoder().encode(finalPrompt)),
      contextHash: "b".repeat(64),
      initialTokenSize: null,
      workspaceFingerprint: "c".repeat(64),
    };
  }

  function testContextInput(options: { taskId: string | null; epicId: string | null; role: string; requestId?: string; prompt?: string; allowedTools?: import("../../../src/modules/execution/run-capability.js").ToolId[] }) {
    const subject = options.taskId !== null ? { type: "TASK" as const, id: options.taskId }
      : options.epicId !== null ? { type: "EPIC" as const, id: options.epicId }
        : { type: "REQUEST" as const, id: options.requestId ?? "request-test" };
    return {
      prompt: options.prompt ?? "test caller prompt",
      subject,
      role: options.role.toLowerCase() as PreparedRunContext["role"],
      roleInputs: {},
      versions: { roleVersion: null, runtime: "default", runtimeVersion: null, model: "test", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1" },
      execution: {
        workspaceIdentity: { repository: "test-repository", workspace: "test-worktree", worktree: "test-worktree" },
        targetHead: null, targetBranch: null, effectiveCapabilityIds: effectiveRunToolIds(options.role, options.allowedTools, subject.type === "REQUEST"),
        policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
      },
    };
  }

  function withTestContext(options: StartRunOptions): StartRunOptions {
    return {
      ...options,
      contextInput: options.contextInput ?? testContextInput({
        taskId: options.taskId,
        epicId: options.epicId,
        role: options.role,
        ...("requestId" in options && options.requestId ? { requestId: options.requestId } : {}),
        ...(options.capability?.allowedTools ? { allowedTools: options.capability.allowedTools } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
      }),
    } as StartRunOptions;
  }

  function startRun(options: StartRunOptions) {
    return runService.startRun(withTestContext(options));
  }

  function prepareRun(options: StartRunOptions) {
    return runService.prepareRun(withTestContext(options));
  }

  function markFakeRunNeverLaunched(runId: string): void {
    db!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
    }));
  }

  it.each([[123, 45, 10], [0, 0, 0]])("persists exact token counts %i/%i while keeping unavailable runtime cost NULL", async (inputTokens, outputTokens, cachedInputTokens) => {
    await setup();
    const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    await runService.collectUsage(run.id, { inputTokens, cachedInputTokens, outputTokens, cost: null });
    expect(db!.get("SELECT input_tokens,cached_input_tokens,output_tokens,cost FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ input_tokens: inputTokens, cached_input_tokens: cachedInputTokens, output_tokens: outputTokens, cost: null });
  });

  it("normalizes absent Developer and Coordinator role inputs to the assembler's empty object", () => {
    const snapshot = {
      prompt: "exact caller prompt",
      workspaceIdentity: { repository: "project-repository", workspace: "managed-worktree", worktree: "task-1" },
      targetHead: null,
      targetBranch: null,
    };
    const developer = createRunContextInput({
      role: "developer", model: "persisted", taskId: "task-1", epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
    }, snapshot);
    const coordinator = createRunContextInput({
      role: "coordinator", model: "persisted", taskId: null, requestId: "request-1", projectId: "project-1", epicId: null,
      triggerReason: "planning-request", contextVersion: "1", outputSchemaVersion: "1",
    }, snapshot);

    expect(developer.roleInputs).toEqual({});
    expect(coordinator.roleInputs).toEqual({});
  });

  it("stops only durable active runtime scopes and leaves Run state for startup recovery", async () => {
    await setup();
    const active = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    const completing = prepareRun({ role: "reviewer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    const terminal = prepareRun({ role: "qa", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    db!.run("UPDATE agent_runs SET status='IN_PROGRESS' WHERE id=$id", { id: active.id });
    db!.run("UPDATE agent_runs SET status='COMPLETING' WHERE id=$id", { id: completing.id });
    db!.run("UPDATE agent_runs SET status='FAILED' WHERE id=$id", { id: terminal.id });
    const stop = vi.fn(fakeRuntime.cancelRun.bind(fakeRuntime));
    fakeRuntime.cancelRun = stop;

    await runService.stopActiveRuntimeScopes();

    expect(stop.mock.calls.map(([id]) => id)).toEqual([active.id, completing.id].sort());
    expect(db!.all<{ id: string; status: string }>(
      "SELECT id,status FROM agent_runs WHERE id IN ($active,$completing,$terminal) ORDER BY id",
      { active: active.id, completing: completing.id, terminal: terminal.id },
    )).toEqual(expect.arrayContaining([
      { id: active.id, status: "IN_PROGRESS" },
      { id: completing.id, status: "COMPLETING" },
      { id: terminal.id, status: "FAILED" },
    ]));
    expect(db!.all<{ run_id: string; state: string; stop_evidence: string | null }>(
      "SELECT run_id,state,stop_evidence FROM run_process_owners WHERE run_id IN ($active,$completing) ORDER BY run_id",
      { active: active.id, completing: completing.id },
    )).toEqual(expect.arrayContaining([
      { run_id: active.id, state: "STOPPED", stop_evidence: "NEVER_LAUNCHED" },
      { run_id: completing.id, state: "STOPPED", stop_evidence: "NEVER_LAUNCHED" },
    ]));
  });

  it("persists the shared Hermes root without inventing provider selection", async () => {
    await setup();
    const runId = randomUUID();
    const hermesHome = join(tmpDir, "configured-hermes");
    let seenPolicy: unknown;
    Object.assign(fakeRuntime, {
      prepareHermesRunSelection: async (id: string) => ({
        selection: { mode: "HERMES_MANAGED", runId: id, hermesHome, runtimeIdentity: fixtureRuntimeIdentity },
      }),
    });
    runService = new RunService(db!, fakeRuntime, {
      prepare: (_tx, input) => { seenPolicy = input.execution.policyIdentity; return preparedContext(input.prompt, input.role, input.subject); },
    });
    const run = await runService.prepareRunWithHermesPreflight(withTestContext({
      runId, role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
    }));
    expect(run.model).toBe("default");
    expect(db!.get("SELECT hermes_home,hermes_source_snapshot_key FROM run_process_owners WHERE run_id=$runId", { runId }))
      .toEqual({ hermes_home: hermesHome, hermes_source_snapshot_key: null });
    expect(seenPolicy).toMatchObject({ providerId: null, providerPolicyId: null, runtimeId: "default" });
    await expect(fakeRuntime.inspectRun(run.id)).rejects.toThrow();
  });

  it("accepts the default model for a managed Hermes run and persists it", async () => {
    await setup();
    const runId = randomUUID();
    Object.assign(fakeRuntime, {
      prepareHermesRunSelection: async (id: string) => ({
        selection: { mode: "HERMES_MANAGED", runId: id, hermesHome: join(tmpDir, "configured-hermes"), runtimeIdentity: fixtureRuntimeIdentity },
      }),
    });
    const run = await runService.prepareRunWithHermesPreflight(withTestContext({
      runId, role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
    }));
    expect(run.model).toBe("default");
    expect(db!.get("SELECT id FROM agent_runs WHERE id=$runId", { runId })).toBeDefined();
  });

  it("validateTaskRequestModel passes default without registry validation", async () => {
    await setup();
    expect(() => runService.validateTaskRequestModel("default")).not.toThrow();
  });

  it("validateTaskRequestModel accepts a known built-in model", async () => {
    await setup();
    expect(() => runService.validateTaskRequestModel("gpt-4o")).not.toThrow();
  });

  it("validateTaskRequestModel rejects an unknown model", async () => {
    await setup();
    expect(() => runService.validateTaskRequestModel("nonexistent-model")).toThrow("RUN_REQUEST_MODEL_UNSUPPORTED");
  });

  it("persists the configured Hermes root before execution", async () => {
    await setup();
    const runId = randomUUID();
    let seenPolicy: unknown;
    Object.assign(fakeRuntime, {
      prepareHermesRunSelection: async (id: string) => ({
        selection: createHermesManagedSelectionFixture(id, fixtureRuntimeIdentity, join(tmpDir, "configured-hermes")),
      }),
    });
    runService = new RunService(db!, fakeRuntime, {
      prepare: (_tx, input) => {
        seenPolicy = input.execution.policyIdentity;
        return preparedContext(input.prompt, input.role, input.subject);
      },
    });
    const options = withTestContext({
      runId, role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
      prompt: "caller prompt", capability: { workspace: "test-worktree" },
    });

    const run = await runService.prepareRunWithHermesPreflight(options);
    const owner = db!.get<{ hermes_home: string; hermes_source_snapshot_key: string | null }>("SELECT hermes_home,hermes_source_snapshot_key FROM run_process_owners WHERE run_id=$runId", { runId });

    expect(run.model).toBe("default");
    expect(owner?.hermes_home).toBe(join(tmpDir, "configured-hermes"));
    expect(owner?.hermes_source_snapshot_key).toBeNull();
    expect(seenPolicy).toEqual({
      providerId: null,
      providerPolicyId: null,
      runtimeId: "default",
      runtimePolicyId: null,
    });
  });

  it("publishes the selection for execution only after the PREPARED owner is durable", async () => {
    await setup();
    const runId = randomUUID();
    const selection = createHermesManagedSelectionFixture(runId, fixtureRuntimeIdentity, join(tmpDir, "configured-hermes"));
    Object.assign(fakeRuntime, {
      prepareHermesRunSelection: async () => ({ selection }),
    });
    runService = new RunService(db!, fakeRuntime, {
      prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
    });
    const preflight = await runService.beginHermesRunPreflight(withTestContext({
      runId, role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
      prompt: "caller prompt", capability: { workspace: "test-worktree" },
    }));
    const run = runService.prepareRun(preflight.options);
    expect(preflight.isCommitted()).toBe(false);
    expect(fakeRuntime.startCalls).toEqual([]);
    expect(db!.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId })?.state).toBe("PREPARED");
    expect(db!.get("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId })).toEqual({ run_id: runId });
    await preflight.commit();
    expect(preflight.isCommitted()).toBe(true);
    vi.spyOn(fakeRuntime, "collectResult").mockRejectedValue(new Error("CONTROLLED_RESULT_FAILURE"));
    await expect(runService.executePreparedRun(run.id)).rejects.toThrow("CONTROLLED_RESULT_FAILURE");
    expect(fakeRuntime.startCalls).toMatchObject([{ id: runId, hermesSelection: selection }]);
  });

  it("rolls back Run, context manifest, and process owner when runtime selection is incomplete", async () => {
    await setup();
    const runId = randomUUID();
    Object.assign(fakeRuntime, {
      prepareHermesRunSelection: async (id: string) => ({
        selection: createHermesManagedSelectionFixture(id, "", join(tmpDir, "configured-hermes")),
      }),
    });
    runService = new RunService(db!, fakeRuntime, {
      prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
    });

    await expect(runService.prepareRunWithHermesPreflight(withTestContext({
      runId, role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
      prompt: "caller prompt", capability: { workspace: "test-worktree" },
    }))).rejects.toThrow("HERMES_RUN_SELECTION_BINDING_MISMATCH");

    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
  });

  it("discards the pending selection when the Run/manifest transaction rolls back", async () => {
    await setup();
    const runId = randomUUID();
    Object.assign(fakeRuntime, {
      prepareHermesRunSelection: async (id: string) => ({
        selection: createHermesManagedSelectionFixture(id, fixtureRuntimeIdentity, join(tmpDir, "configured-hermes")),
      }),
    });
    runService = new RunService(db!, fakeRuntime, {
      prepare: () => { throw new Error("ASSEMBLY_FAILED"); },
    });

    const options = withTestContext({
      runId, role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
      prompt: "caller prompt", capability: { workspace: "test-worktree" },
    });
    await expect(runService.prepareRunWithHermesPreflight(options)).rejects.toThrow("ASSEMBLY_FAILED");

    expect(() => runService.prepareRun(options)).toThrow("HERMES_RUN_PREFLIGHT_REQUIRED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
  });

  it("rejects a Hermes producer that returns without committing its durable Run", async () => {
    await setup();
    const runId = randomUUID();
    Object.assign(fakeRuntime, {
      prepareHermesRunSelection: async (id: string) => ({
        selection: createHermesManagedSelectionFixture(id, fixtureRuntimeIdentity, join(tmpDir, "configured-hermes")),
      }),
    });

    await expect(runService.withHermesRunPreflight({
      runId, role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
      prompt: "caller prompt", capability: { workspace: "test-worktree" },
    }, () => "producer forgot the durable transaction"))
      .rejects.toThrow("HERMES_RUN_PREFLIGHT_NOT_COMMITTED");

    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
  });

  it("persists the exact prepared prompt, one manifest, and one PREPARED owner before execution", async () => {
    await setup();
    const finalPrompt = "caller bytes\n\n=== EBB ORCHESTRATOR VALIDATED CONTEXT V1 ===\n{}\n";
    const prepared = preparedContext(finalPrompt);
    const options = {
      role: "developer", model: "gpt-4", taskId, epicId: null, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1", prompt: finalPrompt,
      contextInput: testContextInput({ taskId, epicId: null, role: "developer", prompt: finalPrompt }),
    };

    const run = db!.transaction((tx) => runService.prepareRunInTransaction(tx, options, prepared));

    expect(db!.get<{ prompt: string }>("SELECT prompt FROM agent_runs WHERE id=$id", { id: run.id })?.prompt).toBe(finalPrompt);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests WHERE run_id=$id", { id: run.id })?.count).toBe(1);
    expect(db!.get<{ source_tag: string; hermes_home: string; containment_kind: string; containment_id: string; launch_nonce: string; state: string }>(
      "SELECT source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state FROM run_process_owners WHERE run_id=$id", { id: run.id },
    )).toMatchObject({ source_tag: `ebb-run:${run.id}`, state: "PREPARED" });
    expect(db!.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$id", { id: run.id })?.state).toBe("PREPARED");
    expect(fakeRuntime.startCalls).toHaveLength(0);
  });

  it("rolls back the Run when prepared provenance is invalid", async () => {
    await setup();
    const prepared = { ...preparedContext("final prompt"), promptHash: "f".repeat(64) };
    const options = {
      role: "developer", model: "gpt-4", taskId, epicId: null, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1", prompt: prepared.finalPrompt,
      contextInput: testContextInput({ taskId, epicId: null, role: "developer", prompt: prepared.finalPrompt }),
    };

    expect(() => db!.transaction((tx) => runService.prepareRunInTransaction(tx, options, prepared))).toThrow(/PREPARED_CONTEXT/);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
    expect(fakeRuntime.startCalls).toHaveLength(0);
  });

  it.each([
    ["manifest", "CREATE TRIGGER reject_manifest BEFORE INSERT ON context_manifests BEGIN SELECT RAISE(ABORT, 'injected manifest failure'); END"],
    ["owner", "CREATE TRIGGER reject_owner BEFORE INSERT ON run_process_owners BEGIN SELECT RAISE(ABORT, 'injected owner failure'); END"],
  ])("rolls back Run and provenance when %s persistence fails", async (_kind, triggerSql) => {
    await setup();
    db!.run(triggerSql);
    const options = withTestContext({
      role: "developer", model: "gpt-4", taskId, epicId: null, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir },
    });

    expect(() => runService.prepareRun(options)).toThrow(/injected (manifest|owner) failure/);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
    expect(fakeRuntime.startCalls).toHaveLength(0);
  });

  it("does not start Hermes when durable manifest or owner is missing", async () => {
    await setup();
    const run = prepareRun({
      role: "developer", model: "gpt-4", taskId, epicId: null, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir },
    });
    db!.run("DELETE FROM context_manifests WHERE run_id=$id", { id: run.id });

    await expect(runService.executePreparedRun(run.id)).rejects.toThrow("RUN_CONTEXT_MANIFEST_UNAVAILABLE");
    expect(fakeRuntime.startCalls).toHaveLength(0);
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })?.status).toBe("FAILED");
  });

  it("starts a run and records it in the database", async () => {
    await setup();
    const run = await startRun({
      role: "developer",
      model: "gpt-4",
      taskId,
      epicId,
      triggerReason: "task-assignment",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    expect(run.status).toBe("STARTED");
    expect(run.role).toBe("developer");
    expect(run.model).toBe("gpt-4");
    expect(run.taskId).toBe(taskId);
    expect(run.epicId).toBe(epicId);
    expect(run.startedAt).toBeDefined();
    expect(run.capabilityRef).toEqual(expect.any(String));
    const stored = db!.get<{ capability_json: string; capability_ref: string }>(
      "SELECT capability_json, capability_ref FROM agent_runs WHERE id = $id", { id: run.id });
    expect(stored?.capability_ref).toBe(run.capabilityRef);
    expect(JSON.parse(stored!.capability_json)).toMatchObject({ runId: run.id, capabilityRef: run.capabilityRef });
  });

  it("derives capability tools from the role contract", async () => {
    await setup();
    const run = await startRun({
      role: "reviewer", model: "gpt-4", taskId, epicId, triggerReason: "review-request",
      contextVersion: "1", outputSchemaVersion: "1",
      capability: {
        workspace: tmpDir,
        allowedTools: ["workspace.patch", "git.commit", "git.diff", "submit_result"],
      },
    });
    const capability = JSON.parse(db!.get<{ capability_json: string }>(
      "SELECT capability_json FROM agent_runs WHERE id = $id", { id: run.id })!.capability_json);
    expect(capability.allowedTools).toEqual(["git.diff", "submit_result"]);
    expect(capability.allowedTools).not.toContain("workspace.patch");
    expect(capability.allowedTools).not.toContain("git.commit");

    const integration = await startRun({
      role: "integration", model: "gpt-4", taskId, epicId, triggerReason: "integration",
      contextVersion: "1", outputSchemaVersion: "1",
      capability: {
        workspace: tmpDir,
        allowedTools: ["workspace.patch", "git.commit", "git.diff", "project.test", "submit_result"],
      },
    });
    const integrationCapability = JSON.parse(db!.get<{ capability_json: string }>(
      "SELECT capability_json FROM agent_runs WHERE id = $id", { id: integration.id })!.capability_json);
    expect(integrationCapability.allowedTools).toEqual(["git.diff", "project.test", "submit_result"]);
  });

  it("atomically accepts one authenticated completion for the exact run", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir, allowedTools: ["submit_result"] },
    });
    const store = runService.completionStore();
    const output = { version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" };
    await expect(store.accept(run.capabilityRef!, { runId: run.id, role: run.role, output })).resolves.toBe(true);
    await expect(store.accept(run.capabilityRef!, { runId: run.id, role: run.role, output })).resolves.toBe(false);
    expect(db!.get<{ status: string; output: string }>("SELECT status, output FROM agent_runs WHERE id = $id", { id: run.id }))
      .toEqual({ status: "COMPLETING", output: JSON.stringify(output) });
  });

  it("binds Integration PASS SHA fields to the exact persisted attempt when accepting the result", async () => {
    await setup();
    const run = await startRun({
      role: "integration", model: "gpt-4", taskId, epicId, triggerReason: "integration",
      contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir, allowedTools: ["submit_result"] },
    });
    const attemptId = randomUUID();
    const expectedTargetSha = "a".repeat(40);
    const sourceSha = "b".repeat(40);
    db!.run(
      `INSERT INTO integration_attempts
       (id,repository_path,source_branch,target_branch,expected_target_sha,worktree_path,integration_run_id,source_sha,status,created_at)
       VALUES($id,$repo,$source,$target,$targetSha,$workspace,$runId,$sourceSha,'MERGING',$createdAt)`,
      { id: attemptId, repo: tmpDir, source: `task/${taskId}`, target: "master", targetSha: expectedTargetSha,
        workspace: tmpDir, runId: run.id, sourceSha, createdAt: new Date().toISOString() },
    );
    const submitted = {
      version: "1.0.0", outcome: "PASS", baseSha: "c".repeat(40), sourceSha: "d".repeat(40),
      provenance: [`integration_attempt:${attemptId}`], evidence: ["project.test passed"],
    };

    await expect(runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: submitted,
    })).resolves.toBe(true);

    expect(JSON.parse(db!.get<{ output: string }>("SELECT output FROM agent_runs WHERE id=$id", { id: run.id })!.output))
      .toEqual({ ...submitted, baseSha: expectedTargetSha, sourceSha });
  });

  it("rejects Integration PASS submission without its exact persisted attempt identity", async () => {
    await setup();
    const run = await startRun({
      role: "integration", model: "gpt-4", taskId, epicId, triggerReason: "integration",
      contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir, allowedTools: ["submit_result"] },
    });
    const attemptId = randomUUID();
    db!.run(
      `INSERT INTO integration_attempts
       (id,repository_path,source_branch,target_branch,expected_target_sha,worktree_path,integration_run_id,source_sha,status,created_at)
       VALUES($id,$repo,$source,$target,$targetSha,$workspace,$runId,$sourceSha,'MERGING',$createdAt)`,
      { id: attemptId, repo: tmpDir, source: `task/${taskId}`, target: "master", targetSha: "a".repeat(40),
        workspace: tmpDir, runId: run.id, sourceSha: "b".repeat(40), createdAt: new Date().toISOString() },
    );

    await expect(runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id,
      role: run.role,
      output: {
        version: "1.0.0", outcome: "PASS", baseSha: "a".repeat(40), sourceSha: "b".repeat(40),
        provenance: [`integration_attempt:${randomUUID()}`], evidence: ["project.test passed"],
      },
    })).resolves.toBe(false);
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })?.status).toBe("STARTED");
  });

  it("rejects caller-supplied session IDs without dispatch or persisted mutation", async () => {
    await setup();
    const startedRun = await startRun({
      role: "reviewer",
      model: "gpt-4o",
      taskId,
      epicId,
      triggerReason: "review-request",
      contextVersion: "2.0.0",
      outputSchemaVersion: "1.0.0",
    });

    await expect(Reflect.apply(runService.resumeRun, runService, [startedRun.id, {
      sessionId: "caller-session", attempt: 1,
    }])).rejects.toThrow("RESUME_CALLER_SESSION_FORBIDDEN");
    expect(fakeRuntime.resumeCalls).toEqual([]);
    expect(db!.get<{ status: string; session_id: string | null; attempt: number | null }>(
      "SELECT status, session_id, attempt FROM agent_runs WHERE id = $id", { id: startedRun.id },
    )).toEqual({ status: "STARTED", session_id: null, attempt: null });
  });

  it("collects result and marks run as completed", async () => {
    await setup();
    const startedRun = await startRun({
       role: "developer",
      model: "claude-3",
      taskId,
      epicId,
      triggerReason: "planning-request",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
    await runService.completionStore().accept(startedRun.capabilityRef!, {
      runId: startedRun.id, role: startedRun.role, output: JSON.parse(output),
    });
    markFakeRunNeverLaunched(startedRun.id);
    const outcome: RunOutcome = {
      success: true,
      exitCode: 0,
       output,
       validatedSubmission: true,
       diagnostics: { runId: startedRun.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    };

    const collected = await runService.collectResult(startedRun.id, outcome);
    expect(collected.status).toBe("COMPLETED");
    expect(collected.outputSchemaVersion).toBe("1.0.0");
  });

  async function recoveryFixture() {
    await setup();
    const run = await startRun({ role: "reviewer", model: "default", taskId, epicId: null,
      triggerReason: "review-request", contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir } });
    const owner = getRunProcessOwner(db!, run.id)!;
    expect(owner.containmentKind).toBe(containmentKindForPlatform(process.platform));
    db!.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LAUNCHING", nextState: "LIVE", identity:
        ownerIdentityForContainmentKind(owner.containmentKind) });
      tx.run("UPDATE agent_runs SET status='IN_PROGRESS',session_id='original-session' WHERE id=$runId", { runId: run.id });
      tx.run("UPDATE run_process_owners SET capture_state='BOUND' WHERE run_id=$runId", { runId: run.id });
      syncCurrentRunProcessGenerationTx(tx, run.id);
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LIVE", nextState: "STOPPED",
        evidence: stopEvidenceForContainmentKind(owner.containmentKind) });
      const contextHash = tx.get<{ context_hash: string }>("SELECT context_hash FROM context_manifests WHERE run_id=$runId", { runId: run.id })!.context_hash;
      tx.run(`INSERT INTO run_resume_bindings(run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,
        workspace_snapshot_hash,resume_binding_hash,original_session_id,created_at)
        VALUES($runId,1,$baseline,$contextHash,1,$workspaceHash,$bindingHash,'original-session',$now)`, {
        runId: run.id, contextHash, workspaceHash: "b".repeat(64), bindingHash: digestResumeBindingV1(contextHash, "b".repeat(64)), now: new Date().toISOString(),
        baseline: JSON.stringify(createResumeContextBaselineV1({
          ...testContextInput({ taskId, epicId: null, role: "reviewer" }).versions,
          promptHash: digestRunPromptBytesV1(new TextEncoder().encode(run.prompt!)), subjectType: "TASK", subjectId: taskId,
          contractOrRequestDigest: null, items: [], contextBuilderVersion: "1.0.0", role: "reviewer",
          workspaceIdentity: { repository: tmpDir, workspace: tmpDir, worktree: taskId }, targetHead: null, targetBranch: null,
          effectiveCapabilityIds: effectiveRunToolIds("reviewer"), projectConfigRevisionId: null, projectConfigHash: null,
          policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
        })),
      });
    });
    return run;
  }

  it("finalizes a durable submit_result after restart without resuming Hermes or replacing the saved output", async () => {
    const run = await recoveryFixture();
    const output = JSON.stringify({ version: "1", outcome: "PASS" });
    expect(await runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: JSON.parse(output),
    })).toBe(true);
    expect(db!.get<{ status: string; output: string }>("SELECT status,output FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ status: "COMPLETING", output });

    const restarted = new RunService(db!, fakeRuntime);
    expect(restarted.reconcileInterruptedRuns()).toBe(1);

    expect(fakeRuntime.resumeCalls).toEqual([]);
    expect(db!.get<{ status: string; output: string; session_id: string; ended_at: string | null; capability_ref: string | null }>(
      "SELECT status,output,session_id,ended_at,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toMatchObject({ status: "COMPLETED", output, session_id: "original-session", capability_ref: null });
    expect(db!.get<{ state: string; stop_evidence: string }>("SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId: run.id }))
      .toMatchObject({ state: "STOPPED" });
  });

  it("preserves COMPLETING submission when the owner does not have STOPPED proof", async () => {
    await setup();
    const run = runService.prepareRun(withTestContext({ role: "reviewer", model: "default", taskId, epicId: null,
      triggerReason: "review-request", contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir } }));
    const output = JSON.stringify({ version: "1", outcome: "PASS" });
    expect(await runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: JSON.parse(output),
    })).toBe(true);

    const restarted = new RunService(db!, fakeRuntime);
    expect(restarted.reconcileInterruptedRuns()).toBe(0);
    expect(db!.get<{ status: string; output: string }>("SELECT status,output FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ status: "COMPLETING", output });
  });

  it("captures a source-backed baseline before dispatch and reconstructs current context after restart", async () => {
    await setup();
    seedApprovedProjectConfig(db!, _projectId);
    const workspace = join(tmpDir, "source-backed-worktree");
    await mkdir(workspace);
    await writeFile(join(workspace, "source.txt"), "original bytes");
    const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe", windowsHide: true });
    git(["init", "-b", "master"]);
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=", "commit", "-m", "fixture"]);
    db!.run("UPDATE tasks SET contract_json=$contract WHERE id=$taskId", { taskId, contract: JSON.stringify({ version: 1,
      goal: "Original goal", context: "Fixture", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }) });
    const now = new Date().toISOString();
    const approvalId = randomUUID();
    db!.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId: _projectId, now });
    db!.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$workspace,$facts,'{}','ACTIVE',$approvalId,$now,$now)", { projectId: _projectId, workspace, approvalId, now, facts: JSON.stringify({ defaultBranch: "master" }) });
    db!.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($taskId,$workspace,$workspace,$branch,$now)", { taskId, workspace, branch: `task/${taskId}`, now });
    db!.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$workspace,$branch,$taskId,'master',$now,$now)", { id: randomUUID(), taskId, workspace, branch: `task/${taskId}`, now });
    runService = new RunService(db!, fakeRuntime);
    const options = withTestContext({ role: "reviewer", model: "default", taskId, epicId: null,
      triggerReason: "review-request", contextVersion: "1", outputSchemaVersion: "1", capability: { workspace } });
    options.contextInput = { ...options.contextInput!, roleInputs: { gitDiff: "fixture diff", checks: ["fixture check"] },
      versions: { ...options.contextInput!.versions, model: "default" },
      execution: { ...options.contextInput!.execution, workspaceIdentity: { repository: workspace, workspace, worktree: taskId } } };
    const run = runService.prepareRun(options);
    const binding = db!.get<{ baseline_jcs: string; original_session_id: string | null }>("SELECT baseline_jcs,original_session_id FROM run_resume_bindings WHERE run_id=$runId", { runId: run.id });
    expect(binding?.original_session_id).toBeNull();
    expect(binding?.baseline_jcs).not.toContain(workspace);
    expect(binding?.baseline_jcs).not.toContain("fixture diff");
    await expect(fakeRuntime.inspectRun(run.id)).rejects.toThrow();
    const owner = getRunProcessOwner(db!, run.id)!;
    db!.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LAUNCHING", nextState: "LIVE", identity:
        ownerIdentityForContainmentKind(owner.containmentKind) });
      tx.run("UPDATE agent_runs SET session_id='original-session' WHERE id=$runId", { runId: run.id });
      tx.run("UPDATE run_resume_bindings SET original_session_id='original-session' WHERE run_id=$runId", { runId: run.id });
      tx.run("UPDATE run_process_owners SET capture_state='BOUND' WHERE run_id=$runId", { runId: run.id });
      syncCurrentRunProcessGenerationTx(tx, run.id);
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LIVE", nextState: "STOPPED", evidence: stopEvidenceForContainmentKind(owner.containmentKind) });
    });
    const restarted = new RunService(db!, fakeRuntime);
    await expect(restarted.verifyCurrentResumeContext(run.id)).resolves.toBeUndefined();
    db!.run("UPDATE tasks SET contract_json=json_set(contract_json,'$.goal','Changed goal') WHERE id=$taskId", { taskId });
    await expect(restarted.verifyCurrentResumeContext(run.id)).rejects.toThrow("RESUME_NOT_SAFE_WORKSPACE_CHANGED");
  });

  it("binds Integration recovery to the post-merge workspace once before launch and rejects subsequent mutation", async () => {
    await setup();
    seedApprovedProjectConfig(db!, _projectId);
    const workspace = join(tmpDir, "integration-worktree");
    await mkdir(workspace);
    await writeFile(join(workspace, "source.txt"), "base bytes");
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=", ...args], { cwd: workspace, stdio: "pipe", windowsHide: true }).toString("utf8").trim();
    git(["init", "-b", "master"]);
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
    const targetSha = git(["rev-parse", "HEAD"]);
    git(["checkout", "-b", "source"]);
    await writeFile(join(workspace, "source.txt"), "merged source bytes");
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "source"]);
    const sourceSha = git(["rev-parse", "HEAD"]);
    git(["checkout", "master"]);
    db!.run("UPDATE tasks SET contract_json=$contract WHERE id=$taskId", { taskId, contract: JSON.stringify({ version: 1,
      goal: "Integration goal", context: "Fixture", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }) });
    const attemptId = randomUUID();
    const provenanceDatabasePath = join(tmpDir, ".ebb-orchestrator", "integration.sqlite");
    runService = new RunService(db!, fakeRuntime);
    const options = withTestContext({ role: "integration", model: "default", taskId, epicId: null,
      triggerReason: "integration", contextVersion: "1", outputSchemaVersion: "1", capability: { workspace },
      prompt: `Verify ${sourceSha} ${targetSha} ${attemptId} ${provenanceDatabasePath}` });
    options.contextInput = { ...options.contextInput!, roleInputs: { sourceSha, targetSha, attemptId, provenanceDatabasePath },
      versions: { ...options.contextInput!.versions, model: "default" },
      execution: { ...options.contextInput!.execution, targetHead: targetSha, targetBranch: "master",
        workspaceIdentity: { repository: workspace, workspace, worktree: attemptId } } };
    const run = runService.prepareRun(options);
    const now = new Date().toISOString();
    const approvalId = randomUUID();
    db!.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId: _projectId, now });
    db!.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$workspace,$facts,'{}','ACTIVE',$approvalId,$now,$now)", { projectId: _projectId, workspace, approvalId, now, facts: JSON.stringify({ defaultBranch: "master" }) });
    db!.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($taskId,$workspace,$workspace,$branch,$now)", { taskId, workspace, branch: `task/${taskId}`, now });
    db!.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$workspace,$branch,$taskId,'master',$now,$now)", { id: randomUUID(), taskId, workspace, branch: `task/${taskId}`, now });
    db!.run(`INSERT INTO integration_attempts(id,repository_path,source_branch,target_branch,expected_target_sha,
      source_sha,worktree_path,integration_run_id,status,created_at)
      VALUES($id,$workspace,$sourceBranch,'master',$targetSha,$sourceSha,$workspace,$runId,'PREPARED',$now)`,
      { id: attemptId, workspace, sourceBranch: `task/${taskId}`, targetSha, sourceSha, runId: run.id, now });
    const original = db!.get("SELECT prompt,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id });
    expect(db!.get("SELECT * FROM run_resume_bindings WHERE run_id=$runId", { runId: run.id }))
      .toMatchObject({ workspace_snapshot_hash: null, resume_binding_hash: null });
    expect(() => runService.bindInitialIntegrationWorkspaceSnapshot(run.id)).toThrow("RESUME_INITIAL_WORKSPACE_UNVERIFIED");
    git(["merge", "--no-edit", sourceSha]);
    const postMerge = captureWorkspaceSnapshotV1(workspace).hash;
    runService.bindInitialIntegrationWorkspaceSnapshot(run.id);
    const binding = db!.get<{ context_hash: string; workspace_snapshot_hash: string; resume_binding_hash: string }>(
      "SELECT context_hash,workspace_snapshot_hash,resume_binding_hash FROM run_resume_bindings WHERE run_id=$runId", { runId: run.id })!;
    expect(binding.workspace_snapshot_hash).toBe(postMerge);
    expect(binding.resume_binding_hash).toBe(digestResumeBindingV1(binding.context_hash, postMerge));
    expect(db!.get("SELECT prompt,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id })).toEqual(original);
    expect(() => runService.bindInitialIntegrationWorkspaceSnapshot(run.id)).toThrow("RESUME_INITIAL_WORKSPACE_ALREADY_BOUND");
    const owner = getRunProcessOwner(db!, run.id)!;
    db!.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LAUNCHING", nextState: "LIVE", identity:
        owner.containmentKind === "windows-job" ? { platform: "win32", supervisorPid: 101, supervisorStartIdentity: "supervisor", pid: 102, processStartIdentity: "process", executableIdentity: "executable" }
          : { platform: "linux", pid: 102, systemdInvocationId: "invocation", systemdControlGroup: "/test-cgroup" } });
      tx.run("UPDATE agent_runs SET session_id='original-session' WHERE id=$runId", { runId: run.id });
      tx.run("UPDATE run_resume_bindings SET original_session_id='original-session' WHERE run_id=$runId", { runId: run.id });
      tx.run("UPDATE run_process_owners SET capture_state='BOUND' WHERE run_id=$runId", { runId: run.id });
      syncCurrentRunProcessGenerationTx(tx, run.id);
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LIVE", nextState: "STOPPED", evidence: stopEvidenceForContainmentKind(owner.containmentKind) });
      tx.run("UPDATE integration_attempts SET status='MERGING' WHERE id=$id", { id: attemptId });
    });
    const restarted = new RunService(db!, fakeRuntime);
    await expect(restarted.verifyCurrentResumeContext(run.id)).resolves.toBeUndefined();
    await writeFile(join(workspace, "source.txt"), "unexpected mutation");
    await expect(restarted.verifyCurrentResumeContext(run.id)).rejects.toThrow("RESUME_NOT_SAFE_WORKSPACE_CHANGED");
    expect(() => restarted.bindInitialIntegrationWorkspaceSnapshot(run.id)).toThrow();
    expect(db!.get("SELECT context_hash,workspace_snapshot_hash,resume_binding_hash FROM run_resume_bindings WHERE run_id=$runId", { runId: run.id })).toEqual(binding);
  });

  it("loads the original session after service restart and preserves immutable stopped generation during same-Run resume", async () => {
    const run = await recoveryFixture();
    const oldGeneration = db!.get("SELECT * FROM run_process_owner_generations WHERE run_id=$runId AND generation=1", { runId: run.id });
    const verifyContext = vi.fn(async () => {});
    runService = new RunService(db!, fakeRuntime, undefined, { verifyContext,
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); } });
    expect(runService.isRecoveryCandidate(run.id)).toBe(true);
    expect(new RunService(db!, fakeRuntime).isRecoveryCandidate(run.id)).toBe(false);
    fakeRuntime.collectResult = async (runId) => {
      expect(db!.get("SELECT session_id,status,attempt,capability_ref FROM agent_runs WHERE id=$runId", { runId }))
        .toEqual({ session_id: "original-session", status: "IN_PROGRESS", attempt: 1, capability_ref: run.capabilityRef });
      expect(db!.get("SELECT current_generation,state,capture_state FROM run_process_owners WHERE run_id=$runId", { runId }))
        .toEqual({ current_generation: 2, state: "PREPARED", capture_state: "BOUND" });
      const output = JSON.stringify({ version: "1", outcome: "PASS" });
      await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "reviewer", output: JSON.parse(output),
      });
      markFakeRunNeverLaunched(runId);
      return { success: true, exitCode: 0, output, validatedSubmission: true,
        diagnostics: { runId, sessionId: "original-session", stderr: "", exitCode: 0, artifactReferences: [] } };
    };
    expect(runService.reconcileInterruptedRuns()).toBe(0);
    expect(fakeRuntime.resumeCalls).toEqual([]);
    await runService.resumeRecoveryCandidates();
    expect(verifyContext).toHaveBeenCalledWith(run.id);
    expect(fakeRuntime.resumeCalls).toEqual([{ runId: run.id, options: { sessionId: "original-session", attempt: 1 } }]);
    expect(db!.get("SELECT session_id,status,attempt,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ session_id: "original-session", status: "COMPLETED", attempt: 1, capability_ref: null });
    expect(db!.get("SELECT * FROM run_process_owner_generations WHERE run_id=$runId AND generation=1", { runId: run.id })).toEqual(oldGeneration);
    expect(db!.get("SELECT current_generation,state,capture_state FROM run_process_owners WHERE run_id=$runId", { runId: run.id }))
      .toEqual({ current_generation: 2, state: "STOPPED", capture_state: "BOUND" });
    const before = fakeRuntime.resumeCalls.length;
    expect(runService.isRecoveryCandidate(run.id)).toBe(false);
    await expect(runService.resumeRun(run.id, { attempt: 1 })).rejects.toThrow("terminal state");
    expect(fakeRuntime.resumeCalls).toHaveLength(before);
  });

  it("finalizes same-session recovery through authenticated submission and persists runtime usage", async () => {
    const run = await recoveryFixture();
    const events: AgentEvent[] = [];
    const sink: AgentEventSink = { emit: (event) => events.push(event) };
    runService = new RunService(db!, fakeRuntime, undefined, { verifyContext: async () => {},
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); } }, sink);
    const output = JSON.stringify({ version: "1", outcome: "PASS" });
    const collectResult = vi.spyOn(fakeRuntime, "collectResult").mockImplementation(async (runId) => {
      expect(await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "reviewer", output: JSON.parse(output),
      })).toBe(true);
      markFakeRunNeverLaunched(runId);
      return { success: true, exitCode: 0, output, validatedSubmission: true,
        diagnostics: { runId, sessionId: "original-session", stderr: "", exitCode: 0, artifactReferences: [] } };
    });
    vi.spyOn(fakeRuntime, "collectUsage").mockResolvedValue({ inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, cost: 0.25 });

    const completed = await runService.resumeRun(run.id, { attempt: 1 });

    expect(collectResult).toHaveBeenCalledWith(run.id);
    expect(events.map((event) => event.type)).toEqual(["run_started", "run_finished"]);
    expect(events[0]).toMatchObject({ type: "run_started", runId: run.id });
    expect(completed).toMatchObject({ id: run.id, status: "COMPLETED", sessionId: "original-session", attempt: 1, cost: 0.25 });
    expect(completed.capabilityRef).toBeUndefined();
    expect(db!.get("SELECT input_tokens,cached_input_tokens,output_tokens,cost,capability_json,output FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ input_tokens: 12, cached_input_tokens: 2, output_tokens: 3, cost: 0.25, capability_json: null, output });
  });

  it("rejects a resumed stdout success claim without an authenticated submit_result", async () => {
    const run = await recoveryFixture();
    runService = new RunService(db!, fakeRuntime, undefined, { verifyContext: async () => {},
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); } });
    vi.spyOn(fakeRuntime, "collectResult").mockImplementation(async (runId) => {
      markFakeRunNeverLaunched(runId);
      return { success: true, exitCode: 0, output: JSON.stringify({ version: "1", outcome: "PASS" }), validatedSubmission: false,
        diagnostics: { runId, sessionId: "original-session", stderr: "", exitCode: 0, artifactReferences: [] } };
    });
    await expect(runService.resumeRun(run.id, { attempt: 1 })).rejects.toThrow("AGENT_OUTPUT_MISSING:EXIT_0");
    expect(db!.get("SELECT status,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ status: "FAILED", capability_ref: null });
  });

  it("retains resumed Run capability while authenticated completion lacks a STOPPED proof", async () => {
    const run = await recoveryFixture();
    runService = new RunService(db!, fakeRuntime, undefined, { verifyContext: async () => {},
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); } });
    vi.spyOn(fakeRuntime, "collectResult").mockImplementation(async (runId) => {
      const output = JSON.stringify({ version: "1", outcome: "PASS" });
      await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "reviewer", output: JSON.parse(output),
      });
      db!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId, expectedState: "PREPARED", nextState: "LAUNCHING",
      }));
      return { success: true, exitCode: 0, output, validatedSubmission: true,
        diagnostics: { runId, sessionId: "original-session", stderr: "", exitCode: 0, artifactReferences: [] } };
    });

    await expect(runService.resumeRun(run.id, { attempt: 1 })).rejects.toThrow("RUN_PROCESS_SCOPE_STOP_UNPROVEN");
    expect(db!.get("SELECT status,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ status: "COMPLETING", capability_ref: run.capabilityRef });
    expect(getRunProcessOwner(db!, run.id)?.state).toBe("LAUNCHING");
  });

  it.each(["RESUME_NOT_SAFE_WORKSPACE_CHANGED", "SCHEDULER_GATE_REJECTED"])("preserves all resources after recovery gate refusal %s", async (code) => {
    const run = await recoveryFixture();
    const beforeRun = db!.get("SELECT * FROM agent_runs WHERE id=$runId", { runId: run.id });
    const beforeOwner = db!.get("SELECT * FROM run_process_owners WHERE run_id=$runId", { runId: run.id });
    runService = new RunService(db!, fakeRuntime, undefined, {
      verifyContext: async () => { if (code === "RESUME_NOT_SAFE_WORKSPACE_CHANGED") throw new Error(code); },
      claimInTransaction: () => { throw new Error(code); },
    });
    await expect(runService.resumeRun(run.id, { attempt: 1 })).rejects.toThrow(code);
    expect(fakeRuntime.resumeCalls).toEqual([]);
    expect(db!.get("SELECT * FROM agent_runs WHERE id=$runId", { runId: run.id })).toEqual(beforeRun);
    expect(db!.get("SELECT * FROM run_process_owners WHERE run_id=$runId", { runId: run.id })).toEqual(beforeOwner);
  });

  it("rejects a claim hook that fails to create the next generation and rolls back the claim", async () => {
    const run = await recoveryFixture();
    runService = new RunService(db!, fakeRuntime, undefined, { verifyContext: async () => {}, claimInTransaction: () => {} });
    await expect(runService.resumeRun(run.id, { attempt: 1 })).rejects.toThrow("RESUME_GENERATION_CLAIM_INVALID");
    expect(fakeRuntime.resumeCalls).toEqual([]);
    expect(db!.get("SELECT attempt,session_id FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ attempt: null, session_id: "original-session" });
  });

  it("keeps the approved repository snapshot alongside the Task runtime command policy", async () => {
    await setup();
    const approvedCommand = { executable: process.execPath, args: ["-e", 'process.stdout.write("approved revision")'] };
    seedApprovedProjectConfig(db!, _projectId, "master", { test: approvedCommand });
    const workspace = join(tmpDir, "task-worktree");
    const repository = join(tmpDir, "repository");
    await mkdir(join(workspace, "test"), { recursive: true });
    await mkdir(repository, { recursive: true });
    await writeFile(join(workspace, "test", "smoke.js"), 'process.stdout.write("fixture smoke passed")', "utf8");
    const now = new Date().toISOString();
    const approvalId = randomUUID();
    db!.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId: _projectId, now });
    db!.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repository,$facts,$proposed,'ACTIVE',$approvalId,$now,$now)", {
      projectId: _projectId, repository, facts: JSON.stringify({ defaultBranch: "master" }), proposed: JSON.stringify({ defaultBranch: "master" }), approvalId, now,
    });
    db!.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$repository,$workspace,$branch,$now)", { id: taskId, repository, workspace, branch: `task/${taskId}`, now });
    db!.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$repository,$branch,$taskId,'master',$now,$now)", {
      id: randomUUID(), repository, branch: `task/${taskId}`, taskId, now,
    });
    expect(() => prepareRun({
      role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
      capability: { workspace, projectConfig: { commands: { test: { executable: process.execPath, args: ["test/smoke.js"] } } }, allowedTools: ["project.test", "submit_result"] },
    })).toThrow(/approved Project Config revision/i);

    const run = prepareRun({
      role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
      capability: { workspace, allowedTools: ["project.test", "submit_result"] },
    });
    const persisted = db!.get<{ capability_json: string }>("SELECT capability_json FROM agent_runs WHERE id=$runId", { runId: run.id });
    const capability = JSON.parse(persisted!.capability_json) as ConstructorParameters<typeof RunCapability>[0];
    expect(capability).toMatchObject({ approvedProjectConfig: { config: { execution: { commands: { test: approvedCommand } } } } });
    expect(capability).not.toHaveProperty("projectConfig.commands.test");

    // A newer approval must not replace the command pinned to this Run's exact revision.
    seedApprovedProjectConfig(db!, _projectId, "master", {
      test: { executable: process.execPath, args: ["-e", 'process.stdout.write("newer revision")'] },
    });

    const result = await new McpServer(loadValidatedCapability(db!, run.capabilityRef!)).callTool("project.test", {});
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ action: "test", success: true, stdout: "approved revision", exitCode: 0 });
  });

  it.each([7, 0])("fails safely when runtime returns no validated submission (exit %i)", async (exitCode) => {
    await setup();
    const secret = "private provider stdout must not persist";
    fakeRuntime.startRun = async (run) => { markFakeRunNeverLaunched(run.id); };
    fakeRuntime.script("developer", [{
      success: exitCode === 0,
      exitCode,
      output: secret,
      validatedSubmission: false,
      diagnostics: { runId: "runtime-run-id", sessionId: null, stderr: "private stderr", exitCode, artifactReferences: [] },
    }]);
    const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });

    await expect(runService.executePreparedRun(run.id)).rejects.toThrow(`AGENT_OUTPUT_MISSING:EXIT_${exitCode}`);

    const failedRun = db!.get<{ status: string; exit_code: number; output: string }>(
      "SELECT status,exit_code,output FROM agent_runs WHERE id=$runId", { runId: run.id },
    );
    expect(failedRun).toMatchObject({ status: "FAILED", exit_code: exitCode });
    expect(failedRun?.output).toContain(`AGENT_OUTPUT_MISSING:EXIT_${exitCode}`);
    expect(failedRun?.output).not.toContain(secret);
    expect(failedRun?.output).not.toContain("private stderr");
    const owner = db!.get<{ state: string; stop_evidence: string | null; containment_kind: string }>(
      "SELECT state,stop_evidence,containment_kind FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
    );
    expect(owner?.state).toBe("STOPPED");
    expect(isAuthoritativeRunProcessStopEvidence(owner?.stop_evidence ?? null,
      owner?.containment_kind as "windows-job" | "systemd-user-service")).toBe(true);
  });

  it("adds only validated submit_result counters to the missing-output diagnostic", async () => {
    await setup();
    fakeRuntime.startRun = async (run) => { markFakeRunNeverLaunched(run.id); };
    const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    fakeRuntime.collectResult = async (runId) => ({
      success: false,
      exitCode: 0,
      output: "AGENT_OUTPUT_MISSING",
      validatedSubmission: false,
      diagnostics: {
        runId, sessionId: null, stderr: "private stderr", exitCode: 0, artifactReferences: [],
        submitResultToolUses: 4, submitResultCalls: 1, submitResultErrors: 1,
      },
    });

    await expect(runService.executePreparedRun(run.id)).rejects.toThrow(
      "AGENT_OUTPUT_MISSING:EXIT_0:TOOL_USES_4:SUBMIT_RESULT_CALLS_1:SUBMIT_RESULT_ERRORS_1",
    );
    const persisted = db!.get<{ output: string }>("SELECT output FROM agent_runs WHERE id=$runId", { runId: run.id })?.output ?? "";
    expect(persisted).toContain("TOOL_USES_4:SUBMIT_RESULT_CALLS_1:SUBMIT_RESULT_ERRORS_1");
    expect(persisted).not.toContain("private stderr");
  });

  async function providerErrorNormalPathFixture(stderr: string) {
    await setup();
    const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
    fakeRuntime.startRun = async (run) => { markFakeRunNeverLaunched(run.id); };
    fakeRuntime.collectResult = async (runId) => {
      const accepted = await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "developer", output: JSON.parse(output),
      });
      expect(accepted).toBe(true);
      return {
        success: false,
        exitCode: 0,
        output: "AGENT_OUTPUT_MISSING",
        validatedSubmission: false,
        diagnostics: { runId, sessionId: null, stderr, exitCode: 0, artifactReferences: [] },
      };
    };
    return runService.executePreparedRun(run.id);
  }

  it.each([
    ["HTTP 429 Too Many Requests", "capacity"],
    ["HTTP 401 Unauthorized", "auth"],
  ])("adds providerError category %s to diagnostics on the normal execution path", async (stderr, category) => {
    const { outcome } = await providerErrorNormalPathFixture(stderr);
    expect(outcome.diagnostics?.providerError?.category).toBe(category);
    expect(outcome.diagnostics?.providerError?.id).toMatch(/^E\d+$/);
    expect(outcome.diagnostics?.stderr).toBe(stderr);
  });

  it("does not add providerError for unrecognized stderr on the normal execution path", async () => {
    const { outcome } = await providerErrorNormalPathFixture("npm ERR! code ENOENT");
    expect(outcome.diagnostics?.providerError).toBeUndefined();
    expect(outcome.diagnostics?.stderr).toBe("npm ERR! code ENOENT");
  });

  it("adds providerError diagnostics to the recovered outcome during same-session recovery", async () => {
    const run = await recoveryFixture();
    runService = new RunService(db!, fakeRuntime, undefined, { verifyContext: async () => {},
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); } });
    const output = JSON.stringify({ version: "1", outcome: "PASS" });
    vi.spyOn(fakeRuntime, "collectResult").mockImplementation(async (runId) => {
      expect(await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "reviewer", output: JSON.parse(output),
      })).toBe(true);
      markFakeRunNeverLaunched(runId);
      return { success: true, exitCode: 0, output, validatedSubmission: true,
        diagnostics: { runId, sessionId: "original-session", stderr: "HTTP 429 Too Many Requests", exitCode: 0, artifactReferences: [] } };
    });
    const persist = vi.spyOn(runService, "collectResult");
    const completed = await runService.resumeRun(run.id, { attempt: 1 });
    expect(completed.status).toBe("COMPLETED");
    expect(persist).toHaveBeenCalledWith(run.id, expect.objectContaining({
      diagnostics: expect.objectContaining({
        providerError: expect.objectContaining({ category: "capacity", id: "E3001" }),
      }),
    }));
  });

  it("recovers a missing runtime result file from the authenticated durable submission", async () => {
    await setup();
    const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
    fakeRuntime.collectResult = async (runId) => {
      const accepted = await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "developer", output: JSON.parse(output),
      });
      expect(accepted).toBe(true);
      markFakeRunNeverLaunched(runId);
      return {
        success: false,
        exitCode: 0,
        output: "AGENT_OUTPUT_MISSING",
        validatedSubmission: false,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
      };
    };

    const recovered = await runService.executePreparedRun(run.id);

    expect(recovered.outcome).toMatchObject({
      exitCode: 0,
      output,
      validatedSubmission: true,
      diagnostics: { runId: run.id },
    });
    expect(recovered.run.status).toBe("COMPLETED");
    expect(db!.get<{ output: string }>("SELECT output FROM agent_runs WHERE id=$runId", { runId: run.id })?.output)
      .toBe(output);
  });

  it("does not recover a durable submission when runtime exits nonzero", async () => {
    await setup();
    const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
    fakeRuntime.collectResult = async (runId) => {
      const accepted = await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "developer", output: JSON.parse(output),
      });
      expect(accepted).toBe(true);
      markFakeRunNeverLaunched(runId);
      return {
        success: false,
        exitCode: 7,
        output: "AGENT_OUTPUT_MISSING",
        validatedSubmission: false,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 7, artifactReferences: [] },
      };
    };

    await expect(runService.executePreparedRun(run.id)).rejects.toThrow("AGENT_OUTPUT_MISSING:EXIT_7");
    expect(db!.get<{ status: string; exit_code: number; output: string }>(
      "SELECT status,exit_code,output FROM agent_runs WHERE id=$runId", { runId: run.id },
    )).toMatchObject({ status: "FAILED", exit_code: 7 });
    expect(db!.get<{ output: string }>("SELECT output FROM agent_runs WHERE id=$runId", { runId: run.id })?.output)
      .toContain("AGENT_OUTPUT_MISSING:EXIT_7");
  });

  it.each([
    ["run identity", "wrong-runtime-id", 0],
    ["diagnostic exit code", "matching-run-id", 7],
  ])("does not recover a durable submission with mismatched %s diagnostics", async (_label, diagnosticRunId, diagnosticExitCode) => {
    await setup();
    const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
    fakeRuntime.collectResult = async (runId) => {
      const accepted = await runService.completionStore().accept(runService.getCapabilityReference(runId), {
        runId, role: "developer", output: JSON.parse(output),
      });
      expect(accepted).toBe(true);
      markFakeRunNeverLaunched(runId);
      return {
        success: false,
        exitCode: 0,
        output: "AGENT_OUTPUT_MISSING",
        validatedSubmission: false,
        diagnostics: {
          runId: diagnosticRunId === "matching-run-id" ? runId : diagnosticRunId,
          sessionId: null, stderr: "", exitCode: diagnosticExitCode, artifactReferences: [],
        },
      };
    };

    await expect(runService.executePreparedRun(run.id)).rejects.toThrow("AGENT_OUTPUT_MISSING:EXIT_0");
    expect(db!.get<{ status: string; exit_code: number; output: string }>(
      "SELECT status,exit_code,output FROM agent_runs WHERE id=$runId", { runId: run.id },
    )).toMatchObject({ status: "FAILED", exit_code: 0 });
    expect(db!.get<{ output: string }>("SELECT output FROM agent_runs WHERE id=$runId", { runId: run.id })?.output)
      .toContain("AGENT_OUTPUT_MISSING:EXIT_0");
  });

  it("transition matrix: CANCELLED is immutable (cannot resume)", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await runService.cancelRun(run.id);
    expect(db!.get<{ capability_ref: string | null; capability_json: string | null }>(
      "SELECT capability_ref,capability_json FROM agent_runs WHERE id=$runId", { runId: run.id },
    )).toEqual({ capability_ref: null, capability_json: null });
    await expect(runService.resumeRun(run.id, { attempt: 1 }))
      .rejects.toThrow(/terminal state/);
  });

  it("transition matrix: COMPLETED is immutable (cannot resume)", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
    await runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: JSON.parse(output),
    });
    markFakeRunNeverLaunched(run.id);
    await runService.collectResult(run.id, {
      success: true, exitCode: 0, output, validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    });
    await expect(runService.resumeRun(run.id, { attempt: 1 }))
      .rejects.toThrow(/terminal state/);
  });

  it("transition matrix: FAILED is immutable (cannot resume)", async () => {
    await setup();
    fakeRuntime.startRun = async () => { throw new Error("crash"); };
    await expect(startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    })).rejects.toThrow("crash");
    await expect(runService.resumeRun(db!.get<{ id: string }>("SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT 1")!.id, { attempt: 1 }))
      .rejects.toThrow(/terminal state/);
  });

  describe("RunService ephemeral agent events", () => {
    function recordingSink(): { events: AgentEvent[]; sink: AgentEventSink } {
      const events: AgentEvent[] = [];
      const sink: AgentEventSink = { emit: (event) => events.push(event) };
      return { events, sink };
    }

    function completedOutcome(runId: string, output: string): RunOutcome {
      return {
        success: true,
        exitCode: 0,
        output,
        validatedSubmission: true,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
      };
    }

    function scriptValidatedCompletion(runId: string, output: string): void {
      fakeRuntime.startRun = async (run) => { markFakeRunNeverLaunched(run.id); };
      fakeRuntime.collectResult = async (collectRunId) => {
        const accepted = await runService.completionStore().accept(runService.getCapabilityReference(collectRunId), {
          runId: collectRunId, role: "developer", output: JSON.parse(output),
        });
        expect(accepted).toBe(true);
        return completedOutcome(collectRunId, output);
      };
    }

    it("emits run_started then run_finished around the existing start/result/commit path", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
      scriptValidatedCompletion(run.id, output);
      const { events, sink } = recordingSink();
      runService = new RunService(db!, fakeRuntime, {
        prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
      }, undefined, sink);

      await runService.executePreparedRun(run.id);

      expect(events.map((event) => event.type)).toEqual(["run_started", "run_finished"]);
      expect(events[0]).toMatchObject({ type: "run_started", runId: run.id });
      expect(typeof (events[0] as Extract<AgentEvent, { type: "run_started" }>).occurredAt).toBe("string");
      expect(events[1]).toEqual({ type: "run_finished", runId: run.id, status: "COMPLETED" });
    });

    it("emits run_finished only after the terminal status is persisted", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
      scriptValidatedCompletion(run.id, output);
      const statusAtFinish: string[] = [];
      runService = new RunService(db!, fakeRuntime, {
        prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
      }, undefined, {
        emit: (event) => {
          if (event.type === "run_finished") {
            statusAtFinish.push(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })!.status);
          }
        },
      });

      await runService.executePreparedRun(run.id);

      expect(statusAtFinish).toEqual(["COMPLETED"]);
    });

    it("emits run_finished FAILED, never COMPLETED, when the structured result is missing or invalid", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      fakeRuntime.startRun = async (started) => { markFakeRunNeverLaunched(started.id); };
      fakeRuntime.collectResult = async (runId) => ({
        success: false,
        exitCode: 0,
        output: "AGENT_OUTPUT_MISSING",
        validatedSubmission: false,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
      });
      const { events, sink } = recordingSink();
      runService = new RunService(db!, fakeRuntime, {
        prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
      }, undefined, sink);

      await expect(runService.executePreparedRun(run.id)).rejects.toThrow("AGENT_OUTPUT_MISSING");

      expect(events.filter((event) => event.type === "run_finished")).toEqual([
        { type: "run_finished", runId: run.id, status: "FAILED" },
      ]);
    });

    it("emits run_finished CANCELLED only after cancellation persists the terminal status", async () => {
      await setup();
      const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      const { events, sink } = recordingSink();
      runService = new RunService(db!, fakeRuntime, undefined, undefined, sink);

      await runService.cancelRun(run.id);

      expect(events).toEqual([{ type: "run_finished", runId: run.id, status: "CANCELLED" }]);
      expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })?.status).toBe("CANCELLED");
    });

    it("does not re-emit run_finished when an already terminal run is cancelled again", async () => {
      await setup();
      const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      const { events, sink } = recordingSink();
      runService = new RunService(db!, fakeRuntime, undefined, undefined, sink);

      await runService.cancelRun(run.id);
      expect(events).toHaveLength(1);
      await runService.cancelRun(run.id);
      expect(events).toHaveLength(1);
    });

    it("emits run_finished COMPLETED when restart reconciliation finalizes a persisted submission", async () => {
      const run = await recoveryFixture();
      const output = JSON.stringify({ version: "1", outcome: "PASS" });
      expect(await runService.completionStore().accept(run.capabilityRef!, {
        runId: run.id, role: run.role, output: JSON.parse(output),
      })).toBe(true);
      const { events, sink } = recordingSink();
      const restarted = new RunService(db!, fakeRuntime, undefined, undefined, sink);

      expect(restarted.reconcileInterruptedRuns()).toBe(1);

      expect(events).toEqual([{ type: "run_finished", runId: run.id, status: "COMPLETED" }]);
    });

    it("emits run_finished FAILED when restart reconciliation fails an interrupted run", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      const { events, sink } = recordingSink();
      const restarted = new RunService(db!, fakeRuntime, undefined, undefined, sink);

      expect(restarted.reconcileInterruptedRuns()).toBe(1);

      expect(events).toEqual([{ type: "run_finished", runId: run.id, status: "FAILED" }]);
    });

    it("does not let an event sink error affect the run outcome", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
      scriptValidatedCompletion(run.id, output);
      runService = new RunService(db!, fakeRuntime, {
        prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
      }, undefined, { emit: () => { throw new Error("observer boom"); } });

      const completed = await runService.executePreparedRun(run.id);

      expect(completed.run.status).toBe("COMPLETED");
    });
  });

  describe("failRun terminal contract", () => {
    function recordingSink(): { events: AgentEvent[]; sink: AgentEventSink } {
      const events: AgentEvent[] = [];
      const sink: AgentEventSink = { emit: (event) => events.push(event) };
      return { events, sink };
    }

    it("returns true for an already-terminal run with canonical STOPPED proof without re-emitting run_finished", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      db!.run("UPDATE agent_runs SET status='FAILED' WHERE id=$id", { id: run.id });
      markFakeRunNeverLaunched(run.id);
      const { events, sink } = recordingSink();
      const service = new RunService(db!, fakeRuntime, undefined, undefined, sink);

      expect(service.failPreparedRun(run.id, new Error("boom"))).toBe(true);
      expect(events).toEqual([]);
      expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })?.status).toBe("FAILED");
    });

    it("returns true for an ownerless legacy terminal run and emits nothing", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      db!.run("UPDATE agent_runs SET status='CANCELLED' WHERE id=$id", { id: run.id });
      db!.run("DELETE FROM run_process_owners WHERE run_id=$runId", { runId: run.id });
      const { events, sink } = recordingSink();
      const service = new RunService(db!, fakeRuntime, undefined, undefined, sink);

      expect(service.failPreparedRun(run.id, new Error("boom"))).toBe(true);
      expect(events).toEqual([]);
    });

    it("returns false for a terminal run without canonical STOPPED proof", async () => {
      await setup();
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      db!.run("UPDATE agent_runs SET status='FAILED' WHERE id=$id", { id: run.id });

      expect(runService.failPreparedRun(run.id, new Error("boom"))).toBe(false);
    });

    it("persists only redacted error text when the failure reason contains secrets", async () => {
      await setup();
      const skToken = `sk-proj-${"A".repeat(30)}`;
      const jwt = `eyJ${"B".repeat(12)}.${"C".repeat(12)}.${"D".repeat(16)}`;
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      markFakeRunNeverLaunched(run.id);

      expect(runService.failPreparedRun(run.id, new Error(`Provider auth failed: ${skToken}; id_token=${jwt}`))).toBe(true);

      const persisted = db!.get<{ status: string; output: string }>(
        "SELECT status,output FROM agent_runs WHERE id=$runId", { runId: run.id },
      );
      expect(persisted?.status).toBe("FAILED");
      expect(persisted?.output).not.toContain(skToken);
      expect(persisted?.output).not.toContain(jwt);
      expect(persisted?.output).toContain(REDACTED_PLACEHOLDER);
      expect(persisted?.output).toContain("Provider auth failed");
    });
  });

  describe("production AgentEventBus wiring", () => {
    it("shares one AgentEventBus between the runtime adapter and RunService", async () => {
      await setup();
      const production = createProductionComposition({
        database: db!,
        home: resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: tmpDir }, process.platform as Platform),
      });
      const bus = production.agentEventBus;
      expect(bus).toBeInstanceOf(AgentEventBus);
      expect((production.runtime as unknown as { agentEvents?: unknown }).agentEvents).toBe(bus);

      const seen: AgentEvent[] = [];
      bus.addListener((event) => seen.push(event));
      const run = prepareRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1" });
      const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
      fakeRuntime.startRun = async (started) => { markFakeRunNeverLaunched(started.id); };
      fakeRuntime.collectResult = async (collectRunId) => {
        const accepted = await runService.completionStore().accept(runService.getCapabilityReference(collectRunId), {
          runId: collectRunId, role: "developer", output: JSON.parse(output),
        });
        expect(accepted).toBe(true);
        return { success: true, exitCode: 0, output, validatedSubmission: true,
          diagnostics: { runId: collectRunId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
      };
      runService = new RunService(db!, fakeRuntime, {
        prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
      }, undefined, bus);

      await runService.executePreparedRun(run.id);

      expect(seen.map((event) => event.type)).toEqual(["run_started", "run_finished"]);
    });
  });

  describe("best-effort run traces", () => {
    function traceRow(runId: string): Record<string, unknown> | undefined {
      return db!.get("SELECT * FROM run_traces WHERE run_id=$runId", { runId });
    }

    async function completePreparedRunViaRuntime(
      run: { id: string; role: string },
      triggerReason?: string,
    ): Promise<void> {
      if (triggerReason !== undefined) {
        db!.run("UPDATE agent_runs SET trigger_reason=$triggerReason WHERE id=$runId", { runId: run.id, triggerReason });
      }
      const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED", commitSha: "test-commit-sha" });
      fakeRuntime.startRun = async (started) => { markFakeRunNeverLaunched(started.id); };
      fakeRuntime.collectResult = async (collectRunId) => {
        const accepted = await runService.completionStore().accept(runService.getCapabilityReference(collectRunId), {
          runId: collectRunId, role: run.role, output: JSON.parse(output),
        });
        expect(accepted).toBe(true);
        return {
          success: true, exitCode: 0, output, validatedSubmission: true,
          diagnostics: { runId: collectRunId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
        };
      };
      await runService.executePreparedRun(run.id);
    }

    it("writes one canonical best-effort trace after the normal completion path", async () => {
      await setup();
      const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: tmpDir, allowedTools: ["submit_result"] } });
      await completePreparedRunViaRuntime(run);

      const row = traceRow(run.id)!;
      expect(row.scenario).toBe("task-assignment");
      expect(row.prompt_hash).toBe(digestRunPromptBytesV1(new TextEncoder().encode(run.prompt!)));
      expect(row.context_hash).toBe("b".repeat(64));
      expect(row.usage_json).toBeNull();
      expect(row.version).toBe("1.0");
      const endedAt = db!.get<{ ended_at: string }>("SELECT ended_at FROM agent_runs WHERE id=$runId", { runId: run.id })!.ended_at;
      expect(row.created_at).toBe(endedAt);
      expect(db!.all("SELECT * FROM run_traces")).toHaveLength(1);
    });

    it("maps persisted usage into the trace when collection succeeded", async () => {
      await setup();
      const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "test-assignment", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: tmpDir, allowedTools: ["submit_result"] } });
      await runService.collectUsage(run.id, { inputTokens: 11, cachedInputTokens: 2, outputTokens: 5, cost: 0.75 });
      await completePreparedRunViaRuntime(run);

      expect(traceRow(run.id)!.usage_json)
        .toBe(JSON.stringify({ inputTokens: 11, cachedInputTokens: 2, outputTokens: 5, cost: 0.75 }));
    });

    it("maps known epic phase triggers to the epic-phase scenario", async () => {
      await setup();
      const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "custom", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: tmpDir, allowedTools: ["submit_result"] } });
      await completePreparedRunViaRuntime(run, "epic-integration");
      expect(traceRow(run.id)!.scenario).toBe("epic-phase");
    });

    it("skips unknown triggers with only the stable diagnostic", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await setup();
        const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
          triggerReason: "custom", contextVersion: "1", outputSchemaVersion: "1",
          capability: { workspace: tmpDir, allowedTools: ["submit_result"] } });
        await completePreparedRunViaRuntime(run, "epic-mystery-phase");
        expect(traceRow(run.id)).toBeUndefined();
        const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(logged).toContain("TRACE_SCENARIO_UNMAPPED");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("does not trace failed runs", async () => {
      await setup();
      const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: tmpDir, allowedTools: ["submit_result"] } });
      fakeRuntime.script("developer", [{
        success: false, exitCode: 1, output: "",
        diagnostics: { runId: run.id, sessionId: null, stderr: "boom", exitCode: 1, artifactReferences: [] },
      }]);
      await expect(runService.executePreparedRun(run.id)).rejects.toThrow(/AGENT_OUTPUT_MISSING/);
      expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })!.status)
        .toBe("FAILED");
      expect(traceRow(run.id)).toBeUndefined();
    });

    it("keeps the Run COMPLETED when trace storage fails after commit", async () => {
      await setup();
      const failingStore: ITracingStore = { save: () => { throw new Error("storage down"); } };
      runService = new RunService(db!, fakeRuntime, {
        prepare: (_tx, input) => preparedContext(input.prompt, input.role, input.subject),
      }, undefined, undefined, failingStore);
      const run = await startRun({ role: "developer", model: "default", taskId, epicId: null,
        triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
        capability: { workspace: tmpDir, allowedTools: ["submit_result"] } });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await completePreparedRunViaRuntime(run);
        expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })!.status)
          .toBe("COMPLETED");
        expect(traceRow(run.id)).toBeUndefined();
        const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(logged).toContain("TRACE_STORE_FAILED");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("finalizes a trace after restart recovery and repeats idempotently", async () => {
      const run = await recoveryFixture();
      const output = JSON.stringify({ version: "1", outcome: "PASS" });
      await runService.completionStore().accept(run.capabilityRef!, {
        runId: run.id, role: run.role, output: JSON.parse(output),
      });
      const restarted = new RunService(db!, fakeRuntime);
      expect(restarted.reconcileInterruptedRuns()).toBe(1);

      const row = traceRow(run.id)!;
      expect(row.scenario).toBe("review-request");
      expect(row.usage_json).toBeNull();
      expect(row.created_at).toBe(db!.get<{ ended_at: string }>("SELECT ended_at FROM agent_runs WHERE id=$runId", { runId: run.id })!.ended_at);

      expect(() => Reflect.apply(
        (restarted as unknown as Record<string, unknown>)["recordCompletedRunTrace"] as (...args: unknown[]) => unknown,
        restarted,
        [run.id],
      )).not.toThrow();
      expect(db!.all("SELECT * FROM run_traces WHERE run_id=$runId", { runId: run.id })).toHaveLength(1);
      expect(traceRow(run.id)!.created_at).toBe(row.created_at);
    });

    it("keeps recovery completing when trace storage fails", async () => {
      const run = await recoveryFixture();
      const output = JSON.stringify({ version: "1", outcome: "PASS" });
      await runService.completionStore().accept(run.capabilityRef!, {
        runId: run.id, role: run.role, output: JSON.parse(output),
      });
      const failingStore: ITracingStore = { save: () => { throw new Error("storage down"); } };
      const restarted = new RunService(db!, fakeRuntime, undefined, undefined, undefined, failingStore);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(restarted.reconcileInterruptedRuns()).toBe(1);
        expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })!.status)
          .toBe("COMPLETED");
        expect(traceRow(run.id)).toBeUndefined();
        const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(logged).toContain("TRACE_STORE_FAILED");
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

describe("run control service transitions (plan-27 Task 3)", () => {
  let controlDb: Database | undefined;
  let controlTmp: string;
  let controlRuntime: FakeAgentRuntime & {
    pauseRun?: ReturnType<typeof vi.fn>;
    createCheckpoint?: ReturnType<typeof vi.fn>;
  };
  let controlService: RunService;
  let controlTaskId: string;
  let controlProjectId: string;

  beforeEach(() => {
    controlTmp = "";
  });

  afterEach(async () => {
    controlDb?.close();
    controlDb = undefined;
    if (controlTmp) await rm(controlTmp, { recursive: true, force: true });
  });

  async function setupControlDb(): Promise<Database> {
    controlTmp = await mkdtemp(join(tmpdir(), "orch-run-control-test-"));
    const database = createSqliteDatabase(join(controlTmp, `test-${randomUUID()}.db`));
    runMigrations(database, migrations);
    return database;
  }

  function controlPreparedContext(finalPrompt: string, role = "developer", subject: PreparedRunContext["subject"] = { type: "TASK", id: controlTaskId }): PreparedRunContext {
    return {
      finalPrompt, subject, role: role as PreparedRunContext["role"], contractDigest: null, items: [],
      contextBuilderVersion: "1.0.0",
      promptHash: digestRunPromptBytesV1(new TextEncoder().encode(finalPrompt)),
      contextHash: "b".repeat(64), initialTokenSize: null, workspaceFingerprint: "c".repeat(64),
    };
  }

  function controlContextInput(options: { taskId: string | null; epicId: string | null; role: string; prompt?: string }) {
    const subject = options.taskId !== null ? { type: "TASK" as const, id: options.taskId }
      : { type: "EPIC" as const, id: options.epicId ?? "epic-test" };
    return {
      prompt: options.prompt ?? "test caller prompt", subject,
      role: options.role.toLowerCase() as PreparedRunContext["role"], roleInputs: {},
      versions: { roleVersion: null, runtime: "default", runtimeVersion: null, model: "test", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1" },
      execution: {
        workspaceIdentity: { repository: "test-repository", workspace: "test-worktree", worktree: "test-worktree" },
        targetHead: null, targetBranch: null, effectiveCapabilityIds: effectiveRunToolIds(options.role, undefined, false),
        policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
      },
    };
  }

  async function setupControl(): Promise<void> {
    controlDb = await setupControlDb();
    controlProjectId = randomUUID();
    controlTaskId = randomUUID();
    const now = new Date().toISOString();
    controlDb.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'runtime','Runtime','ACTIVE',$now,$now)", { id: controlProjectId, now });
    controlDb.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'TASK-RUN','Runtime task','READY','{}',1,$now,$now)", { id: controlTaskId, projectId: controlProjectId, now });
    controlRuntime = new FakeAgentRuntime();
    controlService = new RunService(controlDb, controlRuntime as unknown as AgentRuntime, {
      prepare: (_tx, input) => controlPreparedContext(input.prompt, input.role, input.subject),
    });
    controlRuntime.cancelRun = async (runId) => {
      const owner = controlDb!.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId });
      if (owner?.state === "PREPARED") {
        controlDb!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
          runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
        }));
      }
    };
  }

  async function startControlRun() {
    return controlService.startRun({
      role: "reviewer", model: "default", taskId: controlTaskId, epicId: null,
      triggerReason: "review-request", contextVersion: "1", outputSchemaVersion: "1",
      capability: { workspace: controlTmp },
      contextInput: controlContextInput({ taskId: controlTaskId, epicId: null, role: "reviewer" }),
    });
  }

  /** Доводит Run до состояния, пригодного для pause: STOPPED owner, BOUND session, resume binding. */
  async function pauseReadyRun() {
    const run = await startControlRun();
    const owner = getRunProcessOwner(controlDb!, run.id)!;
    controlDb!.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LAUNCHING", nextState: "LIVE", identity:
        ownerIdentityForContainmentKind(owner.containmentKind) });
      tx.run("UPDATE agent_runs SET status='IN_PROGRESS',session_id='original-session' WHERE id=$runId", { runId: run.id });
      tx.run("UPDATE run_process_owners SET capture_state='BOUND' WHERE run_id=$runId", { runId: run.id });
      syncCurrentRunProcessGenerationTx(tx, run.id);
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LIVE", nextState: "STOPPED",
        evidence: stopEvidenceForContainmentKind(owner.containmentKind) });
      const contextHash = tx.get<{ context_hash: string }>("SELECT context_hash FROM context_manifests WHERE run_id=$runId", { runId: run.id })!.context_hash;
      tx.run(`INSERT INTO run_resume_bindings(run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,
        workspace_snapshot_hash,resume_binding_hash,original_session_id,created_at)
        VALUES($runId,1,$baseline,$contextHash,1,$workspaceHash,$bindingHash,'original-session',$now)`, {
        runId: run.id, contextHash, workspaceHash: "b".repeat(64), bindingHash: digestResumeBindingV1(contextHash, "b".repeat(64)),
        now: new Date().toISOString(),
        baseline: JSON.stringify(createResumeContextBaselineV1({
          ...controlContextInput({ taskId: controlTaskId, epicId: null, role: "reviewer" }).versions,
          promptHash: digestRunPromptBytesV1(new TextEncoder().encode(run.prompt!)), subjectType: "TASK", subjectId: controlTaskId,
          contractOrRequestDigest: null, items: [], contextBuilderVersion: "1.0.0", role: "reviewer",
          workspaceIdentity: { repository: controlTmp, workspace: controlTmp, worktree: controlTaskId }, targetHead: null, targetBranch: null,
          effectiveCapabilityIds: effectiveRunToolIds("reviewer"), projectConfigRevisionId: null, projectConfigHash: null,
          policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
        })),
      });
    });
    return run;
  }

  function markControlRunNeverLaunched(runId: string) {
    controlDb!.transaction((tx) => {
      const owner = tx.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId });
      if (owner?.state === "PREPARED") {
        transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED" });
      }
    });
  }

  it("pause persists a proven checkpoint and transitions to PAUSED without touching agent_runs.status", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => {});

    const result = await controlService.requestRunControl(run.id, "PAUSE", "req-pause-1");

    expect(result.status).toBe("COMPLETED");
    expect(result.control?.state).toBe("PAUSED");
    expect(result.control?.checkpointId).toBeTruthy();
    expect(controlDb!.get("SELECT status,session_id,attempt FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ status: "IN_PROGRESS", session_id: "original-session", attempt: null });
    const checkpoint = controlDb!.get("SELECT * FROM run_checkpoints WHERE run_id=$runId", { runId: run.id }) as Record<string, unknown> | undefined;
    expect(checkpoint!).toMatchObject({ session_id: "original-session", event_cursor: "", checkpoint_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(controlRuntime.pauseRun).toHaveBeenCalledWith(run.id);
    expect(controlDb!.all("SELECT * FROM outbox_events WHERE aggregate_id=$runId AND type='RunPaused'", { runId: run.id })).toHaveLength(1);
  });

  it("failed pause reverts to ACTIVE, leaves command FAILED and creates no checkpoint", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => { throw new Error("RUN_PAUSE_UNPROVEN"); });

    await expect(controlService.requestRunControl(run.id, "PAUSE", "req-pause-fail")).rejects.toThrow("RUN_PAUSE_UNPROVEN");

    expect(controlDb!.get("SELECT state FROM run_control_state WHERE run_id=$runId", { runId: run.id })?.state).toBe("ACTIVE");
    expect(controlDb!.get("SELECT status FROM run_control_commands WHERE request_id='req-pause-fail'"))
      .toMatchObject({ status: "FAILED" });
    expect(controlDb!.all("SELECT * FROM run_checkpoints WHERE run_id=$runId", { runId: run.id })).toHaveLength(0);
  });

  it("manual checkpoint cannot prove an in-process safe checkpoint and fails closed without changing control state", async () => {
    await setupControl();
    const run = await pauseReadyRun();

    const result = await controlService.requestRunControl(run.id, "CHECKPOINT", "req-cp-1");

    expect(result.status).toBe("FAILED");
    expect(result.failureCode).toBe("CHECKPOINT_UNPROVEN");
    expect(result.control?.state).toBe("ACTIVE");
    expect(controlDb!.all("SELECT * FROM run_checkpoints WHERE run_id=$runId", { runId: run.id })).toHaveLength(0);
  });

  it("duplicate request replay returns the stored outcome without re-executing the runtime", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => {});

    const first = await controlService.requestRunControl(run.id, "PAUSE", "req-replay");
    const replay = await controlService.requestRunControl(run.id, "PAUSE", "req-replay");

    expect(replay).toEqual(first);
    expect(controlRuntime.pauseRun).toHaveBeenCalledTimes(1);
    expect(controlDb!.all("SELECT * FROM run_control_commands WHERE request_id='req-replay'")).toHaveLength(1);
  });

  it("concurrent pause requests: exactly one wins; the second fails with a typed state conflict", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => {});

    const outcomes = await Promise.allSettled([
      controlService.requestRunControl(run.id, "PAUSE", "req-concurrent-1"),
      controlService.requestRunControl(run.id, "PAUSE", "req-concurrent-2"),
    ]);

    const fulfilled = outcomes.filter((entry) => entry.status === "fulfilled");
    const rejected = outcomes.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof controlService.requestRunControl>>>).value.control?.state).toBe("PAUSED");
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/RUN_CONTROL_STATE_CONFLICT|RUN_CONTROL_ALREADY_PAUSED/);
  });

  it("a confirmed terminal Run closes the control overlay and blocks further pause", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => {});
    await controlService.requestRunControl(run.id, "PAUSE", "req-pause-close");

    await controlService.cancelRun(run.id);

    expect(controlDb!.get("SELECT state FROM run_control_state WHERE run_id=$runId", { runId: run.id })?.state).toBe("CLOSED");
    await expect(controlService.requestRunControl(run.id, "PAUSE", "req-pause-terminal")).rejects.toThrow("RUN_CONTROL_TERMINAL");
  });

  it("resume performs validated admission, rotates the owner generation and relaunches under the same session", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => {});
    await controlService.requestRunControl(run.id, "PAUSE", "req-pause-resume");
    expect(controlDb!.get("SELECT current_generation FROM run_process_owners WHERE run_id=$runId", { runId: run.id })?.current_generation).toBe(1);

    const resumeSpy = vi.spyOn(controlRuntime, "resumeRun").mockImplementation(async (runId) => {
      expect(controlDb!.get("SELECT current_generation,state,capture_state FROM run_process_owners WHERE run_id=$runId", { runId })?.current_generation).toBe(2);
    });
    vi.spyOn(controlRuntime, "collectResult").mockImplementation(async (runId) => {
      const output = JSON.stringify({ version: "1", outcome: "PASS" });
      await controlService.completionStore().accept(controlService.getCapabilityReference(runId), {
        runId, role: "reviewer", output: JSON.parse(output),
      });
      markControlRunNeverLaunched(runId);
      return { success: true, exitCode: 0, output, validatedSubmission: true,
        diagnostics: { runId, sessionId: "original-session", stderr: "", exitCode: 0, artifactReferences: [] } };
    });
    vi.spyOn(controlRuntime, "collectUsage").mockResolvedValue({ inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, cost: 0.1 });

    const result = await controlService.requestRunControl(run.id, "RESUME", "req-resume-1");

    expect(result.status).toBe("COMPLETED");
    expect(result.control?.state).toBe("ACTIVE");
    expect(resumeSpy).toHaveBeenCalledWith(run.id, expect.objectContaining({ sessionId: "original-session", attempt: 1 }));
    expect(controlDb!.get("SELECT current_generation FROM run_process_owners WHERE run_id=$runId", { runId: run.id })?.current_generation).toBe(2);
    // Терминальный COMPLETED закрывает overlay.
    expect(controlDb!.get("SELECT state FROM run_control_state WHERE run_id=$runId", { runId: run.id })?.state).toBe("CLOSED");
  });

  it("failed resume returns to PAUSED, releases the new launch pre-generation and keeps the checkpoint", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => {});
    await controlService.requestRunControl(run.id, "PAUSE", "req-pause-failresume");
    vi.spyOn(controlRuntime, "resumeRun").mockImplementation(async () => { throw new Error("RESUME_LAUNCH_FAILED"); });

    await expect(controlService.requestRunControl(run.id, "RESUME", "req-resume-fail")).rejects.toThrow("RESUME_LAUNCH_FAILED");

    expect(controlDb!.get("SELECT state,checkpoint_id FROM run_control_state WHERE run_id=$runId", { runId: run.id }))
      .toMatchObject({ state: "PAUSED", checkpoint_id: expect.any(String) });
    expect(controlDb!.get("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId: run.id })?.state).toBe("STOPPED");
    expect(controlDb!.get("SELECT status FROM run_control_commands WHERE request_id='req-resume-fail'")?.status).toBe("FAILED");
  });

  it("preserves control durability across a service restart at the PAUSED boundary", async () => {
    await setupControl();
    const run = await pauseReadyRun();
    controlRuntime.pauseRun = vi.fn(async () => {});
    await controlService.requestRunControl(run.id, "PAUSE", "req-pause-restart");

    const restarted = new RunService(controlDb!, new FakeAgentRuntime(), {
      prepare: (_tx, input) => controlPreparedContext(input.prompt, input.role, input.subject),
    });
    expect(restarted.requestRunControl).toBeTypeOf("function");
    expect(controlDb!.get("SELECT state FROM run_control_state WHERE run_id=$runId", { runId: run.id })?.state).toBe("PAUSED");
    expect(controlDb!.all("SELECT * FROM run_checkpoints WHERE run_id=$runId", { runId: run.id })).toHaveLength(1);
  });
});
