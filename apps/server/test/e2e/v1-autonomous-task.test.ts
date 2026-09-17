/**
 * Plan 4 infrastructure coverage and opt-in real Hermes acceptance.
 *
 * The deterministic fallback is always runnable. The real Hermes subprocess
 * scenario is opt-in because Hermes is not a CI dependency.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
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
import { McpServer } from "../../src/modules/execution/mcp/mcp-server.js";
import { RunCapability } from "../../src/modules/execution/run-capability.js";
import { GitTools } from "../../src/modules/execution/git-tools.js";
import { PathResolver } from "../../src/platform/security/path-resolver.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { HermesRuntimeAdapter } from "../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { ProcessExecutor } from "../../src/platform/process/process-executor.js";
import { ContextBuilder } from "../../src/modules/context/context-builder.js";
import { PromptBuilder } from "../../src/modules/runtime/prompt-builder.js";
import type { TaskContract as PromptTaskContract } from "../../src/modules/context/context-types.js";

const execFileAsync = promisify(execFile);
const resolve = createRequire(import.meta.url).resolve;
const tsxLoader = pathToFileURL(resolve("tsx")).href;
const migrationFiles = ["001_system.sql", "002_work_domain.sql", "003_work_control.sql", "004_agent_runs.sql", "005_scheduler.sql", "006_recovery.sql", "007_git.sql", "008_quality.sql", "009_integration_provenance.sql", "010_planning.sql", "011_epic_orchestration.sql", "012_epic_runtime_authority.sql", "013_remove_legacy_scheduler_locks.sql", "014_migrate_legacy_scheduler_authority.sql", "015_knowledge.sql", "016_context.sql", "017_usage.sql", "018_scheduler_config_audit.sql"];
const migrations: Migration[] = migrationFiles.map((name, index) => ({
  version: index + 1,
  name: name.replace(".sql", ""),
  sql: readFileSync(join(import.meta.dirname, `../../src/platform/database/migrations/${name}`), "utf8"),
}));

class DeterministicRuntime implements AgentRuntime {
  active = 0;
  maxActive = 0;
  calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  async startRun(_run: AgentRun): Promise<void> {}
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
  constructor(
    private readonly db: Database,
    private readonly workflow: WorkflowEngine,
    private readonly runs: RunService,
    private readonly worktrees: WorktreeManager,
    private readonly git: GitCli,
    private readonly repoPath: string,
    private readonly taskId: string,
  ) {}

  ready(): void { this.workflow.transition(this.taskId, "READY"); }

  async reserveIntegrationRun(): Promise<string> {
    const run = await this.runs.startRun({ role: "Integration", model: "deterministic-test-runtime", taskId: this.taskId, epicId: null, triggerReason: "integration", contextVersion: "acceptance-v1", outputSchemaVersion: "1" });
    this.integrationRunId = run.id;
    return run.id;
  }

  async developer(): Promise<WorktreeRecord> {
    this.workflow.transition(this.taskId, "DEVELOPMENT");
    const worktree = await this.worktrees.createTaskWorkspace(this.taskId, this.repoPath, "master");
    const workspace = new ActionGateway(new PathResolver(), worktree.path);
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
    const run = await this.record("Reviewer", { outcome: "PASS", findings: [], independent: true }, "review");
    const diff = (await this.git.run(worktree.path, ["diff", "master", "HEAD"])).stdout;
    expect(diff).toContain("/health");
    expect(run.status).toBe("COMPLETED");
    this.workflow.transition(this.taskId, "QA", { hasReviewPassed: true, hasSuccessfulIntegration: false, hasFinalMergeApproval: false, parentEpicReleased: false });
  }

  async qa(worktree: WorktreeRecord): Promise<void> {
    await execFileAsync(process.execPath, ["test/smoke.js"], { cwd: worktree.path });
    await this.record("QA", { outcome: "PASS", evidence: ["AC-1: GET /health returns 200 and JSON status ok"] }, "qa");
    this.workflow.transition(this.taskId, "READY_FOR_INTEGRATION");
  }

  async integration(attempt: IntegrationAttempt): Promise<void> {
    this.workflow.transition(this.taskId, "INTEGRATION");
    const targetSha = (await this.git.run(this.repoPath, ["rev-parse", "master"])).stdout.trim();
    expect(attempt.expectedTargetSha).toBe(targetSha);
    expect((await this.git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).not.toBe(targetSha);
    expect(readFileSync(join(attempt.worktreePath, "src", "server.js"), "utf8")).toContain("/health");
     const mcp = new McpServer(new RunCapability({
       id: "integration-acceptance",
       role: "integration",
       workspace: attempt.worktreePath,
       allowedTools: ["project.test"],
       projectConfig: { commands: { test: { executable: process.execPath, args: ["test/smoke.js"] } } },
     }));
     expect(mcp.getAvailableTools().map((tool) => tool.name)).toContain("project.test");
     const testResponse = await mcp.processRequest({ jsonrpc: "2.0", id: "integration-test", method: "tools/call", params: { name: "project.test" } });
     expect(testResponse).toMatchObject({ jsonrpc: "2.0", id: "integration-test", result: { isError: false } });
     const testText = (testResponse as { result: { content: Array<{ text: string }> } }).result.content[0]?.text;
     if (!testText) throw new Error("project.test MCP response did not include result text");
     expect(JSON.parse(testText)).toMatchObject({ action: "test", success: true, exitCode: 0 });
    if (this.integrationRunId) {
      const output = { version: "1", outcome: "PASS" };
      await this.runs.completionStore().accept(this.runs.getCapabilityReference(this.integrationRunId), { runId: this.integrationRunId, role: "Integration", output });
      await this.runs.collectResult(this.integrationRunId, { success: true, exitCode: 0, output: JSON.stringify(output), validatedSubmission: true, diagnostics: { runId: this.integrationRunId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } });
      await this.runs.collectUsage(this.integrationRunId, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: 0 });
    } else await this.record("Integration", { outcome: "PASS", baseSha: targetSha, conflicts: [] }, "integration");
    this.workflow.transition(this.taskId, "READY_FOR_MERGE");
  }

  async record(role: string, output: object, triggerReason = "task-assignment"): Promise<AgentRun> {
    const run = await this.runs.startRun({ role, model: "deterministic-test-runtime", taskId: this.taskId, epicId: null, triggerReason, contextVersion: "acceptance-v1", outputSchemaVersion: "1" });
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
  let approvalService: ApprovalService;
   let mergeService: MergeService;
   let worktreeManager: WorktreeManager;
   let workflow: WorkflowEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-e2e-"));
    db = createSqliteDatabase(join(tmpDir, "acceptance.db"));
    runMigrations(db, migrations);
    // The current sqlite adapter rejects the expression-based UNIQUE clauses
    // in migration 007.  The managed-worktree repository only needs this
    // concrete table for the acceptance's cleanup assertion.
    db.exec(`CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, path TEXT NOT NULL,
      branch TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT
    )`);
    projectId = randomUUID(); taskId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,$name,$display_name,'ACTIVE',$created_at,$updated_at)", { id: projectId, name: "health-service", display_name: "Health Service", created_at: now, updated_at: now });
    db.run("INSERT INTO tasks (id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES ($id,$project_id,$display_id,$title,'DRAFT',$contract_json,1,$created_at,$updated_at)", { id: taskId, project_id: projectId, display_id: "TASK-HEALTH", title: "Add GET /health", contract_json: JSON.stringify({ version: 1, goal: "Add GET /health", context: "health check", requirements: ["GET /health returns 200"], acceptanceCriteria: ["returns 200 and JSON {status:'ok'}"], dependencies: [], nonGoals: ["no auth changes"], definitionOfDone: ["tests pass"] }), created_at: now, updated_at: now });
    masterRepoPath = await mkdtemp(join(tmpdir(), "master-repo-"));
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
    (globalThis as { acceptance?: AcceptanceWorkflow }).acceptance = new AcceptanceWorkflow(db, workflow, new RunService(db, new DeterministicRuntime()), worktreeManager, git, masterRepoPath, taskId);
  });

    afterEach(async () => { db?.close(); db = undefined; if (masterRepoPath) await rm(masterRepoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); if (tmpDir) await rm(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

  it("covers the workflow with the deterministic infrastructure fallback", async () => {
    const driver = (globalThis as unknown as { acceptance: AcceptanceWorkflow }).acceptance;
    driver.ready();
    const worktree = await driver.developer();
    await driver.reviewer(worktree);
    await driver.qa(worktree);
     const integrationService = new IntegrationService({ worktreeDir: join(tmpDir, "integration"), database: db!, integrationRunId: await driver.reserveIntegrationRun() });
     const integration = await integrationService.prepareIntegration(`task/${taskId}`, "master", masterRepoPath);
     await integrationService.mergePreparedSource(integration);
     const integrationRunId = integration.integrationRunId;
     expect(integrationRunId).toBeDefined();
     if (!integrationRunId) throw new Error("Integration attempt did not receive its reserved run ID");
      mergeService = new MergeService({ approvalStore: new Map(), repoPath: masterRepoPath, integrationAttempt: integration, database: db! });
      await integrationService.runInIntegrationWorktree(integration, async () => driver.integration(integration));
    const outcomes = db!.all<{ role: string; output: string }>("SELECT role, output FROM agent_runs WHERE task_id = $task_id ORDER BY started_at", { task_id: taskId });
    expect(outcomes.map((row) => row.role)).toEqual(["Developer", "Reviewer", "QA", "Integration"]);
    expect(JSON.parse(outcomes[1]!.output)).toMatchObject({ outcome: "PASS", findings: [] });
      expect(JSON.parse(outcomes[2]!.output)).toMatchObject({ outcome: "PASS" });
      expect(JSON.parse(outcomes[3]!.output)).toMatchObject({ outcome: "PASS" });
      expect(db!.get<{ id: string; role: string; status: string; output: string }>("SELECT id, role, status, output FROM agent_runs WHERE id = $id", { id: integrationRunId })).toMatchObject({ id: integrationRunId, role: "Integration", status: "COMPLETED", output: expect.stringContaining('"outcome":"PASS"') });
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
     const cleanup = new IntegrationService(); await cleanup.cleanupIntegration(integration);
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

  it("requires FINAL_MERGE approval for the exact task", async () => {
    const approval = approvalService.request({ type: "FINAL_MERGE", subjectId: taskId, subjectType: "TASK", requestedBy: "orchestrator" });
    expect(approval.status).toBe("PENDING");
    await expect(mergeService.mergeApproved(taskId, approval.id)).rejects.toThrow("Approval not found");
  });

  it("runs the real Hermes managed-worktree acceptance when opted in", async ({ skip }) => {
    if (process.env.RUN_HERMES_E2E !== "1") skip("opt in with RUN_HERMES_E2E=1");
    try {
      await execFileAsync("hermes", ["--version"]);
    } catch {
      skip("Hermes binary is unavailable; install/configure Hermes to run this acceptance");
    }
    if (!process.env.HERMES_MODEL) {
      skip("Hermes model is unavailable; set HERMES_MODEL to a configured local/model fixture");
    }

    const worktree = await worktreeManager.createTaskWorkspace(taskId, masterRepoPath, "master");
    const mcpCli = join(import.meta.dirname, "../../src/bin/ebb-orchestrator-mcp.ts");
    const databasePath = join(tmpDir, "acceptance.db");
    const resultDirectory = join(tmpDir, "hermes-results");
    const workspaceByRun = new Map<string, string>();
    let nextWorkspace = worktree.path;
    const runtime = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, {
      managedWorktreeForRun: (run) => workspaceByRun.get(run.id) ?? nextWorkspace,
      resultDirectory,
      timeoutMs: 180000,
      databasePath,
      mcpCommand: process.execPath,
       mcpArgs: ["--import", tsxLoader, mcpCli],
    });
    const runs = new RunService(db!, runtime);
    driverReady(workflow, taskId);
      const roles = ["Developer", "Reviewer", "QA", "Integration"];
      let integrationSubmitted: { baseSha?: string; sourceSha?: string; provenance?: string[] } | undefined;
      const runHermesRole = async (role: string, roleWorkspace: string, run: AgentRun): Promise<void> => {
        const capabilityRef = run.capabilityRef;
        if (!capabilityRef) throw new Error(`${role} run did not receive a capability reference`);
        const resultPath = join(resultDirectory, `${run.id}.json`);
        const config = readFileSync(join(resultDirectory, "profiles", run.id, "config.yaml"), "utf8");
        expect(config).toContain(`- "${capabilityRef}"`);
        expect(config).toContain(`- ${JSON.stringify(databasePath)}`);
        expect(config).toContain(`- ${JSON.stringify(resultPath)}`);
        const handshake = await runMcpHandshake(mcpCli, roleWorkspace, databasePath, capabilityRef);
        expect(handshake).toContain('"name":"ebb-orchestrator-mcp"');
        expect(handshake).toContain('"submit_result"');
        expect(handshake).toContain('"id":1');
        expect(handshake).toContain('"id":2');
        expect(handshake).toMatch(/"inputSchema":\{"type":"object"/);
      let inspected: AgentRun | undefined;
      for (let attempt = 0; attempt < 120 && !inspected; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try { inspected = await runtime.inspectRun(run.id); } catch { /* process still running */ }
      }
      expect(inspected, `${role} run did not finish`).toBeDefined();
       if (role === "Integration") return;
       const outcome = await runtime.collectResult(run.id);
       expect(outcome.success, `${role} did not submit a successful result: ${JSON.stringify(outcome)}`).toBe(true);
       const submitted = JSON.parse(outcome.output) as { outcome?: string; version?: string; commitSha?: string; independent?: boolean; findings?: unknown[]; evidence?: string[]; baseSha?: string; sourceSha?: string; provenance?: string[] };
      expect(submitted.outcome, `${role} submitted an invalid result`).toBeTruthy();
       expect(submitted.version).toBe("1");
        if (role === "Developer") {
          const actualHead = (await new GitCli().run(roleWorkspace, ["rev-parse", "HEAD"])).stdout.trim();
          expect(submitted.commitSha).toBe(actualHead);
        }
       if (role === "Reviewer") {
         expect(submitted.independent).toBe(true);
         expect(submitted.findings).toEqual(expect.any(Array));
       }
        if (role === "QA") {
          const criteria = ["returns 200 and JSON {\"status\":\"ok\"}"];
          expect(submitted.evidence).toEqual(expect.arrayContaining(criteria.map((criterion) => expect.stringContaining(criterion))));
          expect(submitted.evidence?.every((evidence) => /AC-\d+/.test(evidence) && evidence.length > 0)).toBe(true);
        }
        if (role === "Integration") {
          integrationSubmitted = submitted;
          expect(submitted.baseSha).toBe(realIntegration.expectedTargetSha);
          expect(submitted.sourceSha).toBe(realIntegration.sourceSha);
          const persisted = db!.get<{ id: string; repository_path: string; source_branch: string; target_branch: string; expected_target_sha: string; source_sha: string; worktree_path: string; integration_run_id: string; status: string }>("SELECT id, repository_path, source_branch, target_branch, expected_target_sha, source_sha, worktree_path, integration_run_id, status FROM integration_attempts WHERE id = $id", { id: realIntegration.id });
          expect(persisted).toEqual({ id: realIntegration.id, repository_path: realIntegration.repoPath, source_branch: realIntegration.sourceBranch, target_branch: realIntegration.currentTargetBranch, expected_target_sha: realIntegration.expectedTargetSha, source_sha: realIntegration.sourceSha, worktree_path: realIntegration.worktreePath, integration_run_id: integrationRun.id, status: "MERGING" });
          expect(submitted.provenance).toEqual(expect.arrayContaining([
            expect.stringContaining(realIntegration.id),
            expect.stringContaining(realIntegration.expectedTargetSha ?? ""),
            expect.stringContaining(realIntegration.sourceSha),
            expect.stringContaining(integrationRun.id),
          ]));
        }
       if (role !== "Integration") await runs.collectResult(run.id, outcome);
      const usage = await runtime.collectUsage(run.id);
      expect(usage.inputTokens + usage.outputTokens, `${role} emitted no genuine usage`).toBeGreaterThan(0);
       await runs.collectUsage(run.id, usage);
       };
       const contract: PromptTaskContract = { id: taskId, priority: "p0", goal: "Add GET /health", context: "health check service", requirements: ["GET /health returns 200"], acceptanceCriteria: ['returns 200 and JSON {"status":"ok"}'], dependencies: [], nonGoals: ["no auth changes"], definitionOfDone: ["tests pass"] };
       const context = new ContextBuilder();
       const prompts = new PromptBuilder();
       for (const role of ["Developer", "Reviewer", "QA"]) {
         const prompt = role === "Developer"
           ? prompts.buildDeveloperPrompt({ taskContract: context.buildDeveloperPackage({ taskContract: contract, workspaceMeta: { repoPath: worktree.path, branch: `task/${taskId}`, commitHash: "managed" } }).taskContract, workspaceMeta: { repoPath: worktree.path, branch: `task/${taskId}` }, outputInstructions: "Commit the implementation and submit commitSha." })
           : role === "Reviewer"
             ? prompts.buildReviewerPrompt({ taskContract: context.buildReviewerPackage({ taskContract: contract, gitDiff: "Read the current worktree diff", checks: ["inspect committed implementation"] }).taskContract, gitDiff: "Read the current worktree diff", checks: ["inspect committed implementation"] })
             : prompts.buildQAPrompt({ taskContract: context.buildQAPackage({ taskContract: contract, environment: `workspace=${worktree.path}` }).taskContract, environment: `workspace=${worktree.path}` });
         const run = await runs.startRun({ role, model: process.env.HERMES_MODEL ?? "default", taskId, epicId: null, triggerReason: "task-assignment", contextVersion: "hermes-acceptance-v1", outputSchemaVersion: "1", prompt, capability: { workspace: worktree.path, allowedTools: ["workspace.read", "workspace.patch", "git.status", "git.diff", "git.commit", "submit_result"] } });
        workspaceByRun.set(run.id, worktree.path);
        await runHermesRole(role, worktree.path, run);
        advanceRealStage(workflow, taskId, role);
      }
       const integrationWorkspace = join(tmpDir, "real-integration");
       const integrationService = new IntegrationService({ worktreeDir: integrationWorkspace, database: db! });
         const preparedIntegration = await integrationService.prepareIntegration(`task/${taskId}`, "master", masterRepoPath);
         await integrationService.mergePreparedSource(preparedIntegration);
         const integrationPrompt = new PromptBuilder().buildIntegrationPrompt({ taskContract: contract, workspace: preparedIntegration.worktreePath, targetRef: "master", checks: ["call the project.test MCP tool and verify its returned result (do not run the smoke test directly as a substitute)", "verify target and task provenance"], ...(preparedIntegration.expectedTargetSha ? { expectedTargetSha: preparedIntegration.expectedTargetSha } : {}), sourceSha: preparedIntegration.sourceSha, integrationAttemptId: preparedIntegration.id, ...(preparedIntegration.provenanceDatabasePath ? { provenanceDatabasePath: preparedIntegration.provenanceDatabasePath } : {}) });
        nextWorkspace = preparedIntegration.worktreePath;
         const integrationRun = await runs.startRun({ role: "Integration", model: process.env.HERMES_MODEL ?? "default", taskId, epicId: null, triggerReason: "integration", contextVersion: "hermes-acceptance-v1", outputSchemaVersion: "1", prompt: integrationPrompt, capability: { workspace: preparedIntegration.worktreePath, allowedTools: ["workspace.read", "workspace.search", "git.diff", "project.test", "submit_result"] } });
        workspaceByRun.set(integrationRun.id, preparedIntegration.worktreePath);
        const realIntegration = integrationService.bindIntegrationRun(preparedIntegration, integrationRun.id);
        expect(realIntegration.integrationRunId).toBe(integrationRun.id);
       await integrationService.runInIntegrationWorktree(realIntegration, async () => {
          await runHermesRole("Integration", realIntegration.worktreePath, integrationRun);
        });
        const integrationOutcome = await runtime.collectResult(integrationRun.id);
        expect(integrationOutcome.success).toBe(true);
         const submitted = JSON.parse(integrationOutcome.output) as { outcome?: string; version?: string; baseSha?: string; sourceSha?: string; provenance?: string[]; evidence?: string[] };
        integrationSubmitted = submitted;
        expect(submitted.outcome).toBe("PASS");
        expect(submitted.version).toBe("1");
        expect(submitted.baseSha).toBe(realIntegration.expectedTargetSha);
         expect(submitted.sourceSha).toBe(realIntegration.sourceSha);
         expect(submitted.evidence).toEqual(expect.arrayContaining([expect.stringMatching(/project\.test/)]));
         expect(submitted.evidence?.some((entry) => /project\.test/.test(entry) && /success|passed|exitCode.?0|status.?0/i.test(entry))).toBe(true);
        expect(submitted.provenance).toEqual(expect.arrayContaining([
          expect.stringContaining(realIntegration.id),
          expect.stringContaining(realIntegration.expectedTargetSha ?? ""),
          expect.stringContaining(realIntegration.sourceSha),
          expect.stringContaining(integrationRun.id),
        ]));
        await runs.collectResult(integrationRun.id, integrationOutcome);
        const integrationUsage = await runtime.collectUsage(integrationRun.id);
        await runs.collectUsage(integrationRun.id, integrationUsage);
        expect(integrationSubmitted).toBeDefined();
       expect(db!.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id = $id", { id: realIntegration.id })).toEqual({ status: "MERGED" });
       expect(integrationSubmitted?.baseSha).toBe(realIntegration.expectedTargetSha);
       expect(integrationSubmitted?.sourceSha).toBe(realIntegration.sourceSha);
      advanceRealStage(workflow, taskId, "Integration");
     expect(db!.all<{ role: string; task_id: string; status: string }>("SELECT role, task_id, status FROM agent_runs WHERE task_id = $id ORDER BY started_at", { id: taskId })).toEqual(roles.map((role) => ({ role, task_id: taskId, status: "COMPLETED" })));
    expect(workflow.currentStage(taskId)).toBe("READY_FOR_MERGE");
       const integration = realIntegration;
        mergeService = new MergeService({ approvalStore: new Map(), repoPath: masterRepoPath, integrationAttempt: integration, database: db! });
     const masterSha = (await new GitCli().run(masterRepoPath, ["rev-parse", "master"])).stdout.trim();
      expect(integration.expectedTargetSha).toBe(masterSha);
      expect((await new GitCli().run(integration.worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(masterSha);
      expect(db!.get<{ id: string; role: string; status: string; output: string }>("SELECT id, role, status, output FROM agent_runs WHERE id = $id", { id: integrationRun.id })).toMatchObject({ id: integrationRun.id, role: "Integration", status: "COMPLETED", output: expect.stringContaining('"outcome":"PASS"') });
     expect(readFileSync(join(integration.worktreePath, "src", "server.js"), "utf8")).toContain("/health");
     await new IntegrationService().cleanupIntegration(integration);
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
     expect(db!.all<{ role: string; task_id: string; input_tokens: number; cached_input_tokens: number; output_tokens: number; cost: number }>("SELECT role, task_id, input_tokens, cached_input_tokens, output_tokens, cost FROM agent_runs WHERE task_id = $id ORDER BY started_at", { id: taskId })).toEqual(roles.map((role) => ({ role, task_id: taskId, input_tokens: expect.any(Number), cached_input_tokens: expect.any(Number), output_tokens: expect.any(Number), cost: expect.any(Number) })));
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
  }, 240000);
});

function driverReady(engine: WorkflowEngine, id: string): void { engine.transition(id, "READY"); }

async function runMcpHandshake(cli: string, workspace: string, database: string, capabilityRef: string): Promise<string> {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "--database", database, "--capability-ref", capabilityRef], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  const output = new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`MCP exited ${code}: ${stderr}`)));
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.end();
  return output;
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
