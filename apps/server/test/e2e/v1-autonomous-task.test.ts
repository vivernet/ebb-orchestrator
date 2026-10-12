/**
 * План 4: покрытие инфраструктуры и opt-in-приёмка с реальным Hermes.
 *
 * Детерминированный fallback всегда запускается. Сценарий с реальным
 * subprocess Hermes включается отдельно, поскольку Hermes не является CI-зависимостью.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import type { Database } from "../../src/platform/database/database.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { WorktreeManager, type WorktreeRecord } from "../../src/modules/git/worktree-manager.js";
import { IntegrationService, type IntegrationAttempt } from "../../src/modules/git/integration-service.js";
import { MergeService } from "../../src/modules/git/merge-service.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { ActionGateway } from "../../src/modules/execution/action-gateway.js";
import type { ProjectConfig } from "../../src/modules/execution/project-actions.js";
import { McpServer } from "../../src/modules/execution/mcp/mcp-server.js";
import { loadValidatedCapability } from "../../src/modules/execution/capability-validation.js";
import { GitTools } from "../../src/modules/execution/git-tools.js";
import { PathResolver } from "../../src/platform/security/path-resolver.js";
import { createRunContextInput, RunService, taskDeveloperPrompt, taskQaPrompt, taskReviewerPrompt } from "../../src/modules/runtime/run-service.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { HermesRuntimeAdapter } from "../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { ProcessExecutor } from "../../src/platform/process/process-executor.js";
import { WindowsJobSupervisor } from "../../src/platform/process/windows-job-supervisor.js";
import { SystemdRunSupervisor } from "../../src/platform/process/systemd-run-supervisor.js";
import { ContextBuilder } from "../../src/modules/context/context-builder.js";
import { DEVELOPER_COMMIT_SHA_INSTRUCTION, PromptBuilder } from "../../src/modules/runtime/prompt-builder.js";
import type { TaskContract as PromptTaskContract } from "../../src/modules/context/context-types.js";
import { markFakeRunNeverLaunched } from "../helpers/fake-run-process-owner.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";
import { getRunProcessOwner, isAuthoritativeRunProcessStopEvidence } from "../../src/modules/runtime/run-process-owner.js";

const execFileAsync = promisify(execFile);
const resolve = createRequire(import.meta.url).resolve;
const tsxLoader = pathToFileURL(resolve("tsx")).href;
const migrations = loadTestMigrations();
const HERMES_RUN_TIMEOUT_MS = 300_000;
const MCP_HANDSHAKE_TIMEOUT_MS = 30_000;
const ACCEPTANCE_TEARDOWN_TIMEOUT_MS = 65_000;
const HERMES_LIVE_TEST_TIMEOUT_MS = 4 * (HERMES_RUN_TIMEOUT_MS + MCP_HANDSHAKE_TIMEOUT_MS) + ACCEPTANCE_TEARDOWN_TIMEOUT_MS + 120_000;
const HEALTH_SERVICE_TEST_PROJECT_CONFIG = {
  commands: { test: { executable: process.execPath, args: ["test/smoke.js"] } },
} satisfies ProjectConfig;

interface TrackedAcceptanceRun {
  service: Pick<RunService, "cancelRun">;
  execution?: Promise<unknown>;
}

function hasStoppedOwner(database: Database, runId: string): boolean {
  try {
    const owner = getRunProcessOwner(database, runId);
    return owner?.state === "STOPPED" &&
      isAuthoritativeRunProcessStopEvidence(owner.stopEvidence, owner.containmentKind);
  } catch { return false; }
}

function hasTerminalStoppedRun(database: Database, runId: string): boolean {
  try {
    const run = database.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId });
    return Boolean(run && ["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) && hasStoppedOwner(database, runId));
  } catch { return false; }
}

function summarizeHealthAcceptanceEvidence(evidence: readonly string[]): Array<{
  acceptanceId: boolean; testCommand: boolean; testPassed: boolean; healthEndpoint: boolean;
  healthStatus200: boolean; jsonStatusOk: boolean; rootStatus404: boolean;
}> {
  return evidence.map((item) => {
    const jsonStatusOk =
      /(?:parsed )?JSON deep-equals\s*\{\s*status:\s*['"]ok['"]\s*\}/iu.test(item) ||
      /JSON\s+status\s+ok\b/iu.test(item);
    return {
      acceptanceId: /\bAC-1\b/u.test(item),
      testCommand: /project\.test|node\s+test\/smoke\.js|npm\s+(?:run\s+)?test/iu.test(item),
      testPassed: /exitCode=0,\s*success=true/iu.test(item),
      healthEndpoint: /GET \/health/iu.test(item),
      healthStatus200: /(?:statusCode\s*={1,3}\s*200|returns?\s+200)/iu.test(item),
      jsonStatusOk,
      rootStatus404: /GET \/\s+(?:returns?\s+404|statusCode\s*={1,3}\s*404)/iu.test(item),
    };
  });
}

function hasHealthAcceptanceEvidence(evidence: readonly string[]): boolean {
  // Tool success is verified from this Run's Hermes tool_result counters separately; do not gate on model wording.
  return summarizeHealthAcceptanceEvidence(evidence).some((facts) =>
    facts.acceptanceId && facts.testCommand && facts.healthEndpoint && facts.healthStatus200 && facts.jsonStatusOk && facts.rootStatus404,
  );
}

async function settlesWithin(pending: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function settleAcceptanceProcesses(
  database: Database | undefined,
  runs: ReadonlyMap<string, TrackedAcceptanceRun>,
  children: Set<ChildProcessWithoutNullStreams>,
  timeoutMs = ACCEPTANCE_TEARDOWN_TIMEOUT_MS,
): Promise<boolean> {
  const childClosures = [...children].map((child) => new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  }));
  const cancellations = [...runs].map(async ([runId, tracked]) => {
    if (!database || !hasTerminalStoppedRun(database, runId)) await tracked.service.cancelRun(runId);
  });
  const executions = [...runs.values()].flatMap((tracked) => tracked.execution ? [tracked.execution] : []);
  const settled = await settlesWithin(Promise.allSettled([...cancellations, ...executions, ...childClosures]), timeoutMs);
  return settled && children.size === 0 && [...runs.keys()].every((runId) => database && hasTerminalStoppedRun(database, runId));
}

function requireNonBlankString(value: string | null | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is incomplete`);
  }
  return value;
}

class DeterministicRuntime implements AgentRuntime {
  active = 0;
  maxActive = 0;
  calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  constructor(private readonly database: Database) {}
  async startRun(run: AgentRun): Promise<void> { markFakeRunNeverLaunched(this.database, run.id); }
  async runResult(_runId: string): Promise<RunOutcome> { throw new Error("runResult is not used by this acceptance driver"); }
  async resumeRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
  async inspectRun(): Promise<AgentRun> { throw new Error("inspectRun is not used by this acceptance driver"); }
  async collectResult(): Promise<RunOutcome> { throw new Error("collectResult is owned by RunService in this driver"); }
  async collectUsage(): Promise<{ inputTokens: number; cachedInputTokens: number; outputTokens: number; cost: number }> {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 };
  }
  async healthCheck(): Promise<boolean> { return true; }
}

class AcceptanceWorkflow {
  private integrationRunId: string | undefined;
  private integrationPreparedRun: AgentRun | undefined;
  constructor(
    private readonly db: Database,
    private readonly workflow: WorkflowEngine,
    private readonly runs: RunService,
    private readonly runtime: DeterministicRuntime,
    private readonly worktrees: WorktreeManager,
    private readonly git: GitCli,
    private readonly repoPath: string,
    private readonly taskId: string,
  ) {}

  ready(): void { this.workflow.transition(this.taskId, "READY"); }

  async reserveIntegrationRun(attempt: IntegrationAttempt): Promise<string> {
    const row = this.db.get<{ contract_json: string }>("SELECT contract_json FROM tasks WHERE id=$taskId", { taskId: this.taskId });
    if (!row || !attempt.expectedTargetSha || !attempt.integrationRunId || !attempt.provenanceDatabasePath) {
      throw new Error("Persisted Task contract or Integration attempt provenance is unavailable");
    }
    const persisted = JSON.parse(row.contract_json) as Omit<PromptTaskContract, "id" | "priority">;
    const taskContract: PromptTaskContract = { id: this.taskId, priority: "p0", ...persisted };
    const prompt = new PromptBuilder().buildIntegrationPrompt({
      taskContract,
      workspace: attempt.worktreePath,
      targetRef: attempt.currentTargetBranch,
      checks: ["verify the isolated merge and project.test result", "verify target and task provenance"],
      expectedTargetSha: attempt.expectedTargetSha,
      sourceSha: attempt.sourceSha,
      integrationAttemptId: attempt.id,
      provenanceDatabasePath: attempt.provenanceDatabasePath,
    });
    const roleInputs = {
      sourceSha: attempt.sourceSha,
      targetSha: attempt.expectedTargetSha,
      attemptId: attempt.id,
      provenanceDatabasePath: attempt.provenanceDatabasePath,
    };
    const options = {
      runId: attempt.integrationRunId,
      role: "Integration",
      model: "deterministic-test-runtime",
      taskId: this.taskId,
      epicId: null,
      triggerReason: "integration",
      contextVersion: "acceptance-v1",
      outputSchemaVersion: "1",
      capability: { workspace: attempt.worktreePath },
    } satisfies StartRunOptions;
    const run = await this.runs.prepareRunWithHermesPreflight({
      ...options,
      prompt,
      contextInput: createRunContextInput(options, {
        prompt,
        roleInputs,
        workspaceIdentity: { repository: this.repoPath, workspace: attempt.worktreePath, worktree: attempt.id },
        targetHead: attempt.expectedTargetSha,
        targetBranch: attempt.currentTargetBranch,
      }),
    });
    this.integrationPreparedRun = run;
    this.integrationRunId = run.id;
    return run.id;
  }

  bindInitialIntegrationWorkspaceSnapshot(runId: string): void {
    if (this.integrationPreparedRun?.id !== runId) throw new Error("Integration Run was not prepared by this acceptance driver");
    this.runs.bindInitialIntegrationWorkspaceSnapshot(runId);
  }

  private async startTaskRun(
    role: string,
    prompt: string,
    workspace: string,
    roleInputs: unknown,
    triggerReason: string,
    targetHead: string | null,
    targetBranch: string | null,
    runId?: string,
  ): Promise<AgentRun> {
    const options = {
      ...(runId ? { runId } : {}),
      role,
      model: "deterministic-test-runtime",
      taskId: this.taskId,
      epicId: null,
      triggerReason,
      contextVersion: "acceptance-v1",
      outputSchemaVersion: "1",
      capability: { workspace },
    } satisfies StartRunOptions;
    return this.runs.startRun({
      ...options,
      prompt,
      contextInput: createRunContextInput(options, {
        prompt,
        roleInputs,
        workspaceIdentity: { repository: this.repoPath, workspace, worktree: this.taskId },
        targetHead,
        targetBranch,
      }),
    });
  }

  async developer(): Promise<WorktreeRecord> {
    this.workflow.transition(this.taskId, "DEVELOPMENT");
    const worktree = await this.worktrees.createTaskWorkspace(this.taskId, this.repoPath, "master");
    const workspace = new ActionGateway(new PathResolver(), worktree.path, ['workspace.read', 'workspace.patch']);
    const existing = await workspace.readFile("src/server.js");
    expect(existing.success).toBe(true);
    const write = await workspace.patch("src/server.js", [{ start: 0, end: existing.content?.length ?? 0, content: `import http from "http";\nimport { pathToFileURL } from "node:url";\n\nconst server = http.createServer((req, res) => {\n  if (req.method === "GET" && req.url === "/health") {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ status: "ok" }));\n    return;\n  }\n  res.writeHead(404);\n  res.end("Not Found");\n});\n\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) server.listen(process.env.PORT || 3000);\nexport default server;\n` }]);
    expect(write.success).toBe(true);
    const gitTools = new GitTools(worktree.path);
    expect(await gitTools.add(["src/server.js"])).not.toMatch(/error/i);
    await this.git.run(worktree.path, ["config", "user.email", "developer@example.com"]);
    await this.git.run(worktree.path, ["config", "user.name", "Developer Agent"]);
    await this.git.run(worktree.path, ["add", "src/server.js"]);
    expect((await this.git.run(worktree.path, ["status", "--short"])).stdout).toContain("src/server.js");
    const commitOutput = await this.git.run(worktree.path, ["commit", "-m", "feat: add health endpoint"]);
    expect(commitOutput.exitCode).toBe(0);
    const sha = (await this.git.run(worktree.path, ["rev-parse", "HEAD"])).stdout.trim();
    await this.record("Developer", { outcome: "COMPLETED", commitSha: sha });
    this.workflow.transition(this.taskId, "REVIEW");
    return worktree;
  }

  async reviewer(worktree: WorktreeRecord): Promise<void> {
    const diff = (await this.git.run(worktree.path, ["diff", "master", "HEAD"])).stdout;
    expect(diff).toContain("/health");
    const run = await this.record("Reviewer", { outcome: "PASS", findings: [], independent: true }, "review", worktree.path, { gitDiff: diff, checks: ["Compare the committed changes with persisted acceptance criteria"] });
    expect(run.status).toBe("COMPLETED");
    this.workflow.transition(this.taskId, "QA", { hasReviewPassed: true, hasSuccessfulIntegration: false, hasFinalMergeApproval: false, parentEpicReleased: false });
  }

  async qa(worktree: WorktreeRecord): Promise<void> {
    await execFileAsync(process.execPath, ["test/smoke.js"], { cwd: worktree.path });
    await this.record("QA", { outcome: "PASS", evidence: ["AC-1: GET /health returns 200 and JSON status ok"] }, "qa", worktree.path, { environment: `managed task workspace; smoke test completed in ${worktree.path}` });
    this.workflow.transition(this.taskId, "READY_FOR_INTEGRATION");
  }

  async integration(attempt: IntegrationAttempt): Promise<void> {
    this.workflow.transition(this.taskId, "INTEGRATION");
    if (!this.integrationPreparedRun || this.integrationPreparedRun.id !== this.integrationRunId) {
      throw new Error("Integration Run was not prepared from its persisted attempt");
    }
    await this.runtime.startRun(this.integrationPreparedRun);
    const targetSha = (await this.git.run(this.repoPath, ["rev-parse", "master"])).stdout.trim();
    expect(attempt.expectedTargetSha).toBe(targetSha);
    expect((await this.git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).not.toBe(targetSha);
    expect(readFileSync(join(attempt.worktreePath, "src", "server.js"), "utf8")).toContain("/health");
     const mcp = new McpServer(loadValidatedCapability(this.db, this.integrationPreparedRun.capabilityRef!));
     expect(mcp.getAvailableTools().map((tool) => tool.name)).toContain("project.test");
     const testResponse = await mcp.processRequest({ jsonrpc: "2.0", id: "integration-test", method: "tools/call", params: { name: "project.test" } });
     expect(testResponse).toMatchObject({ jsonrpc: "2.0", id: "integration-test", result: { isError: false } });
     const testText = (testResponse as { result: { content: Array<{ text: string }> } }).result.content[0]?.text;
     if (!testText) throw new Error("project.test MCP response did not include result text");
     expect(JSON.parse(testText)).toMatchObject({ action: "test", success: true, exitCode: 0 });
    if (this.integrationRunId) {
      const output = {
        version: "1",
        outcome: "PASS",
        baseSha: attempt.expectedTargetSha,
        sourceSha: attempt.sourceSha,
        provenance: [`integration_attempt:${attempt.id}`],
        evidence: ["Verified the prepared source SHA in the integration worktree"],
      };
      await this.runs.completionStore().accept(this.runs.getCapabilityReference(this.integrationRunId), { runId: this.integrationRunId, role: "Integration", output });
      await this.runs.collectResult(this.integrationRunId, { success: true, exitCode: 0, output: JSON.stringify(output), validatedSubmission: true, diagnostics: { runId: this.integrationRunId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } });
      await this.runs.collectUsage(this.integrationRunId, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: 0 });
    } else throw new Error("Integration Run was not prepared from its persisted attempt");
    this.workflow.transition(this.taskId, "READY_FOR_MERGE");
  }

  async record(role: string, output: object, triggerReason = "task-assignment", workspace?: string, roleInputs: unknown = {}): Promise<AgentRun> {
    const persistedWorkspace = workspace ?? this.db.get<{ path: string }>("SELECT path FROM worktrees WHERE id=$id", { id: this.taskId })?.path;
    if (!persistedWorkspace) throw new Error("Persisted managed Task workspace is unavailable");
    const prompt = role.toLowerCase() === "developer" ? taskDeveloperPrompt()
      : role.toLowerCase() === "reviewer" ? taskReviewerPrompt()
        : role.toLowerCase() === "qa" ? taskQaPrompt()
          : "Run the accepted Task role and submit its validated result.";
    const targetHead = (await this.git.run(this.repoPath, ["rev-parse", "master"])).stdout.trim();
    const run = await this.startTaskRun(role, prompt, persistedWorkspace, roleInputs, triggerReason, targetHead, "master");
      const raw = output as { outcome?: string; findings?: unknown[]; failedCriteria?: unknown[] };
      const roleOutput = {
        version: "1",
        outcome: raw.outcome,
        ...(raw.findings ? { findings: raw.findings } : {}),
        ...(raw.failedCriteria ? { failedCriteria: raw.failedCriteria } : {}),
        ...("commitSha" in raw ? { commitSha: (raw as { commitSha: string }).commitSha } : {}),
        ...("independent" in raw ? { independent: true } : {}),
        ...("evidence" in raw ? { evidence: (raw as { evidence: string[] }).evidence } : {}),
        ...("baseSha" in raw ? { baseSha: (raw as { baseSha: string }).baseSha } : {}),
        ...("provenance" in raw ? { provenance: (raw as { provenance: string[] }).provenance } : {}),
      };
      await this.runs.completionStore().accept(run.capabilityRef!, { runId: run.id, role: run.role, output: roleOutput });
      const completed = await this.runs.collectResult(run.id, {
        success: true, exitCode: 0, output: JSON.stringify(roleOutput), validatedSubmission: true,
        diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [`run-artifacts://${run.id}`] },
      });
     await this.runs.collectUsage(run.id, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: 0 });
     return completed;
  }
}

describe("Autonomous Task End-to-End Workflow", () => {
  let db: Database | undefined;
  let tmpDir = "";
  let masterRepoPath = "";
  let taskId = "";
  let projectId = "";
  let teardownStarted = false;
  const trackedRuns = new Map<string, TrackedAcceptanceRun>();
  const trackedMcpChildren = new Set<ChildProcessWithoutNullStreams>();
  let approvalService: ApprovalService;
   let mergeService: MergeService;
   let worktreeManager: WorktreeManager;
  let workflow: WorkflowEngine;

  beforeEach(async () => {
    teardownStarted = false;
    trackedRuns.clear();
    trackedMcpChildren.clear();
    tmpDir = await mkdtemp(join(tmpdir(), "orch-e2e-"));
    const orchestratorDirectory = join(tmpDir, ".ebb-orchestrator");
    await mkdir(orchestratorDirectory, { recursive: true });
    db = createSqliteDatabase(join(orchestratorDirectory, "acceptance.db"));
    runMigrations(db, migrations);
  // Текущий sqlite-адаптер отклоняет UNIQUE-условия с выражениями в migration 007.
  // Для проверки очистки acceptance-теста репозиторию managed worktree нужна
  // только эта конкретная таблица.
    db.exec(`CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, path TEXT NOT NULL,
      branch TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT
    )`);
    projectId = randomUUID(); taskId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,$name,$display_name,'ACTIVE',$created_at,$updated_at)", { id: projectId, name: "health-service", display_name: "Health Service", created_at: now, updated_at: now });
    seedApprovedProjectConfig(db, projectId, "master", HEALTH_SERVICE_TEST_PROJECT_CONFIG.commands);
    const onboardingApprovalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: onboardingApprovalId, projectId, now });
    db.run("INSERT INTO tasks (id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES ($id,$project_id,$display_id,$title,'DRAFT',$contract_json,1,$created_at,$updated_at)", { id: taskId, project_id: projectId, display_id: "TASK-HEALTH", title: "Add GET /health", contract_json: JSON.stringify({ version: 1, goal: "Add GET /health", context: "health check", requirements: ["GET /health returns 200"], acceptanceCriteria: ["returns 200 and JSON {status:'ok'}"], dependencies: [], nonGoals: ["no auth changes"], definitionOfDone: ["tests pass"] }), created_at: now, updated_at: now });
    masterRepoPath = join(tmpDir, "master-repo");
    await mkdir(masterRepoPath, { recursive: true });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES ($projectId,$repositoryPath,$facts,$proposed,'ACTIVE',$approvalId,$now,$now)", { projectId, repositoryPath: masterRepoPath, facts: JSON.stringify({ root: masterRepoPath, defaultBranch: "master", remotes: [], packageManager: "npm", languageHints: [], testCommands: [], untrustedExistingConfig: false }), proposed: JSON.stringify({ defaultBranch: "master", workflow: "standard", roles: ["Developer"], guidelines: [] }), approvalId: onboardingApprovalId, now });
    await cp(join(import.meta.dirname, "fixtures", "health-service"), masterRepoPath, { recursive: true });
    const git = new GitCli();
    await git.run(masterRepoPath, ["init", "-b", "master"]);
    await git.run(masterRepoPath, ["config", "user.email", "test@example.com"]); await git.run(masterRepoPath, ["config", "user.name", "Test User"]);
    await git.run(masterRepoPath, ["add", "."]); await git.run(masterRepoPath, ["commit", "-m", "Initial commit"]);
    const registry = new WorkflowRegistry(); for (const template of Object.values(templates)) registry.register(template);
     workflow = new WorkflowEngine(db, registry);
    approvalService = new ApprovalService(db);
     worktreeManager = new WorktreeManager({ db, worktreeDir: join(tmpDir, "worktrees") });
    mergeService = new MergeService({ approvalStore: new Map(), repoPath: masterRepoPath, sourceBranch: `task/${taskId}`, targetBranch: "master" });
    const deterministicRuntime = new DeterministicRuntime(db);
    (globalThis as { acceptance?: AcceptanceWorkflow }).acceptance = new AcceptanceWorkflow(db, workflow, new RunService(db, deterministicRuntime), deterministicRuntime, worktreeManager, git, masterRepoPath, taskId);
  });

  afterEach(async () => {
    teardownStarted = true;
    const safeToRemove = await settleAcceptanceProcesses(db, trackedRuns, trackedMcpChildren);
    if (!safeToRemove) {
      process.stderr.write(`${tmpDir}\n`);
      throw new Error("PLAN04_TEARDOWN_STOP_UNVERIFIED");
    }
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }, ACCEPTANCE_TEARDOWN_TIMEOUT_MS + 10_000);

  it("covers the workflow with the deterministic infrastructure fallback", async () => {
    const driver = (globalThis as unknown as { acceptance: AcceptanceWorkflow }).acceptance;
    driver.ready();
    const worktree = await driver.developer();
    await driver.reviewer(worktree);
    await driver.qa(worktree);
     const integrationRunId = randomUUID();
     const integrationService = new IntegrationService({ worktreeDir: join(tmpDir, "integration"), database: db!, provenanceDatabasePath: join(tmpDir, ".ebb-orchestrator", "acceptance.db"), integrationRunId });
     const preparedIntegration = await integrationService.prepareIntegration(`task/${taskId}`, "master", masterRepoPath);
     const integrationRunIdFromRun = await driver.reserveIntegrationRun(preparedIntegration);
     const integration = integrationService.bindIntegrationRun(preparedIntegration, integrationRunIdFromRun);
     await integrationService.mergePreparedSource(integration);
     const persistedIntegrationRunId = integration.integrationRunId;
     expect(persistedIntegrationRunId).toBeDefined();
     if (!persistedIntegrationRunId) throw new Error("Integration attempt did not receive its reserved run ID");
     driver.bindInitialIntegrationWorkspaceSnapshot(persistedIntegrationRunId);
      mergeService = new MergeService({ approvalStore: new Map(), repoPath: masterRepoPath, integrationAttempt: integration, database: db! });
      await integrationService.runInIntegrationWorktree(integration, async () => driver.integration(integration));
    const outcomes = db!.all<{ role: string; output: string }>("SELECT role, output FROM agent_runs WHERE task_id = $task_id ORDER BY started_at", { task_id: taskId });
    expect(outcomes.map((row) => row.role)).toEqual(["Developer", "Reviewer", "QA", "Integration"]);
    expect(JSON.parse(outcomes[1]!.output)).toMatchObject({ outcome: "PASS", findings: [] });
      expect(JSON.parse(outcomes[2]!.output)).toMatchObject({ outcome: "PASS" });
      expect(JSON.parse(outcomes[3]!.output)).toMatchObject({ outcome: "PASS" });
      expect(db!.get<{ id: string; role: string; status: string; output: string }>("SELECT id, role, status, output FROM agent_runs WHERE id = $id", { id: persistedIntegrationRunId })).toMatchObject({ id: persistedIntegrationRunId, role: "Integration", status: "COMPLETED", output: expect.stringContaining('"outcome":"PASS"') });
    expect(readFileSync(join(masterRepoPath, "src", "server.js"), "utf8")).not.toContain("/health");
    const approval = approvalService.request({ type: "FINAL_MERGE", subjectId: taskId, subjectType: "TASK", requestedBy: "orchestrator" });
    expect(approval.status).toBe("PENDING");
    const approved = approvalService.approve(approval.id, "test-human", "acceptance approval");
    mergeService.registerApproval({ id: approved.id, subjectId: approved.subjectId, type: approved.type, status: approved.status });
    const merged = await mergeService.mergeApproved(taskId, approved.id);
    expect(merged.success).toBe(true);
    expect(readFileSync(join(masterRepoPath, "src", "server.js"), "utf8")).toContain("/health");
     workflow.transition(taskId, "MERGING", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: true, parentEpicReleased: false });
     workflow.transition(taskId, "DONE");
     await integrationService.cleanupIntegration(integration);
     await worktreeManager.removeWorkspace(worktree.id);
     expect(() => readFileSync(join(worktree.path, "src", "server.js"), "utf8")).toThrow();
     expect(db!.get<{ status: string }>("SELECT status FROM tasks WHERE id = $id", { id: taskId })?.status).toBe("DONE");
     expect(db!.get<{ removed_at: string | null }>("SELECT removed_at FROM worktrees WHERE id = $id", { id: taskId })?.removed_at).not.toBeNull();
      const approvalEvents = db!.all<{ type: string; aggregate_id: string; payload_json: string }>(
        "SELECT type, aggregate_id, payload_json FROM outbox_events WHERE aggregate_id = $id AND type IN ('ApprovalRequested', 'ApprovalApproved') ORDER BY created_at",
        { id: taskId },
      );
      expect(approvalEvents.map((event) => event.type)).toEqual(["ApprovalRequested", "ApprovalApproved"]);
      expect(approvalEvents.every((event) => event.aggregate_id === taskId)).toBe(true);
      expect(approvalEvents.map((event) => JSON.parse(event.payload_json).approvalId)).toEqual([approved.id, approved.id]);
      expect(db!.get<{ type: string; subject_id: string; status: string }>(
        "SELECT type, subject_id, status FROM approvals WHERE id = $id",
        { id: approved.id },
      )).toEqual({ type: "FINAL_MERGE", subject_id: taskId, status: "APPROVED" });
      expect(db!.all<{ role: string; input_tokens: number; output_tokens: number }>(
        "SELECT role, input_tokens, output_tokens FROM agent_runs WHERE task_id = $id ORDER BY started_at",
        { id: taskId },
      ).map((run) => run.role)).toEqual(["Developer", "Reviewer", "QA", "Integration"]);
      expect(db!.all<{ input_tokens: number; output_tokens: number }>(
        "SELECT input_tokens, output_tokens FROM agent_runs WHERE task_id = $id",
        { id: taskId },
      ).every((run) => run.input_tokens !== null && run.output_tokens !== null)).toBe(true);
  }, 20000);

  it("binds the approved onboarding configuration to the temporary repository", () => {
    expect(db?.get<{ repository_path: string }>(
      "SELECT repository_path FROM onboarding_configs WHERE project_id=$projectId",
      { projectId },
    )?.repository_path).toBe(masterRepoPath);
  });

  it("requires FINAL_MERGE approval for the exact task", async () => {
    const approval = approvalService.request({ type: "FINAL_MERGE", subjectId: taskId, subjectType: "TASK", requestedBy: "orchestrator" });
    expect(approval.status).toBe("PENDING");
    await expect(mergeService.mergeApproved(taskId, approval.id)).rejects.toThrow("Approval not found");
  });

  it("keeps the opt-in Hermes driver on the durable prepared-run API", () => {
    const source = readFileSync(new URL("./v1-autonomous-task.test.ts", import.meta.url), "utf8");
    const liveDriver = source.slice(source.lastIndexOf('it("runs the real Hermes managed-worktree acceptance when opted in"'));
    expect(liveDriver).not.toMatch(/runs\.startRun\(|runtime\.inspectRun\(|runs\.collectResult\(/u);
    expect(liveDriver).toContain("runs.prepareRunWithHermesPreflight(");
    expect(liveDriver).toContain("runs.executePreparedRun(");
    expect(liveDriver).not.toMatch(/profiles[\s\S]*?config\.yaml/u);
    expect(liveDriver).toMatch(/bindIntegrationRun\([\s\S]*?runInIntegrationWorktree\([\s\S]*?runHermesRole\("Integration"/u);
  });

  it("reports only bounded counters when the live role produces no accepted output", () => {
    const source = readFileSync(new URL("./v1-autonomous-task.test.ts", import.meta.url), "utf8");
    const liveDriver = source.slice(source.lastIndexOf('it("runs the real Hermes managed-worktree acceptance when opted in"'));
    expect(liveDriver).toMatch(/AGENT_OUTPUT_MISSING:[^\n]*TOOL_COUNTS_/u);
    expect(liveDriver).toMatch(/runtime\.collectResult\(preparedRun\.id\)/u);
    expect(liveDriver).toMatch(/toolCounts/);
    expect(liveDriver).toContain('outcome.diagnostics?.toolCounts?.["workspace.read"]');
    expect(liveDriver).toMatch(/JSON\.stringify\(toolCounts\)/u);
    expect(liveDriver).toMatch(/let processExitCode = "UNKNOWN"/u);
    expect(liveDriver).toMatch(/let stderrCategory = "UNKNOWN"/u);
    expect(liveDriver).toMatch(/safeDiagnostics\.diagnostics\?\.exitCode/u);
    expect(liveDriver).toMatch(/safeDiagnostics\.diagnostics\?\.stderrCategory/u);
    expect(liveDriver).toMatch(/throw new Error\(`AGENT_OUTPUT_MISSING:ROLE_\$\{role\}:EXIT_\$\{processExitCode\}:STDERR_CATEGORY_\$\{stderrCategory\}:TOOL_COUNTS_[^`]*JSON\.stringify\(toolCounts\)/u);
    expect(liveDriver).toMatch(/expect\(outcome\.success, `\$\{role\} controlled result outcome=\$\{safeOutcome\}; workspace\.read=\$\{JSON\.stringify\(workspaceReadCounts\)\}; toolCounts=\$\{safeToolCounts\}`\)\.toBe\(true\)/u);
    expect(liveDriver).not.toMatch(/AGENT_OUTPUT_MISSING:[^\n]*(?:stdout=|stderr=|outcome\.output)/iu);
  });

  it.each([
    ["AC-1 — project.test ran node test/smoke.js; exitCode=0, success=true. GET /health statusCode=200; parsed JSON deep-equals { status: 'ok' }. GET / statusCode=404.", true],
    ["AC-1 — Command: npm run test. Observed: exitCode=0, success=true. GET /health statusCode=200; parsed JSON deep-equals { status: 'ok' }. GET / statusCode=404.", true],
    ["AC-1 — project.test ran node test/smoke.js; exitCode=1, success=false. GET /health statusCode=200; parsed JSON deep-equals { status: 'ok' }. GET / statusCode=404.", true],
    ["AC-1 — project.test ran node test/smoke.js. GET /health statusCode=200; parsed JSON deep-equals { status: 'ok' }. GET / statusCode=404.", true],
    ["AC-1 — GET /health statusCode=200; parsed JSON deep-equals { status: 'ok' }. GET / statusCode=404.", false],
    ["AC-1 — project.test ran node test/smoke.js; exitCode=0, success=true. GET /health statusCode=200; JSON status was not ok. GET / statusCode=404.", false],
    ["AC-1 — project.test ran node test/smoke.js; exitCode=0, success=true. GET /health statusCode=200; JSON parsing failed. GET / statusCode=404.", false],
    ["AC-1 — project.test ran node test/smoke.js; exitCode=0, success=true. GET /health statusCode=200; parsed JSON deep-equals { status: 'ok' }. GET / statusCode=200.", false],
  ])("requires reported QA health checks without parsing model claims of test success (%s)", (evidence, expected) => {
    expect(hasHealthAcceptanceEvidence([evidence])).toBe(expected);
  });

  it("keeps genuine token usage while accepting unavailable Hermes cost", () => {
    const source = readFileSync(new URL("./v1-autonomous-task.test.ts", import.meta.url), "utf8");
    const liveDriver = source.slice(source.lastIndexOf('it("runs the real Hermes managed-worktree acceptance when opted in"'));
    expect(liveDriver).not.toContain("cost: expect.any(Number)");
    expect(liveDriver).toContain("cost: null");
    expect(liveDriver).toMatch(/completedRun\.inputTokens[\s\S]*?toBeGreaterThan\(0\)/u);
    expect(liveDriver).toMatch(/completedRun\.outputTokens[\s\S]*?toBeGreaterThan\(0\)/u);
  });

  it("bounds four Hermes roles and requires verified teardown before fixture deletion", () => {
    const source = readFileSync(new URL("./v1-autonomous-task.test.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const HERMES_RUN_TIMEOUT_MS = 300_000/u);
    expect(source).toMatch(/const HERMES_LIVE_TEST_TIMEOUT_MS = 4 \* \(HERMES_RUN_TIMEOUT_MS \+ MCP_HANDSHAKE_TIMEOUT_MS\) \+ ACCEPTANCE_TEARDOWN_TIMEOUT_MS \+ 120_000/u);
    expect(source).toMatch(/const safeToRemove = await settleAcceptanceProcesses\([\s\S]*?if \(!safeToRemove\)[\s\S]*?throw new Error\("PLAN04_TEARDOWN_STOP_UNVERIFIED"\)[\s\S]*?await rm\(tmpDir/u);
  });

  async function prepareCleanupFixtureRun(): Promise<{ run: AgentRun; service: RunService }> {
    const service = new RunService(db!, new DeterministicRuntime(db!));
    const options = {
      role: "Developer", model: "deterministic-test-runtime", taskId, epicId: null,
      triggerReason: "task-assignment", contextVersion: "cleanup-regression", outputSchemaVersion: "1",
      capability: { workspace: masterRepoPath }, prompt: "Test-only prepared Run for cleanup proof.",
    } satisfies StartRunOptions;
    const run = await service.prepareRunWithHermesPreflight({
      ...options,
      contextInput: createRunContextInput(options, {
        prompt: options.prompt, roleInputs: {},
        workspaceIdentity: { repository: masterRepoPath, workspace: masterRepoPath, worktree: taskId },
        targetHead: null, targetBranch: "master",
      }),
    });
    return { run, service };
  }

  it("awaits tracked execution and verified cancellation before allowing deletion", async () => {
    const { run, service } = await prepareCleanupFixtureRun();
    let finishExecution!: () => void;
    const execution = new Promise<void>((resolve) => { finishExecution = resolve; });
    const tracks = new Map<string, TrackedAcceptanceRun>([[run.id, {
      execution,
      service: { cancelRun: async (runId) => {
        markFakeRunNeverLaunched(db!, runId);
        await service.cancelRun(runId);
        finishExecution();
      } },
    }]]);
    expect(await settleAcceptanceProcesses(db, tracks, new Set(), 100)).toBe(true);
    expect(hasTerminalStoppedRun(db!, run.id)).toBe(true);
  });

  it("retains the fixture when cancellation or tracked execution lacks proof", async () => {
    const { run, service } = await prepareCleanupFixtureRun();
    const tracks = new Map<string, TrackedAcceptanceRun>([[run.id, {
      service: { cancelRun: async () => undefined },
    }]]);
    expect(await settleAcceptanceProcesses(db, tracks, new Set(), 100)).toBe(false);
    markFakeRunNeverLaunched(db!, run.id);
    await service.cancelRun(run.id);
    tracks.set(run.id, { service, execution: new Promise(() => undefined) });
    expect(await settleAcceptanceProcesses(db, tracks, new Set(), 20)).toBe(false);
  });

  it("kills and awaits close of a stalled MCP handshake child", async () => {
    const cli = join(tmpDir, "stalled-mcp.mjs");
    await writeFile(cli, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
    const children = trackedMcpChildren;
    await expect(runMcpHandshake(cli, tmpDir, "unused", "unused", { children, timeoutMs: 100 }))
      .rejects.toThrow("MCP_HANDSHAKE_TIMEOUT");
    expect(children.size).toBe(0);
  });

  it("runs the real Hermes managed-worktree acceptance when opted in", async ({ skip }) => {
    if (process.env.RUN_HERMES_E2E !== "1") skip("opt in with RUN_HERMES_E2E=1");

    const onboardingRepositoryPath = db?.get<{ repository_path: string }>(
      "SELECT repository_path FROM onboarding_configs WHERE project_id=$projectId",
      { projectId },
    )?.repository_path;
    expect(onboardingRepositoryPath).toBe(masterRepoPath);

    const worktree = await worktreeManager.createTaskWorkspace(taskId, masterRepoPath, "master");
    const mcpCli = join(import.meta.dirname, "../../src/bin/ebb-orchestrator-mcp.ts");
    const databasePath = join(tmpDir, ".ebb-orchestrator", "acceptance.db");
    const resultDirectory = join(tmpDir, "hermes-results");
    const workspaceByRun = new Map<string, string>();
    let nextWorkspace = worktree.path;
    const executor = new ProcessExecutor();
    const supervisor = process.platform === "win32"
      ? new WindowsJobSupervisor(executor)
      : new SystemdRunSupervisor(executor);
    const runtime = new HermesRuntimeAdapter(executor, undefined, {
      managedWorktreeForRun: (run) => workspaceByRun.get(run.id) ?? nextWorkspace,
      resultDirectory,
      checkpointDirectory: join(tmpDir, "hermes-checkpoints"),
      timeoutMs: HERMES_RUN_TIMEOUT_MS,
      roleLimit: 40,
      databasePath,
      mcpCommand: process.execPath,
      mcpArgs: ["--import", tsxLoader, mcpCli],
    }, supervisor);
    const runs = new RunService(db!, runtime);
    driverReady(workflow, taskId);
    const roles = ["Developer", "Reviewer", "QA", "Integration"];
    const projectTestCountsByRun = new Map<string, { uses: number; results: number; successes: number; errors: number } | undefined>();
    type HermesRoleSubmission = {
      outcome?: string; version?: string; commitSha?: string; independent?: boolean;
      findings?: unknown[]; evidence?: string[]; baseSha?: string; sourceSha?: string; provenance?: string[];
    };
    const runHermesRole = async (
      role: string, roleWorkspace: string, preparedRun: AgentRun,
    ): Promise<HermesRoleSubmission> => {
      expect(preparedRun.status).toBe("STARTED");
      const capabilityRef = preparedRun.capabilityRef;
      if (!capabilityRef) throw new Error(`${role} run did not receive a capability reference`);
      if (teardownStarted) throw new Error("PLAN04_TEARDOWN_STARTED");
      const handshake = await runMcpHandshake(mcpCli, roleWorkspace, databasePath, capabilityRef, { children: trackedMcpChildren });
      expect(handshake).toContain('"name":"ebb-orchestrator-mcp"');
      expect(handshake).toContain('"submit_result"');
      expect(handshake).toContain('"id":1');
      expect(handshake).toContain('"id":2');
      expect(handshake).toMatch(/"inputSchema":\{"type":"object"/);
      if (role === "Integration") expect(handshake).toContain('"project.test"');

      if (teardownStarted) throw new Error("PLAN04_TEARDOWN_STARTED");
      const execution = runs.executePreparedRun(preparedRun.id);
      trackedRuns.set(preparedRun.id, { service: runs, execution });
      void execution.catch(() => undefined);
      const settledExecution = await execution.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!settledExecution.ok) {
        const errorMessage = settledExecution.error instanceof Error ? settledExecution.error.message : "";
        if (!/^AGENT_OUTPUT_MISSING:/u.test(errorMessage)) throw settledExecution.error;
        let toolCounts: unknown = null;
        let processExitCode = "UNKNOWN";
        let stderrCategory = "UNKNOWN";
        try {
          const safeDiagnostics = await runtime.collectResult(preparedRun.id);
          toolCounts = safeDiagnostics.diagnostics?.toolCounts ?? null;
          const exitCode = safeDiagnostics.diagnostics?.exitCode;
          if (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) processExitCode = String(exitCode);
          stderrCategory = safeDiagnostics.diagnostics?.stderrCategory ?? "UNKNOWN";
        } catch {
          // Ошибка повторного чтения не должна раскрывать содержимое Hermes stream.
        }
        throw new Error(`AGENT_OUTPUT_MISSING:ROLE_${role}:EXIT_${processExitCode}:STDERR_CATEGORY_${stderrCategory}:TOOL_COUNTS_${JSON.stringify(toolCounts)}`);
      }
      const { run: completedRun, outcome } = settledExecution.value;
      expect(completedRun.id).toBe(preparedRun.id);
      expect(completedRun.status, `${role} must have a durable completed MCP submission`).toBe("COMPLETED");
      const submitted = JSON.parse(outcome.output) as HermesRoleSubmission;
      const safeOutcome = ["COMPLETED", "BLOCKED", "PASS", "FAIL"].includes(submitted.outcome ?? "") ? submitted.outcome! : "UNKNOWN";
      const safeToolCounts = JSON.stringify(outcome.diagnostics?.toolCounts ?? null);
      const workspaceReadCounts = outcome.diagnostics?.toolCounts?.["workspace.read"] ?? null;
      projectTestCountsByRun.set(preparedRun.id, outcome.diagnostics?.toolCounts?.["project.test"]);
      expect(outcome.success, `${role} controlled result outcome=${safeOutcome}; workspace.read=${JSON.stringify(workspaceReadCounts)}; toolCounts=${safeToolCounts}`).toBe(true);
      expect(outcome.validatedSubmission).toBe(true);
      expect(hasStoppedOwner(db!, preparedRun.id)).toBe(true);
      expect(db!.get<{ id: string; role: string; status: string; output: string }>(
        "SELECT id, role, status, output FROM agent_runs WHERE id = $id", { id: preparedRun.id },
      )).toEqual({ id: preparedRun.id, role, status: "COMPLETED", output: outcome.output });
      if (role !== "Developer") expect(submitted.outcome).toBeTruthy();
      expect(submitted.version, `${role} submitted structured-result version`).toBe("1.0.0");
      expect(createHash("sha256").update(readFileSync(join(roleWorkspace, "test/smoke.js"))).digest("hex"), `${role} changed the trusted smoke test`).toBe(smokeTestSha256);
      if (role === "Developer") {
        expect(safeOutcome, `Developer result outcome=${safeOutcome}; toolCounts=${safeToolCounts}`).toBe("COMPLETED");
        const actualHead = (await new GitCli().run(roleWorkspace, ["rev-parse", "HEAD"])).stdout.trim();
        expect(submitted.commitSha).toBe(actualHead);
      }
      if (role === "Reviewer") {
        expect(submitted.outcome, "Reviewer must explicitly pass before the workflow advances").toBe("PASS");
        expect(submitted.independent).toBe(true);
        expect(submitted.findings).toEqual(expect.any(Array));
      }
      if (role === "QA") {
        expect(submitted.outcome, "QA must explicitly pass before the workflow advances").toBe("PASS");
        const safeEvidenceFacts = summarizeHealthAcceptanceEvidence(submitted.evidence ?? []);
        expect(hasHealthAcceptanceEvidence(submitted.evidence ?? []), `QA_EVIDENCE_FACTS_${JSON.stringify(safeEvidenceFacts)}`).toBe(true);
        expect(submitted.evidence?.every((evidence) => /AC-\d+/.test(evidence) && evidence.length > 0)).toBe(true);
        const projectTestCounts = outcome.diagnostics?.toolCounts?.["project.test"];
        expect(
          projectTestCounts !== undefined && projectTestCounts.successes > 0,
          `QA_PROJECT_TEST_COUNTS_${JSON.stringify(projectTestCounts ?? null)}`,
        ).toBe(true);
      }
      expect(completedRun.inputTokens, `${role} emitted no genuine input usage`).toBeGreaterThan(0);
      expect(completedRun.outputTokens, `${role} emitted no genuine output usage`).toBeGreaterThan(0);
      expect(completedRun.cost).toBeNull();
      return submitted;
    };
       const contract: PromptTaskContract = { id: taskId, priority: "p0", goal: "Add GET /health", context: "health check service", requirements: ["GET /health returns 200"], acceptanceCriteria: ["Use project.test to run node test/smoke.js successfully (exitCode=0, success=true); verify GET /health returns statusCode 200 and parsed JSON deep-equals { status: 'ok' }, and GET / returns statusCode 404."], dependencies: [], nonGoals: ["no auth changes"], definitionOfDone: ["tests pass"] };
       const smokeTestSha256 = createHash("sha256").update(readFileSync(join(masterRepoPath, "test/smoke.js"))).digest("hex");
       const context = new ContextBuilder();
       const prompts = new PromptBuilder();
       const targetHead = (await new GitCli().run(masterRepoPath, ["rev-parse", "master"])).stdout.trim();
       const qaEnvironment = `workspace=${worktree.path}\nQA evidence format: report the observed project.test command and exitCode=0, success=true, then report GET /health statusCode=200, parsed JSON deep-equals { status: 'ok' }, and GET / statusCode=404. Include only facts verified by the project.test result; report a failed or missing check as a failure.`;
       for (const role of ["Developer", "Reviewer", "QA"]) {
        if (teardownStarted) throw new Error("PLAN04_TEARDOWN_STARTED");
         let roleInputs: unknown = {};
         const prompt = role === "Developer"
           ? prompts.buildDeveloperPrompt({ taskContract: context.buildDeveloperPackage({ taskContract: contract, workspaceMeta: { repoPath: worktree.path, branch: `task/${taskId}`, commitHash: "managed" } }).taskContract, workspaceMeta: { repoPath: worktree.path, branch: `task/${taskId}` }, outputInstructions: DEVELOPER_COMMIT_SHA_INSTRUCTION })
           : role === "Reviewer"
             ? (roleInputs = { gitDiff: "Read the current worktree diff", checks: ["inspect committed implementation"] }, prompts.buildReviewerPrompt({ taskContract: context.buildReviewerPackage({ taskContract: contract, gitDiff: "Read the current worktree diff", checks: ["inspect committed implementation"] }).taskContract, gitDiff: "Read the current worktree diff", checks: ["inspect committed implementation"] }))
             : (roleInputs = { environment: qaEnvironment }, prompts.buildQAPrompt({ taskContract: context.buildQAPackage({ taskContract: contract, environment: qaEnvironment }).taskContract, environment: qaEnvironment }));
         const options = { role, model: process.env.HERMES_MODEL ?? "default", taskId, epicId: null, triggerReason: "task-assignment", contextVersion: "hermes-acceptance-v1", outputSchemaVersion: "1", capability: { workspace: worktree.path, allowedTools: ["workspace.read", "workspace.search", "workspace.patch", "project.test", "git.status", "git.diff", "git.add", "git.commit", "git.head", "submit_result"] } } satisfies StartRunOptions;
         const run = await runs.prepareRunWithHermesPreflight({ ...options, prompt, contextInput: createRunContextInput(options, { prompt, roleInputs, workspaceIdentity: { repository: masterRepoPath, workspace: worktree.path, worktree: taskId }, targetHead, targetBranch: "master" }) });
        trackedRuns.set(run.id, { service: runs });
        workspaceByRun.set(run.id, worktree.path);
        await runHermesRole(role, worktree.path, run);
        advanceRealStage(workflow, taskId, role);
      }
        if (teardownStarted) throw new Error("PLAN04_TEARDOWN_STARTED");
       const integrationWorkspace = join(tmpDir, "real-integration");
       const integrationRunId = randomUUID();
       const integrationService = new IntegrationService({ worktreeDir: integrationWorkspace, database: db!, provenanceDatabasePath: databasePath, integrationRunId });
         const preparedIntegration = await integrationService.prepareIntegration(`task/${taskId}`, "master", masterRepoPath);
         const expectedTargetSha = requireNonBlankString(preparedIntegration.expectedTargetSha, "Prepared Integration target SHA");
         const provenanceDatabasePath = requireNonBlankString(preparedIntegration.provenanceDatabasePath, "Prepared Integration provenance database path");
         const integrationPrompt = new PromptBuilder().buildIntegrationPrompt({ taskContract: contract, workspace: preparedIntegration.worktreePath, targetRef: "master", checks: ["call the project.test MCP tool and verify its returned result (do not run the smoke test directly as a substitute)", "verify target and task provenance"], expectedTargetSha, sourceSha: preparedIntegration.sourceSha, integrationAttemptId: preparedIntegration.id, provenanceDatabasePath });
        nextWorkspace = preparedIntegration.worktreePath;
         const integrationOptions = { runId: integrationRunId, role: "Integration", model: process.env.HERMES_MODEL ?? "default", taskId, epicId: null, triggerReason: "integration", contextVersion: "hermes-acceptance-v1", outputSchemaVersion: "1", capability: { workspace: preparedIntegration.worktreePath, allowedTools: ["workspace.read", "workspace.search", "git.diff", "project.test", "submit_result"] } } satisfies StartRunOptions;
         const integrationRun = await runs.prepareRunWithHermesPreflight({ ...integrationOptions, prompt: integrationPrompt, contextInput: createRunContextInput(integrationOptions, { prompt: integrationPrompt, roleInputs: { sourceSha: preparedIntegration.sourceSha, targetSha: expectedTargetSha, attemptId: preparedIntegration.id, provenanceDatabasePath }, workspaceIdentity: { repository: masterRepoPath, workspace: preparedIntegration.worktreePath, worktree: preparedIntegration.id }, targetHead: expectedTargetSha, targetBranch: "master" }) });
        trackedRuns.set(integrationRun.id, { service: runs });
        workspaceByRun.set(integrationRun.id, preparedIntegration.worktreePath);
        const realIntegration = integrationService.bindIntegrationRun(preparedIntegration, integrationRun.id);
        expect(realIntegration.integrationRunId).toBe(integrationRun.id);
        await integrationService.mergePreparedSource(realIntegration);
        runs.bindInitialIntegrationWorkspaceSnapshot(integrationRun.id);
        const submitted = await integrationService.runInIntegrationWorktree(realIntegration, async () => {
          expect(db!.get<{ status: string; integration_run_id: string }>(
            "SELECT status, integration_run_id FROM integration_attempts WHERE id = $id", { id: realIntegration.id },
          )).toEqual({ status: "MERGING", integration_run_id: integrationRun.id });
          return runHermesRole("Integration", realIntegration.worktreePath, integrationRun);
        });
        expect(submitted.outcome).toBe("PASS");
        expect(submitted.version).toBe("1.0.0");
         expect(submitted.baseSha).toBe(realIntegration.expectedTargetSha);
         expect(submitted.sourceSha).toBe(realIntegration.sourceSha);
         const projectTestEvidence = submitted.evidence?.find((entry) => /(?:project\.test|project_test)/i.test(entry));
         expect(projectTestEvidence).toEqual(expect.any(String));
         const integrationProjectTestCounts = projectTestCountsByRun.get(integrationRun.id);
         expect(
           integrationProjectTestCounts !== undefined && integrationProjectTestCounts.successes > 0,
           `INTEGRATION_PROJECT_TEST_COUNTS_${JSON.stringify(integrationProjectTestCounts ?? null)}`,
         ).toBe(true);
        expect(submitted.provenance).toEqual(expect.arrayContaining([
          expect.stringContaining(realIntegration.id),
        ]));
        expect(db!.get<{ id: string; repository_path: string; source_branch: string; target_branch: string; expected_target_sha: string; source_sha: string; worktree_path: string; integration_run_id: string; status: string }>(
          "SELECT id, repository_path, source_branch, target_branch, expected_target_sha, source_sha, worktree_path, integration_run_id, status FROM integration_attempts WHERE id = $id", { id: realIntegration.id },
        )).toEqual({ id: realIntegration.id, repository_path: realIntegration.repoPath, source_branch: realIntegration.sourceBranch, target_branch: realIntegration.currentTargetBranch, expected_target_sha: realIntegration.expectedTargetSha, source_sha: realIntegration.sourceSha, worktree_path: realIntegration.worktreePath, integration_run_id: integrationRun.id, status: "MERGED" });
      advanceRealStage(workflow, taskId, "Integration");
     expect(db!.all<{ role: string; task_id: string; status: string }>("SELECT role, task_id, status FROM agent_runs WHERE task_id = $id ORDER BY started_at", { id: taskId })).toEqual(roles.map((role) => ({ role, task_id: taskId, status: "COMPLETED" })));
    expect(workflow.currentStage(taskId)).toBe("READY_FOR_MERGE");
       const integration = realIntegration;
        mergeService = new MergeService({ approvalStore: new Map(), repoPath: masterRepoPath, integrationAttempt: integration, database: db! });
      const masterSha = (await new GitCli().run(masterRepoPath, ["rev-parse", "master"])).stdout.trim();
       expect(integration.expectedTargetSha).toBe(masterSha);
       const integrationHead = (await new GitCli().run(integration.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
       expect((await new GitCli().run(integration.worktreePath, ["merge-base", "--is-ancestor", masterSha, integrationHead])).exitCode).toBe(0);
       expect((await new GitCli().run(integration.worktreePath, ["merge-base", "--is-ancestor", integration.sourceSha, integrationHead])).exitCode).toBe(0);
      expect(db!.get<{ id: string; role: string; status: string; output: string }>("SELECT id, role, status, output FROM agent_runs WHERE id = $id", { id: integrationRun.id })).toMatchObject({ id: integrationRun.id, role: "Integration", status: "COMPLETED", output: expect.stringContaining('"outcome":"PASS"') });
     expect(readFileSync(join(integration.worktreePath, "src", "server.js"), "utf8")).toContain("/health");
     await integrationService.cleanupIntegration(integration);
     const approval = approvalService.request({ type: "FINAL_MERGE", subjectId: taskId, subjectType: "TASK", requestedBy: "orchestrator" });
     expect(approval).toMatchObject({ id: expect.any(String), type: "FINAL_MERGE", subjectId: taskId, subjectType: "TASK", status: "PENDING" });
    expect(approval.status).toBe("PENDING");
    const approved = approvalService.approve(approval.id, "test-human", "real Hermes acceptance approval");
    mergeService.registerApproval({ id: approved.id, subjectId: approved.subjectId, type: approved.type, status: approved.status });
    workflow.transition(taskId, "MERGING", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: true, parentEpicReleased: false });
     expect(approved).toMatchObject({ id: approval.id, type: "FINAL_MERGE", subjectId: taskId, subjectType: "TASK", status: "APPROVED", resolvedBy: "test-human" });
     expect(db!.get<{ id: string; type: string; subject_id: string; subject_type: string; status: string }>("SELECT id, type, subject_id, subject_type, status FROM approvals WHERE id = $id", { id: approval.id })).toEqual({ id: approval.id, type: "FINAL_MERGE", subject_id: taskId, subject_type: "TASK", status: "APPROVED" });
     expect((await mergeService.mergeApproved(taskId, approved.id)).success).toBe(true);
    expect(readFileSync(join(masterRepoPath, "src", "server.js"), "utf8")).toContain("/health");
    workflow.transition(taskId, "DONE");
    await worktreeManager.removeWorkspace(worktree.id);
    expect(workflow.currentStage(taskId)).toBe("DONE");
    expect(db!.get<{ removed_at: string | null }>("SELECT removed_at FROM worktrees WHERE id = $id", { id: taskId })?.removed_at).not.toBeNull();
     expect(db!.all<{ role: string; task_id: string; input_tokens: number; cached_input_tokens: number; output_tokens: number; cost: null }>("SELECT role, task_id, input_tokens, cached_input_tokens, output_tokens, cost FROM agent_runs WHERE task_id = $id ORDER BY started_at", { id: taskId })).toEqual(roles.map((role) => ({ role, task_id: taskId, input_tokens: expect.any(Number), cached_input_tokens: expect.any(Number), output_tokens: expect.any(Number), cost: null })));
     const events = db!.all<{ type: string; aggregate_id: string; payload_json: string }>("SELECT type, aggregate_id, payload_json FROM outbox_events WHERE aggregate_id = $id ORDER BY created_at", { id: taskId });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "ApprovalRequested", aggregate_id: taskId, payload_json: expect.stringContaining(`"approvalId":"${approval.id}"`) }),
        expect.objectContaining({ type: "ApprovalApproved", aggregate_id: taskId, payload_json: expect.stringContaining(`"approvalId":"${approval.id}"`) }),
      ]));
      for (const event of events.filter((item) => item.type === "ApprovalRequested" || item.type === "ApprovalApproved")) {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        expect(payload.approvalId).toBe(approval.id);
        expect(payload.approvalType).toBe("FINAL_MERGE");
        expect(payload.subjectId).toBe(taskId);
        expect(payload.subjectType).toBe("TASK");
      }
  }, HERMES_LIVE_TEST_TIMEOUT_MS);
});

function driverReady(engine: WorkflowEngine, id: string): void { engine.transition(id, "READY"); }

async function runMcpHandshake(
  cli: string, workspace: string, database: string, capabilityRef: string,
  options: { children?: Set<ChildProcessWithoutNullStreams>; timeoutMs?: number } = {},
): Promise<string> {
  const children = options.children ?? new Set<ChildProcessWithoutNullStreams>();
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--database", database, "--capability-ref", capabilityRef], {
    cwd: workspace, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let outputBytes = 0;
    let failure: string | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill("SIGKILL");
      closeTimer ??= setTimeout(() => reject(new Error("MCP_HANDSHAKE_STOP_UNPROVEN")), 5_000);
    };
    const timer = setTimeout(() => stop("MCP_HANDSHAKE_TIMEOUT"), options.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 65_536) stop("MCP_HANDSHAKE_OUTPUT_LIMIT");
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 65_536) stop("MCP_HANDSHAKE_OUTPUT_LIMIT");
    });
    child.once("error", () => stop("MCP_HANDSHAKE_SPAWN_FAILED"));
    child.stdin.on("error", () => stop("MCP_HANDSHAKE_INPUT_FAILED"));
    child.once("close", (code) => {
      clearTimeout(timer);
      if (closeTimer) clearTimeout(closeTimer);
      children.delete(child);
      if (failure) reject(new Error(failure));
      else if (code !== 0) reject(new Error("MCP_HANDSHAKE_EXIT_NONZERO"));
      else resolve(stdout);
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  });
}
function advanceRealStage(engine: WorkflowEngine, id: string, role: string): void {
  if (role === "Developer") engine.transition(id, "DEVELOPMENT");
  if (role === "Reviewer") engine.transition(id, "REVIEW");
  if (role === "QA") engine.transition(id, "QA", { hasReviewPassed: true, hasSuccessfulIntegration: false, hasFinalMergeApproval: false, parentEpicReleased: false });
  if (role === "Integration") {
    engine.transition(id, "READY_FOR_INTEGRATION");
    engine.transition(id, "INTEGRATION");
    engine.transition(id, "READY_FOR_MERGE");
  }
}
