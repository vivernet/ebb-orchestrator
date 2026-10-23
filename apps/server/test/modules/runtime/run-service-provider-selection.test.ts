import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import type { Database, DatabaseTx } from "../../../src/platform/database/database.js";
import { RunService, createRunContextInput } from "../../../src/modules/runtime/run-service.js";
import type { StartRunOptions } from "../../../src/modules/runtime/run-types.js";
import type { AgentRuntime, AgentRuntimeRun } from "../../../src/modules/runtime/agent-runtime.js";
import type { RunOutcome } from "../../../src/modules/runtime/run-types.js";
import { SqliteProviderSettingsRepository, type RunProviderSelectionRecord } from "../../../src/modules/runtime/providers/provider-settings-repository.js";
import { RunProviderSelectionError } from "../../../src/modules/runtime/providers/run-provider-selection.js";
import { DatabaseCompletionStore } from "../../../src/modules/execution/mcp/submit-result-tool.js";
import { digestRunContextV1, digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import type { ContextFingerprintInputV1, PreparedRunContext } from "../../../src/modules/context/context-types.js";
import { getRunProcessOwner, transitionRunProcessOwnerTx, syncCurrentRunProcessGenerationTx, rotateRunProcessOwnerForResumeTx } from "../../../src/modules/runtime/run-process-owner.js";
import { ownerIdentityForContainmentKind, stopEvidenceForContainmentKind } from "../../helpers/run-process-owner-fixture.js";
import { markFakeRunNeverLaunched } from "../../helpers/fake-run-process-owner.js";
import { seedApprovedProjectConfig } from "../../helpers/approved-project-config.js";

const migrations = loadTestMigrations();
const CONTEXT_BUILDER_VERSION = "1.0.0";

function expectProviderCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected RunProviderSelectionError to be thrown");
  } catch (error) {
    if (!(error instanceof RunProviderSelectionError)) {
      throw new Error(
        `expected RunProviderSelectionError, got ${(error as Error)?.constructor?.name ?? typeof error}: ${(error as Error)?.message}`,
        { cause: error },
      );
    }
    expect(error).toMatchObject({ code });
  }
}

function seedProvider(db: Database, overrides: { enabled?: boolean; defaultModelId?: string | null; roleDefaults?: Record<string, string> } = {}) {
  const repository = new SqliteProviderSettingsRepository(db);
  db.run("DELETE FROM provider_credentials WHERE provider_id='openai'");
  db.run("INSERT OR REPLACE INTO secrets(reference_id,service,name,created_at,updated_at) VALUES('ref-prov-1','ai-provider','prov:openai:api-key',0,0)");
  const record = repository.saveProviderConfiguration({
    providerId: "openai", enabled: overrides.enabled ?? true, selectedAuthMethod: "api-key", config: {},
    modelSelection: { defaultModelId: overrides.defaultModelId ?? "gpt-4o", roleDefaults: overrides.roleDefaults ?? {} },
  });
  repository.attachCredentialMetadata({
    providerId: "openai", authMethodId: "api-key",
    secretName: "prov:openai:api-key", referenceId: "ref-prov-1",
    status: "ACTIVE", now: new Date().toISOString(),
  });
  return record;
}

function validFingerprint(input: ReturnType<typeof createRunContextInput>): ContextFingerprintInputV1 {
  return {
    promptHash: digestRunPromptBytesV1(new TextEncoder().encode(input.prompt)),
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    contractOrRequestDigest: null,
    items: [],
    contextBuilderVersion: CONTEXT_BUILDER_VERSION,
    role: input.role,
    ...input.versions,
    workspaceIdentity: input.execution.workspaceIdentity,
    targetHead: input.execution.targetHead,
    targetBranch: input.execution.targetBranch,
    effectiveCapabilityIds: input.execution.effectiveCapabilityIds,
    projectConfigRevisionId: null,
    projectConfigHash: null,
    policyIdentity: input.execution.policyIdentity,
  };
}

