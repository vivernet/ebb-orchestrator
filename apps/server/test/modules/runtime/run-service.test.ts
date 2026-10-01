import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { createRunContextInput, effectiveRunToolIds, RunService, RunTransitionConflictError } from "../../../src/modules/runtime/run-service.js";
import { FakeAgentRuntime } from "../../fakes/fake-agent-runtime.js";
import type { RunOutcome, StartRunOptions } from "../../../src/modules/runtime/run-types.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import type { PreparedRunContext } from "../../../src/modules/context/context-types.js";
import { transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";

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

  function execute(options: StartRunOptions) {
    return runService.execute(withTestContext(options));
  }

  function markFakeRunNeverLaunched(runId: string): void {
    db!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
    }));
  }

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
    const output = { version: "1.0.0", outcome: "COMPLETED" };
    await expect(store.accept(run.capabilityRef!, { runId: run.id, role: run.role, output })).resolves.toBe(true);
    await expect(store.accept(run.capabilityRef!, { runId: run.id, role: run.role, output })).resolves.toBe(false);
    expect(db!.get<{ status: string; output: string }>("SELECT status, output FROM agent_runs WHERE id = $id", { id: run.id }))
      .toEqual({ status: "COMPLETING", output: JSON.stringify(output) });
  });

  it("resumes an in-progress run", async () => {
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

    const resumedRun = await runService.resumeRun(startedRun.id, {
      sessionId: "session-123",
      attempt: 1,
    });

    expect(resumedRun.status).toBe("IN_PROGRESS");
    expect(resumedRun.sessionId).toBe("session-123");
    expect(resumedRun.attempt).toBe(1);
    expect(fakeRuntime.resumeCalls).toEqual([{ runId: startedRun.id, options: { sessionId: "session-123", attempt: 1 } }]);
    expect(db!.get<{ status: string; session_id: string; attempt: number }>(
      "SELECT status, session_id, attempt FROM agent_runs WHERE id = $id", { id: startedRun.id },
    )).toEqual({ status: "IN_PROGRESS", session_id: "session-123", attempt: 1 });
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

    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
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

  it.each([
    ["missing", null],
    ["malformed", "invalid evidence!"],
  ])("keeps a completing Run nonterminal when persisted STOPPED evidence is %s", async (_label, evidence) => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    });
    const output = { version: "1.0.0", outcome: "COMPLETED" };
    await runService.completionStore().accept(run.capabilityRef!, { runId: run.id, role: run.role, output });
    db!.run("UPDATE run_process_owners SET state='STOPPED',stop_evidence=$evidence WHERE run_id=$runId", {
      runId: run.id, evidence,
    });

    await expect(runService.collectResult(run.id, {
      success: true, exitCode: 0, output: JSON.stringify(output), validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    })).rejects.toThrow(`RUN_PROCESS_SCOPE_STOP_UNPROVEN:${run.id}`);

    expect(db!.get<{ status: string; capability_ref: string | null }>(
      "SELECT status,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id },
    )).toMatchObject({ status: "COMPLETING", capability_ref: run.capabilityRef });
  });

  it("rejects an artifact or adapter outcome that is not the authenticated submission", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    });
    const accepted = { version: "1.0.0", outcome: "COMPLETED" };
    await runService.completionStore().accept(run.capabilityRef!, { runId: run.id, role: run.role, output: accepted });
    markFakeRunNeverLaunched(run.id);
    await expect(runService.collectResult(run.id, {
      success: true, exitCode: 0, output: JSON.stringify({ version: "1.0.0", outcome: "FAILED" }),
      validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "forged", exitCode: 0, artifactReferences: [] },
    })).rejects.toThrow(/matching the authenticated submission/);
  });

  it("requires COMPLETING status even when an outcome claims validation", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
    await expect(runService.collectResult(run.id, {
      success: true, exitCode: 0, output, validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    })).rejects.toThrow(/COMPLETING/);
  });

  it("uses scripted outcomes from FakeAgentRuntime", async () => {
    await setup();
    fakeRuntime.script("developer", [
      { success: true, exitCode: 0, output: "Code generated" },
    ]);

    const run = await startRun({
      role: "developer",
      model: "gpt-4",
      taskId,
      epicId,
      triggerReason: "task-assignment",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    const result = await fakeRuntime.collectResult(run.id);
    expect(result.output).toBe("Code generated");
    expect(result.success).toBe(true);
  });

  it("fails when no scripted outcome is available", async () => {
    await setup();
    const run = await startRun({
      role: "developer",
      model: "gpt-4",
      taskId,
      epicId,
      triggerReason: "test-assignment",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    await expect(() => fakeRuntime.collectResult(run.id)).rejects.toThrow(/No scripted outcome available/);
  });

  it("atomically fails and revokes capability when runtime launch fails on start", async () => {
    await setup();
    fakeRuntime.startRun = async () => { throw new Error("launcher unavailable"); };

    await expect(startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    })).rejects.toThrow("launcher unavailable");

    expect(db!.get<{ status: string; ended_at: string | null; capability_ref: string | null; capability_json: string | null; output: string }>(
      "SELECT status, ended_at, capability_ref, capability_json, output FROM agent_runs ORDER BY started_at DESC LIMIT 1",
    )).toMatchObject({ status: "FAILED", capability_ref: null, capability_json: null, output: "Error: launcher unavailable" });
  });

  it("retains the active Run and capability when process stop is unproven", async () => {
    await setup();
    let startDispatches = 0;
    fakeRuntime.startRun = async (run) => {
      startDispatches += 1;
      db!.transaction((tx) => {
        transitionRunProcessOwnerTx(tx, {
          runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING",
        });
        transitionRunProcessOwnerTx(tx, {
          runId: run.id, expectedState: "LAUNCHING", nextState: "UNKNOWN", evidence: "OS_STATE_UNPROVEN",
        });
      });
      throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
    };

    await expect(startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    })).rejects.toThrow("PROCESS_SCOPE_STOP_UNPROVEN");

    const stored = db!.get<{
      status: string; ended_at: string | null; capability_ref: string | null; capability_json: string | null;
    }>("SELECT status,ended_at,capability_ref,capability_json FROM agent_runs ORDER BY started_at DESC LIMIT 1");
    expect(stored?.status).toBe("STARTED");
    expect(stored?.ended_at).toBeNull();
    expect(stored?.capability_ref).not.toBeNull();
    expect(stored?.capability_json).not.toBeNull();
    expect(db!.get<{ state: string }>("SELECT state FROM run_process_owners ORDER BY updated_at DESC LIMIT 1")?.state)
      .toBe("UNKNOWN");

    await expect(runService.executePreparedRun(
      db!.get<{ id: string }>("SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT 1")!.id,
    )).rejects.toThrow("RUN_PROCESS_OWNER_UNAVAILABLE");
    expect(startDispatches).toBe(1);
  });

  it("atomically fails and revokes capability when runtime launch fails on resume", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    });
    fakeRuntime.resumeRun = async () => { throw new Error("resume launcher unavailable"); };

    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: 1 }))
      .rejects.toThrow("resume launcher unavailable");
    expect(db!.get<{ status: string; ended_at: string | null; capability_ref: string | null; capability_json: string | null }>(
      "SELECT status, ended_at, capability_ref, capability_json FROM agent_runs WHERE id = $id", { id: run.id },
    )).toMatchObject({ status: "FAILED", capability_ref: null, capability_json: null });
  });

  it("marks the same authoritative run failed when execution cannot produce validated evidence", async () => {
    await setup();
    const runId = randomUUID();
    fakeRuntime.script("developer", [{ success: false, exitCode: 1, output: "runtime failed" }]);

    await expect(execute({
      runId,
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "epic-plan",
      contextVersion: "1", outputSchemaVersion: "1",
    })).rejects.toThrow(/COMPLETING/);

    expect(db!.get<{ count: number; id: string; status: string }>(
      "SELECT COUNT(*) AS count, MAX(id) AS id, MAX(status) AS status FROM agent_runs WHERE id = $id", { id: runId },
    )).toEqual({ count: 1, id: runId, status: "FAILED" });
  });

  it("rejects resuming runs in terminal state COMPLETED", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    // Complete the run
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
    await runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: JSON.parse(output),
    });
    markFakeRunNeverLaunched(run.id);
    await runService.collectResult(run.id, {
      success: true, exitCode: 0, output, validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    });
    // Try to resume - should fail
    await expect(runService.resumeRun(run.id, { sessionId: "session-123", attempt: 2 }))
      .rejects.toThrow(/terminal state/);
  });

  it("rejects resuming runs in terminal state FAILED", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    // Fail the run
    fakeRuntime.resumeRun = async () => { throw new Error("forced failure"); };
    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: 1 }))
      .rejects.toThrow("forced failure");
    // Now try to reopen the failed run - should fail
    await expect(runService.resumeRun(run.id, { sessionId: "session-456", attempt: 2 }))
      .rejects.toThrow(/terminal state/);
  });

  it("rejects resuming runs in terminal state CANCELLED", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    // Cancel the run
    await runService.cancelRun(run.id);
    // Try to reopen - should fail
    await expect(runService.resumeRun(run.id, { sessionId: "session-789", attempt: 1 }))
      .rejects.toThrow(/terminal state/);
  });

  it("rejects resuming runs with invalid attempt (<=0)", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: 0 }))
      .rejects.toThrow(/Attempt must be a positive integer/);
    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: -1 }))
      .rejects.toThrow(/Attempt must be a positive integer/);
  });

  it("rejects non-integer attempts and empty runtime sessions before dispatch", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });

    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: 1.5 }))
      .rejects.toThrow(/Attempt must be a positive integer/);
    await expect(runService.resumeRun(run.id, { sessionId: "  ", attempt: 1 }))
      .rejects.toThrow(/session ID/);
    expect(fakeRuntime.resumeCalls).toEqual([]);
  });

  it("rejects resume when the stored capability is missing or inconsistent", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    db!.run("UPDATE agent_runs SET capability_json = NULL WHERE id = $id", { id: run.id });

    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: 1 }))
      .rejects.toThrow(/active capability/);
    expect(fakeRuntime.resumeCalls).toEqual([]);
  });

  it("rejects resume after a validated result has entered COMPLETING", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: { version: "1.0.0", outcome: "COMPLETED" },
    });

    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: 1 }))
      .rejects.toThrow(/cannot be resumed/);
    expect(fakeRuntime.resumeCalls).toEqual([]);
    expect(db!.get<{ status: string; attempt: number | null }>(
      "SELECT status, attempt FROM agent_runs WHERE id = $id", { id: run.id },
    )).toEqual({ status: "COMPLETING", attempt: null });
  });

  it("serializes concurrent resumes so one attempt dispatches only once", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });

    const outcomes = await Promise.allSettled([
      runService.resumeRun(run.id, { sessionId: "session-1", attempt: 1 }),
      runService.resumeRun(run.id, { sessionId: "session-duplicate", attempt: 1 }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const repeated = await runService.resumeRun(run.id, { sessionId: "session-1", attempt: 1 });
    expect(repeated.status).toBe("IN_PROGRESS");
    await expect(runService.resumeRun(run.id, { sessionId: "session-stale", attempt: 0 }))
      .rejects.toThrow(/Attempt must be a positive integer/);
    expect(fakeRuntime.resumeCalls).toHaveLength(1);
  });

  it("returns a typed conflict when a terminal run is resumed", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await runService.cancelRun(run.id);

    await expect(runService.resumeRun(run.id, { sessionId: "session", attempt: 1 }))
      .rejects.toBeInstanceOf(RunTransitionConflictError);
  });

  it("allows resuming runs in STARTED state", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    const resumed = await runService.resumeRun(run.id, { sessionId: "session-123", attempt: 1 });
    expect(resumed.status).toBe("IN_PROGRESS");
    expect(resumed.sessionId).toBe("session-123");
    expect(resumed.attempt).toBe(1);
  });

  it("allows resuming runs in IN_PROGRESS state", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await runService.resumeRun(run.id, { sessionId: "session-1", attempt: 1 });
    // Resume again - should work
    const resumed = await runService.resumeRun(run.id, { sessionId: "session-2", attempt: 2 });
    expect(resumed.status).toBe("IN_PROGRESS");
    expect(resumed.sessionId).toBe("session-2");
    expect(resumed.attempt).toBe(2);
  });

  it("executes a prepared run without creating a second AgentRun", async () => {
    await setup();
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
    fakeRuntime.script("developer", [{ success: true, exitCode: 0, output }]);
    const run = prepareRun({
      runId: randomUUID(), role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "epic-plan", contextVersion: "1", outputSchemaVersion: "1",
      prompt: "prepared prompt",
    });
    await expect(runService.executePreparedRun(run.id)).rejects.toThrow(/COMPLETING/);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE id=$id", { id: run.id })?.count).toBe(1);
    expect(db!.get<{ status: string; prompt: string }>("SELECT status,prompt FROM agent_runs WHERE id=$id", { id: run.id }))
      .toEqual({ status: "FAILED", prompt: "prepared prompt" });
  });

  it("fails non-terminal runs during startup recovery and clears capabilities", async () => {
    await setup();
    const run = prepareRun({
      runId: randomUUID(), role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "epic-plan", contextVersion: "1", outputSchemaVersion: "1",
    });
    db!.run("UPDATE agent_runs SET status='IN_PROGRESS' WHERE id=$id", { id: run.id });

    expect(runService.reconcileInterruptedRuns()).toBe(1);
    expect(db!.get<{ status: string; capability_ref: string | null; output: string }>(
      "SELECT status, capability_ref, output FROM agent_runs WHERE id=$id", { id: run.id },
    )).toEqual({ status: "FAILED", capability_ref: null, output: "Run interrupted by orchestrator restart" });
    expect(runService.reconcileInterruptedRuns()).toBe(0);
  });

  // RED Tests for State Transition Matrix
  it("transition matrix: STARTED -> IN_PROGRESS via resume", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    expect(run.status).toBe("STARTED");

    const resumed = await runService.resumeRun(run.id, { sessionId: "s1", attempt: 1 });
    expect(resumed.status).toBe("IN_PROGRESS");
  });

  it("transition matrix: IN_PROGRESS -> IN_PROGRESS via resume (retry)", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await runService.resumeRun(run.id, { sessionId: "s1", attempt: 1 });

    const resumed = await runService.resumeRun(run.id, { sessionId: "s2", attempt: 2 });
    expect(resumed.status).toBe("IN_PROGRESS");
    expect(resumed.attempt).toBe(2);
  });

  it("transition matrix: COMPLETING -> COMPLETED via collectResult", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
    await runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: JSON.parse(output),
    });
    markFakeRunNeverLaunched(run.id);
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })!.status)
      .toBe("COMPLETING");

    await runService.collectResult(run.id, {
      success: true, exitCode: 0, output, validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    });
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })!.status)
      .toBe("COMPLETED");
  });

  it("transition matrix: any non-terminal -> FAILED on runtime error", async () => {
    await setup();
    fakeRuntime.startRun = async () => { throw new Error("crash"); };
    await expect(startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    })).rejects.toThrow("crash");
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs ORDER BY started_at DESC LIMIT 1")?.status)
      .toBe("FAILED");
  });

  it("transition matrix: any non-terminal -> CANCELLED via cancelRun", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await runService.cancelRun(run.id);
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })!.status)
      .toBe("CANCELLED");
  });

  it("keeps a Run nonterminal when runtime cancellation returns without durable STOPPED proof", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    let releaseCancel!: () => void;
    fakeRuntime.cancelRun = async () => new Promise<void>((resolve) => { releaseCancel = resolve; });

    const cancelling = runService.cancelRun(run.id);
    await Promise.resolve();
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })?.status)
      .toBe("STARTED");
    releaseCancel();
    await expect(cancelling).rejects.toThrow(`RUN_PROCESS_SCOPE_STOP_UNPROVEN:${run.id}`);

    expect(db!.get<{ status: string; capability_ref: string | null }>(
      "SELECT status,capability_ref FROM agent_runs WHERE id=$id", { id: run.id },
    )).toMatchObject({ status: "STARTED", capability_ref: run.capabilityRef });
    expect(db!.get<{ state: string; stop_evidence: string | null }>(
      "SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$id", { id: run.id },
    )).toEqual({ state: "PREPARED", stop_evidence: null });
  });

  it("does not cancel a Run when STOPPED evidence is malformed", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    fakeRuntime.cancelRun = async (runId) => {
      db!.run("UPDATE run_process_owners SET state='STOPPED',stop_evidence='invalid evidence!' WHERE run_id=$runId", { runId });
    };

    await expect(runService.cancelRun(run.id)).rejects.toThrow(`RUN_PROCESS_SCOPE_STOP_UNPROVEN:${run.id}`);
    expect(db!.get<{ status: string; capability_ref: string | null }>(
      "SELECT status,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id },
    )).toMatchObject({ status: "STARTED", capability_ref: run.capabilityRef });
  });

  it.each([
    ["missing", null],
    ["malformed", "invalid evidence!"],
  ])("does not fail a Run when persisted STOPPED evidence is %s", async (_label, evidence) => {
    await setup();
    const run = prepareRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    db!.run("UPDATE run_process_owners SET state='STOPPED',stop_evidence=$evidence WHERE run_id=$runId", {
      runId: run.id, evidence,
    });

    runService.failPreparedRun(run.id, new Error("injected runtime failure"));

    expect(db!.get<{ status: string; capability_ref: string | null }>(
      "SELECT status,capability_ref FROM agent_runs WHERE id=$runId", { runId: run.id },
    )).toMatchObject({ status: "STARTED", capability_ref: run.capabilityRef });
  });

  it.each([
    ["missing", null],
    ["malformed", "invalid evidence!"],
  ])("does not authorize cleanup of a terminal Run when STOPPED evidence is %s", async (_label, evidence) => {
    await setup();
    const run = prepareRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    db!.run("UPDATE run_process_owners SET state='STOPPED',stop_evidence=$evidence WHERE run_id=$runId", {
      runId: run.id, evidence,
    });
    db!.run("UPDATE agent_runs SET status='FAILED',ended_at=$now WHERE id=$runId", { runId: run.id, now: new Date().toISOString() });

    expect(runService.failPreparedRun(run.id, new Error("integration cleanup retry"))).toBe(false);
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: run.id })?.status).toBe("FAILED");
  });

  it("allows terminal cleanup only when the persisted owner has canonical STOPPED evidence", async () => {
    await setup();
    const run = prepareRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    db!.run("UPDATE run_process_owners SET state='STOPPED',stop_evidence='SUPERVISOR_SCOPE_EMPTY' WHERE run_id=$runId", { runId: run.id });
    db!.run("UPDATE agent_runs SET status='FAILED',ended_at=$now WHERE id=$runId", { runId: run.id, now: new Date().toISOString() });

    expect(runService.failPreparedRun(run.id, new Error("integration cleanup retry"))).toBe(true);
  });

  it("transition matrix: CANCELLED is immutable (cannot resume)", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    await runService.cancelRun(run.id);
    await expect(runService.resumeRun(run.id, { sessionId: "s1", attempt: 1 }))
      .rejects.toThrow(/terminal state/);
  });

  it("transition matrix: COMPLETED is immutable (cannot resume)", async () => {
    await setup();
    const run = await startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
    await runService.completionStore().accept(run.capabilityRef!, {
      runId: run.id, role: run.role, output: JSON.parse(output),
    });
    markFakeRunNeverLaunched(run.id);
    await runService.collectResult(run.id, {
      success: true, exitCode: 0, output, validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    });
    await expect(runService.resumeRun(run.id, { sessionId: "s1", attempt: 1 }))
      .rejects.toThrow(/terminal state/);
  });

  it("transition matrix: FAILED is immutable (cannot resume)", async () => {
    await setup();
    fakeRuntime.startRun = async () => { throw new Error("crash"); };
    await expect(startRun({
      role: "developer", model: "gpt-4", taskId, epicId,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
    })).rejects.toThrow("crash");
    await expect(runService.resumeRun(db!.get<{ id: string }>("SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT 1")!.id, { sessionId: "s1", attempt: 1 }))
      .rejects.toThrow(/terminal state/);
  });
});
