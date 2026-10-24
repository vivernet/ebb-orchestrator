/**
 * Integration acceptance: dispatch Runs с выбором провайдера через
 * ProviderAgentRuntime и сетевой шлюз (plan-24 Task 7).
 *
 * Сценарии (без реальных провайдеров): mock-апстрим на loopback (127.0.0.1)
 * принимает реальные HTTP-запросы шлюза; провайдер `ollama` объявляет
 * local-endpoint поддержку, поэтому loopback разрешён только для него.
 *
 * Проверяются:
 *  - полный lifecycle: prepare → startRun/executePreparedRun → tool-цикл →
 *    submit_result → collectResult/collectUsage (COMPLETED, usage, durable selection);
 *  - resume: нагрузка durable selection из SQLite и маршрутизация в тот же
 *    provider-рантайм (без тихого переключения на Hermes, без replay);
 *  - cancel активного Run через RunService (STOPPED-proof NEVER_LAUNCHED);
 *  - отсутствие cross-provider fallback после ошибки апстрима;
 *  - legacy-регрессия: Runs без выбора провайдера остаются на Hermes-адаптере.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import type { Database, DatabaseTx } from "../../src/platform/database/database.js";
import { RunService, createRunContextInput } from "../../src/modules/runtime/run-service.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";
import type { AgentRuntime, AgentRuntimeRun } from "../../src/modules/runtime/agent-runtime.js";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { SqliteProviderSettingsRepository, type RunProviderSelectionRecord } from "../../src/modules/runtime/providers/provider-settings-repository.js";
import { ProviderAgentRuntime } from "../../src/modules/runtime/providers/provider-agent-runtime.js";
import { ProviderNetworkGateway } from "../../src/modules/runtime/providers/provider-network-gateway.js";
import { PROVIDER_ADAPTER_REGISTRY } from "../../src/modules/runtime/providers/adapters/registry.js";
import { ProviderCredentialStore } from "../../src/modules/runtime/providers/provider-credential-store.js";
import { InMemorySecretStore } from "../../src/platform/security/secret-store.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import { loadValidatedCapability } from "../../src/modules/execution/capability-validation.js";
import { getRunProcessOwner, transitionRunProcessOwnerTx, syncCurrentRunProcessGenerationTx, rotateRunProcessOwnerForResumeTx } from "../../src/modules/runtime/run-process-owner.js";
import { markFakeRunNeverLaunched } from "../helpers/fake-run-process-owner.js";
import { ownerIdentityForContainmentKind, stopEvidenceForContainmentKind } from "../helpers/run-process-owner-fixture.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";
import { digestRunContextV1, digestRunPromptBytesV1 } from "../../src/modules/context/context-provenance.js";
import type { ContextFingerprintInputV1, PreparedRunContext } from "../../src/modules/context/context-types.js";

const migrations = loadTestMigrations();
const CONTEXT_BUILDER_VERSION = "1.0.0";

const DEVELOPER_SUBMISSION = {
  version: "1.0.0",
  summary: "ok",
  outcome: "COMPLETED",
  commitSha: "a".repeat(40),
};

/** Hermes-стаб для legacy-пути: записывает вызовы, не поддерживает provider selection. */
function hermesStub(db: Database, calls: AgentRuntimeRun[] = []): AgentRuntime {
  const completion = new DatabaseCompletionStore(db);
  return {
    active: 0,
    maxActive: 0,
    calls: [],
    async startRun(run) {
      calls.push(run);
      markFakeRunNeverLaunched(db, run.id);
      const accepted = await completion.accept(run.capabilityRef!, {
        runId: run.id, role: run.role,
        output: { version: "1", outcome: "COMPLETED", commitSha: "test-commit-sha" },
      });
      if (!accepted) throw new Error("hermes stub could not submit a run result");
    },
    async resumeRun() { throw new Error("HERMES_STUB_RESUME_CALLED"); },
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

/** Mock-апстрим Ollama (/api/chat) на loopback. */
class MockOllamaUpstream {
  readonly server: Server;
  readonly requests: Array<{ url: string; method: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  private script: Array<Record<string, unknown> | Error>;
  private hold = false;
  private holdResolve: (() => void) | null = null;

  constructor(script: Array<Record<string, unknown> | Error> = []) {
    this.script = script;
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { /* non-json */ }
        this.requests.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body });
        if (this.hold) {
          // Не отвечаем: запрос остаётся in-flight до отмены.
          this.holdResolve?.();
          return;
        }
        const next = this.script.shift();
        if (next instanceof Error) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { message: "upstream failure" } }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(next ?? {
          message: { role: "assistant", content: "done" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 2,
          eval_count: 2,
        }));
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("mock upstream listen failed");
    return address.port;
  }

  async holdNextRequest(): Promise<void> {
    this.hold = true;
    await new Promise<void>((resolve) => { this.holdResolve = resolve; });
  }

  releaseHold(): void {
    this.hold = false;
    this.holdResolve = null;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      (this.server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }
}

describe("provider-runtime dispatch acceptance (plan-24 Task 7)", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let taskId: string;
  let projectId: string;
  let workspace: string;
  let upstream: MockOllamaUpstream | undefined;
  let hermesCalls: AgentRuntimeRun[];
  let hermesResumeCalls: number;
  let repository: SqliteProviderSettingsRepository;
  let providerRuntimeFactory: (selectionResolver: (runId: string) => RunProviderSelectionRecord | undefined) => AgentRuntime;

  beforeEach(() => { tmpDir = ""; });

  afterEach(async () => {
    if (upstream) { upstream.releaseHold(); await upstream.close(); upstream = undefined; }
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(upstreamScript: Array<Record<string, unknown> | Error> = []): Promise<RunService> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-provider-dispatch-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, migrations);
    projectId = randomUUID();
    taskId = randomUUID();
    const now = new Date().toISOString();

    // Мастер-репозиторий и managed worktree задачи (task/<taskId>) — обязательная
    // привязка capability для loadValidatedCapability.
    const masterRepoPath = join(tmpDir, "repository");
    await mkdir(masterRepoPath);
    const git = (args: string[]) => execFileSync("git", args, { cwd: masterRepoPath, stdio: "pipe", windowsHide: true });
    git(["init", "-b", "master"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    await writeFile(join(masterRepoPath, "README.md"), "# Test\n", "utf8");
    git(["add", "README.md"]);
    git(["commit", "-m", "init"]);

    workspace = join(tmpDir, "worktree");
    await mkdir(workspace);
    git(["worktree", "add", "-b", `task/${taskId}`, workspace, "master"]);

    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId, now });
    seedApprovedProjectConfig(db, projectId);

    const approvalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now });
    db.run(
      "INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repositoryPath,$facts,$proposed,'ACTIVE',$approvalId,$now,$now)",
      {
        projectId, repositoryPath: masterRepoPath, approvalId, now,
        facts: JSON.stringify({ root: masterRepoPath, defaultBranch: "master", remotes: [], packageManager: "npm", languageHints: [], testCommands: [], untrustedExistingConfig: false }),
        proposed: JSON.stringify({ defaultBranch: "master", workflow: "standard", roles: ["Developer"], guidelines: [] }),
      },
    );
    db.run(
      "INSERT INTO worktrees(id,repo_path,path,branch,created_at,removed_at) VALUES($id,$repoPath,$path,$branch,$now,NULL)",
      { id: taskId, repoPath: masterRepoPath, path: workspace, branch: `task/${taskId}`, now },
    );
    db.run(
      "INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$repoPath,$branch,$worktreeId,'master',$now,$now)",
      { id: randomUUID(), repoPath: masterRepoPath, branch: `task/${taskId}`, worktreeId: taskId, now },
    );

    upstream = new MockOllamaUpstream(upstreamScript);
    const port = await upstream.listen();
    const gateway = new ProviderNetworkGateway();

    repository = new SqliteProviderSettingsRepository(db);
    repository.saveProviderConfiguration({
      providerId: "ollama",
      enabled: true,
      selectedAuthMethod: "local-endpoint",
      config: { endpoint: `http://127.0.0.1:${port}` },
      modelSelection: { defaultModelId: "qwen3", roleDefaults: {} },
    });

    const credentialStore = new ProviderCredentialStore(new InMemorySecretStore(db), repository);
    providerRuntimeFactory = (selectionResolver) => new ProviderAgentRuntime({
      gateway,
      credentialStore,
      settingsRepository: repository,
      registry: PROVIDER_ADAPTER_REGISTRY,
      completion: new DatabaseCompletionStore(db!),
      loadCapability: (capabilityRef) => loadValidatedCapability(db!, capabilityRef),
      selectionResolver,
      stopProof: {
        markNeverLaunched: (runId) => {
          try {
            db!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
              runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
            }));
          } catch { /* гейт STOPPED-proof ниже завершится fail-closed */ }
        },
      },
    });

    hermesCalls = [];
    hermesResumeCalls = 0;
    const stub = hermesStub(db, hermesCalls);
    stub.resumeRun = async () => { hermesResumeCalls += 1; };
    return new RunService(db, stub, stubAssembler() as never, undefined, undefined, undefined, repository, providerRuntimeFactory);
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

  function toolCall(name: string, args: Record<string, unknown>) {
    return { function: { name, arguments: args } };
  }

  it("полный lifecycle через ProviderAgentRuntime и шлюз: prepare → dispatch → tool-цикл → submit_result → collectResult/collectUsage", async () => {
    const service = await setup([
      {
        message: { role: "assistant", content: "", tool_calls: [toolCall("git.head", {})] },
        done: true, done_reason: "tool_calls",
        prompt_eval_count: 3, eval_count: 1,
      },
      {
        message: { role: "assistant", content: "", tool_calls: [toolCall("submit_result", { payload: DEVELOPER_SUBMISSION })] },
        done: true, done_reason: "tool_calls",
        prompt_eval_count: 4, eval_count: 2,
      },
    ]);

    const run = service.prepareRun(options());
    expect(db!.get("SELECT * FROM run_provider_selections WHERE run_id=$id", { id: run.id })).toBeDefined();
    const { run: executed, outcome } = await service.executePreparedRun(run.id);

    expect(executed.status).toBe("COMPLETED");
    expect(outcome.success).toBe(true);
    expect(outcome.validatedSubmission).toBe(true);
    // Tool-цикл: два запроса к апстриму (git.head → submit_result), один провайдер.
    expect(upstream!.requests.length).toBe(2);
    for (const request of upstream!.requests) {
      expect(request.url).toMatch(/^\/api\/chat$/);
      expect(request.body.model).toBe("qwen3");
    }
    // Legacy Hermes-путь не вызывался.
    expect(hermesCalls).toHaveLength(0);
    // Usage собран.
    const usageRow = db!.get<{ input_tokens: number | null }>("SELECT input_tokens FROM agent_runs WHERE id=$id", { id: run.id });
    expect(Number(usageRow?.input_tokens)).toBeGreaterThan(0);
  });

  it("resume загружает durable selection и маршрутизируется в provider-рантайм (fail-closed, без replay и без Hermes)", async () => {
    const service = await setup();
    const run = service.prepareRun(options());

    // Симулируем interrupted run: owner PREPARED→LAUNCHING→LIVE→STOPPED, IN_PROGRESS, session.
    const owner = getRunProcessOwner(db!, run.id)!;
    db!.transaction((tx) => {
      transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
      transitionRunProcessOwnerTx(tx, {
        runId: run.id, expectedState: "LAUNCHING", nextState: "LIVE",
        identity: ownerIdentityForContainmentKind(owner.containmentKind),
      });
      tx.run("UPDATE agent_runs SET status='IN_PROGRESS',session_id='original-session' WHERE id=$runId", { runId: run.id });
      tx.run("UPDATE run_process_owners SET capture_state='BOUND' WHERE run_id=$runId", { runId: run.id });
      syncCurrentRunProcessGenerationTx(tx, run.id);
      transitionRunProcessOwnerTx(tx, {
        runId: run.id, expectedState: "LIVE", nextState: "STOPPED",
        evidence: stopEvidenceForContainmentKind(owner.containmentKind),
      });
      tx.run("UPDATE run_resume_bindings SET original_session_id='original-session' WHERE run_id=$runId", { runId: run.id });
    });

    const restarted = new RunService(db!, hermesStub(db!), stubAssembler() as never, {
      verifyContext: async () => {},
      claimInTransaction: (tx, input) => { rotateRunProcessOwnerForResumeTx(tx, input); },
    }, undefined, undefined, repository, providerRuntimeFactory);

    await expect(restarted.resumeRun(run.id, { attempt: 1 })).rejects.toThrow("PROVIDER_RESUME_UNAVAILABLE");

    const failed = db!.get<{ status: string; attempt: number | null }>("SELECT status,attempt FROM agent_runs WHERE id=$id", { id: run.id });
    expect(failed?.status).toBe("FAILED");
    // Ни одного платного запроса: апстрим не получал запросов.
    expect(upstream!.requests.length).toBe(0);
    // Без тихого переключения на Hermes.
    expect(hermesResumeCalls).toBe(0);
  });

  it("cancel подготовленного provider-Run через RunService завершается CANCELLED со STOPPED-proof", async () => {
    const service = await setup();
    const run = service.prepareRun(options());

    // Отмена до dispatch: provider-рантайм не запускал OS-процесс, поэтому
    // честное доказательство NEVER_LAUNCHED фиксируется сразу.
    await service.cancelRun(run.id);
    const row = db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id });
    expect(row?.status).toBe("CANCELLED");
    const owner = db!.get<{ state: string; stop_evidence: string }>("SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$id", { id: run.id });
    expect(owner?.state).toBe("STOPPED");
    expect(owner?.stop_evidence).toBe("NEVER_LAUNCHED");
    // Ни одного платного запроса.
    expect(upstream!.requests.length).toBe(0);
  });

  it("ошибка апстрима: Run завершается FAILED, один запрос, без cross-provider fallback", async () => {
    const service = await setup([new Error("upstream 500")]);
    const run = service.prepareRun(options());

    await expect(service.executePreparedRun(run.id)).rejects.toThrow(/AGENT_OUTPUT_MISSING/);
    const row = db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: run.id });
    expect(row?.status).toBe("FAILED");
    // Ровно один запрос к единственному выбранному провайдеру; повторных/чужих нет.
    expect(upstream!.requests.length).toBe(1);
    expect(hermesCalls).toHaveLength(0);
  });

  it("legacy-регрессия: Run без выбора провайдера остаётся на Hermes-адаптере", async () => {
    // Без конфигурации провайдеров фабрика никогда не используется.
    tmpDir = await mkdtemp(join(tmpdir(), "orch-provider-legacy-"));
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
    repository = new SqliteProviderSettingsRepository(db);
    hermesCalls = [];

    const factory: (selectionResolver: (runId: string) => RunProviderSelectionRecord | undefined) => AgentRuntime = () => {
      throw new Error("PROVIDER_FACTORY_MUST_NOT_BE_USED_FOR_LEGACY");
    };
    const service = new RunService(db, hermesStub(db, hermesCalls), stubAssembler() as never, undefined, undefined, undefined, repository, factory);
    const run = service.prepareRun(options());
    expect(db!.get("SELECT * FROM run_provider_selections WHERE run_id=$id", { id: run.id })).toBeUndefined();
    const { run: executed } = await service.executePreparedRun(run.id);
    expect(executed.status).toBe("COMPLETED");
    expect(hermesCalls).toHaveLength(1);
    expect(hermesCalls[0]!.providerSelection).toBeUndefined();
  });
});