function stubAssembler() {
  return {
    prepare: (_tx: DatabaseTx, input: ReturnType<typeof createRunContextInput>): PreparedRunContext => {
      const fingerprintInput = validFingerprint(input);
      return {
        finalPrompt: input.prompt,
        subject: input.subject,
        role: input.role,
        contractDigest: null,
        items: [],
        contextBuilderVersion: CONTEXT_BUILDER_VERSION,
        promptHash: fingerprintInput.promptHash,
        contextHash: digestRunContextV1(fingerprintInput),
        initialTokenSize: null,
        workspaceFingerprint: "x".repeat(64),
        fingerprintInput,
      };
    },
  };
}

function providerRuntime(
  db: Database,
  startCalls: AgentRuntimeRun[] = [],
  resumeCalls: Array<{ runId: string; options: { sessionId: string; attempt: number; providerSelection?: RunProviderSelectionRecord } }> = [],
  supports = true,
  autoComplete = true,
): AgentRuntime {
  const completion = new DatabaseCompletionStore(db);
  return {
    active: 0,
    maxActive: 0,
    calls: [],
    supportsProviderSelections: supports,
    async startRun(run) {
      startCalls.push(run);
      if (!autoComplete) return;
      markFakeRunNeverLaunched(db, run.id);
      const accepted = await completion.accept(run.capabilityRef!, {
        runId: run.id, role: run.role,
        output: { version: "1", outcome: "COMPLETED", commitSha: "test-commit-sha" },
      });
      if (!accepted) throw new Error("test runtime could not submit a prepared run result");
    },
    async resumeRun(runId, options) { resumeCalls.push({ runId, options }); },
    async cancelRun() {},
    async inspectRun() { throw new Error("not implemented"); },
    async collectResult(runId): Promise<RunOutcome> {
      const output = completion.getSubmission(runId)?.output;
      if (!output) throw new Error(`No submitted result for ${runId}`);
      return { success: true, exitCode: 0, output, validatedSubmission: true,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
    },
    async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
    async runResult(runId) { return this.collectResult(runId); },
    async healthCheck() { return true; },
  };
}

describe("RunService durable provider selection (plan-24 Task 5)", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let taskId: string;
  let projectId: string;
  let workspace: string;
  let startCalls: AgentRuntimeRun[];
  let resumeCalls: Array<{ runId: string; options: { sessionId: string; attempt: number; providerSelection?: RunProviderSelectionRecord } }>;

  beforeEach(() => { tmpDir = ""; });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(): Promise<RunService> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-provider-selection-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, migrations);
    projectId = randomUUID();
    taskId = randomUUID();
    workspace = join(tmpDir, "repository");
    await mkdir(workspace);
    const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe", windowsHide: true });
    git(["init", "-b", "master"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "# Test\n", "utf8");
    git(["add", "README.md"]);
    git(["commit", "-m", "init"]);
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId, now });
    seedApprovedProjectConfig(db, projectId);
    startCalls = [];
    resumeCalls = [];
    const runtime = providerRuntime(db, startCalls, resumeCalls);
    return new RunService(db, runtime, stubAssembler() as never);
  }

  function options(role = "developer"): StartRunOptions {
    const base: StartRunOptions = {
      role, model: "default", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "1", outputSchemaVersion: "1",
      capability: { workspace },
    };
    return { ...base, contextInput: createRunContextInput(base, {
      prompt: "caller prompt", roleInputs: {},
      workspaceIdentity: { repository: workspace, workspace, worktree: taskId },
      targetHead: null, targetBranch: null,
    }) };
  }

  function resumableProviderRun(runId: string): void {
    const owner = getRunProcessOwner(db!, runId)!;
    db!.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "LAUNCHING", nextState: "LIVE", identity: ownerIdentityForContainmentKind(owner.containmentKind) });
      tx.run("UPDATE agent_runs SET status='IN_PROGRESS',session_id='original-session' WHERE id=$runId", { runId });
      tx.run("UPDATE run_process_owners SET capture_state='BOUND' WHERE run_id=$runId", { runId });
      syncCurrentRunProcessGenerationTx(tx, runId);
      transitionRunProcessOwnerTx(tx, { runId, expectedState: "LIVE", nextState: "STOPPED", evidence: stopEvidenceForContainmentKind(owner.containmentKind) });
      // Биндинг уже создан в той же транзакции, что и Run (производственный путь);
      // фиксируем только исходную сессию. Baseline содержит providerSelection из fingerprint.
      const existing = tx.get("SELECT run_id FROM run_resume_bindings WHERE run_id=$runId", { runId });
      expect(existing).toBeDefined();
      tx.run("UPDATE run_resume_bindings SET original_session_id='original-session' WHERE run_id=$runId", { runId });
    });
  }

  it("preserves the legacy default path when no provider configuration exists", async () => {
    const runService = await setup();
    const run = runService.prepareRun(options());
    expect(db!.get("SELECT * FROM run_provider_selections WHERE run_id=$id", { id: run.id })).toBeUndefined();
    expect(startCalls).toHaveLength(0);
    expect(run.model).toBe("default");
    const manifest = db!.get<{ context_builder_version: string }>("SELECT context_builder_version FROM context_manifests WHERE run_id=$id", { id: run.id });
    expect(manifest?.context_builder_version).toBe(CONTEXT_BUILDER_VERSION);
  });

  it("binds the global default in the same transaction as the Run and passes it to the runtime", async () => {
    const runService = await setup();
    seedProvider(db!);
    const run = runService.prepareRun(options());
    expect(db!.get("SELECT run_id,provider_id,model_id,auth_method_id,config_revision FROM run_provider_selections WHERE run_id=$id", { id: run.id }))
      .toEqual({ run_id: run.id, provider_id: "openai", model_id: "gpt-4o", auth_method_id: "api-key", config_revision: 1 });
    const { run: executed } = await runService.executePreparedRun(run.id);
    expect(executed.status).toBe("COMPLETED");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.providerSelection).toMatchObject({
      runId: run.id, providerId: "openai", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 1,
    });
  });

  it("prefers the exact role default over the global default", async () => {
    const runService = await setup();
    seedProvider(db!, { roleDefaults: { developer: "gpt-4o-mini" } });
    const run = runService.prepareRun(options());
    expect(db!.get<{ model_id: string }>("SELECT model_id FROM run_provider_selections WHERE run_id=$id", { id: run.id })?.model_id)
      .toBe("gpt-4o-mini");
  });

  it("explicit Run override wins over defaults", async () => {
    const runService = await setup();
    seedProvider(db!, { defaultModelId: "gpt-4o" });
    const run = runService.prepareRun({ ...options(), providerSelection: { providerId: "openai", modelId: "gpt-4o-mini" } });
    expect(db!.get<{ model_id: string }>("SELECT model_id FROM run_provider_selections WHERE run_id=$id", { id: run.id })?.model_id)
      .toBe("gpt-4o-mini");
  });

  it("treats a disabled provider with defaults as legacy (no default candidate) and fails closed on explicit selection", async () => {
    const runService = await setup();
    seedProvider(db!, { enabled: false });
    const run = runService.prepareRun(options());
    expect(db!.get("SELECT * FROM run_provider_selections WHERE run_id=$id", { id: run.id })).toBeUndefined();
    expectProviderCode(() => runService.prepareRun({ ...options(), providerSelection: { providerId: "openai" } }), "RUN_REQUEST_PROVIDER_DISABLED");
    expect(db!.all("SELECT * FROM run_provider_selections")).toEqual([]);
  });

  it("fails closed on a missing credential before any durable write", async () => {
    const runService = await setup();
    new SqliteProviderSettingsRepository(db!).saveProviderConfiguration({
      providerId: "openai", enabled: true, selectedAuthMethod: "api-key", config: {},
      modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
    });
    expectProviderCode(() => runService.prepareRun(options()), "RUN_REQUEST_PROVIDER_CREDENTIAL_MISSING");
    expect(db!.all("SELECT * FROM agent_runs")).toEqual([]);
    expect(db!.all("SELECT * FROM run_provider_selections")).toEqual([]);
  });

  it("fails closed on an unknown explicit provider before any durable write", async () => {
    const runService = await setup();
    expectProviderCode(() => runService.prepareRun({ ...options(), providerSelection: { providerId: "nope" } }), "RUN_REQUEST_PROVIDER_UNKNOWN");
    expect(db!.all("SELECT * FROM agent_runs")).toEqual([]);
  });

  it("fails closed when the runtime does not support provider selections", async () => {
    await setup();
    seedProvider(db!);
    const unsupported = new RunService(db!, providerRuntime(db!, [], [], false), stubAssembler() as never);
    expect(() => unsupported.prepareRun(options())).toThrow("PROVIDER_RUN_SELECTION_UNSUPPORTED_BY_RUNTIME");
    expect(db!.all("SELECT * FROM agent_runs")).toEqual([]);
    expect(db!.all("SELECT * FROM run_provider_selections")).toEqual([]);
  });

  it("includes only stable provider/model/auth/config-revision IDs in the context fingerprint", async () => {
    const runService = await setup();
    seedProvider(db!);
    const run = runService.prepareRun(options());
    const manifest = db!.get<{ context_builder_version: string; context_hash: string }>(
      "SELECT context_builder_version,context_hash FROM context_manifests WHERE run_id=$id", { id: run.id });
    expect(manifest?.context_builder_version).toBe("1.0.2");
    const baseline = db!.get<{ baseline_jcs: string }>("SELECT baseline_jcs FROM run_resume_bindings WHERE run_id=$id", { id: run.id });
    expect(baseline).toBeDefined();
    expect(baseline!.baseline_jcs).toContain('"providerSelection"');
    expect(baseline!.baseline_jcs).toContain("openai");
    expect(baseline!.baseline_jcs).not.toContain("api-key_value");
    expect(baseline!.baseline_jcs).not.toContain("sk-");
    expect(baseline!.baseline_jcs).not.toContain("https://");
    expect(baseline!.baseline_jcs).not.toContain("endpoint");
  });

  it("enforces a deterministic context mismatch when defaults change between preflight and dispatch", async () => {
    const runService = await setup();
    seedProvider(db!, { defaultModelId: "gpt-4o" });
    const preflightOptions = options();
    const prepared = runService.prepareRunContext(preflightOptions);
    seedProvider(db!, { defaultModelId: "gpt-4o-mini" });
    expect(() => db!.transaction((tx) => runService.prepareRunInTransaction(
      tx, { ...preflightOptions, prompt: prepared.finalPrompt }, prepared,
    ))).toThrow("PREPARED_CONTEXT_CHANGED_WITHIN_TRANSACTION");
    const run = runService.prepareRun(options());
    expect(db!.get<{ model_id: string }>("SELECT model_id FROM run_provider_selections WHERE run_id=$id", { id: run.id })?.model_id)
      .toBe("gpt-4o-mini");
  });

  it("loads the original provider selection from SQLite on resume and never accepts caller overrides", async () => {
    await setup();
    seedProvider(db!);
    const initialService = new RunService(db!, providerRuntime(db!, startCalls, resumeCalls, true, false), stubAssembler() as never);
    const run = await initialService.startRun(options());
    resumableProviderRun(run.id);
    const restarted = new RunService(db!, providerRuntime(db!, [], resumeCalls, true, false), stubAssembler() as never, {
      verifyContext: async () => {},
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); },
    });
    const before = resumeCalls.length;
    await expect(restarted.resumeRun(run.id, { attempt: 1 })).rejects.toThrow(/No submitted result/);
    const call = resumeCalls[before];
    expect(call).toBeDefined();
    expect(call!.options.providerSelection).toMatchObject({
      providerId: "openai", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 1,
    });
  });

  it("reconciles an interrupted provider run as unsuccessful without replaying a paid request", async () => {
    await setup();
    seedProvider(db!);
    const initialService = new RunService(db!, providerRuntime(db!, startCalls, resumeCalls, true, false), stubAssembler() as never);
    const run = await initialService.startRun(options());
    resumableProviderRun(run.id);
    const runtime = providerRuntime(db!, startCalls, [], true, false);
    runtime.resumeRun = async () => { throw new Error("PROVIDER_RESUME_UNAVAILABLE"); };
    const restarted = new RunService(db!, runtime, stubAssembler() as never, {
      verifyContext: async () => {},
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); },
    });
    await expect(restarted.resumeRun(run.id, { attempt: 1 })).rejects.toThrow("PROVIDER_RESUME_UNAVAILABLE");
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id })?.status).toBe("FAILED");
    // Повторного платного запроса нет: startRun не вызывался повторно.
    expect(startCalls).toHaveLength(1);
  });
});
