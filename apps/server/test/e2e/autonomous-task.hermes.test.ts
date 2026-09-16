/**
 * Plan 4 acceptance scenario.
 *
 * The deterministic fallback is always runnable. The real Hermes subprocess
 * scenario is opt-in because Hermes is not a CI dependency.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
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
import { GitTools } from "../../src/modules/execution/git-tools.js";
import { PathResolver } from "../../src/platform/security/path-resolver.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { AgentRun } from "@orchestrator/contracts";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { HermesRuntimeAdapter } from "../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { prepareHermesProfile, generateConfigYaml } from "../../src/modules/runtime/hermes/hermes-profile.js";
import { McpServer } from "../../src/modules/execution/mcp/mcp-server.js";
import { RunCapability } from "../../src/modules/execution/run-capability.js";
import { ProcessExecutor } from "../../src/platform/process/process-executor.js";

const execFileAsync = promisify(execFile);
const migrationFiles = ["001_system.sql", "002_work_domain.sql", "003_work_control.sql", "004_agent_runs.sql", "005_scheduler.sql", "006_recovery.sql"];
const migrations: Migration[] = migrationFiles.map((name, index) => ({
  version: index + 1,
  name: name.replace(".sql", ""),
  sql: readFileSync(join(import.meta.dirname, `../../src/platform/database/migrations/${name}`), "utf8"),
}));

class DeterministicRuntime implements AgentRuntime {
  async startRun(_run: AgentRun): Promise<void> {}
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
    await this.git.run(attempt.worktreePath, ["merge", "--no-edit", `task/${this.taskId}`]);
    await execFileAsync(process.execPath, ["test/smoke.js"], { cwd: attempt.worktreePath });
    await this.record("Integration", { outcome: "PASS", baseSha: targetSha, conflicts: [] }, "integration");
    this.workflow.transition(this.taskId, "READY_FOR_MERGE");
  }

  async record(role: string, output: object, triggerReason = "task-assignment"): Promise<AgentRun> {
    const run = await this.runs.startRun({ role, model: "deterministic-test-runtime", taskId: this.taskId, epicId: null, triggerReason, contextVersion: "acceptance-v1", outputSchemaVersion: "1" });
     const completed = await this.runs.collectResult(run.id, { success: true, exitCode: 0, output: JSON.stringify(output) });
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
    db.exec(`CREATE TABLE worktrees (
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

  afterEach(async () => { db?.close(); db = undefined; if (masterRepoPath) await rm(masterRepoPath, { recursive: true, force: true }); if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

  it("completes Developer → Reviewer → QA → Integration before FINAL_MERGE", async () => {
    const driver = (globalThis as unknown as { acceptance: AcceptanceWorkflow }).acceptance;
    driver.ready();
    const worktree = await driver.developer();
    await driver.reviewer(worktree);
    await driver.qa(worktree);
    const integration = await new IntegrationService({ worktreeDir: join(tmpDir, "integration") }).prepareIntegration(`task/${taskId}`, "master", masterRepoPath);
    await driver.integration(integration);
    const outcomes = db!.all<{ role: string; output: string }>("SELECT role, output FROM agent_runs WHERE task_id = $task_id ORDER BY started_at", { task_id: taskId });
    expect(outcomes.map((row) => row.role)).toEqual(["Developer", "Reviewer", "QA", "Integration"]);
    expect(JSON.parse(outcomes[1]!.output)).toMatchObject({ outcome: "PASS", findings: [] });
    expect(JSON.parse(outcomes[2]!.output)).toMatchObject({ outcome: "PASS", evidence: ["AC-1: GET /health returns 200 and JSON status ok"] });
    expect(JSON.parse(outcomes[3]!.output)).toMatchObject({ outcome: "PASS", conflicts: [] });
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
     expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM outbox_events WHERE aggregate_id = $id AND type IN ('TaskStateChanged','ApprovalRequested','ApprovalApproved')", { id: taskId })?.count).toBeGreaterThanOrEqual(6);
     expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = $id AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL", { id: taskId })?.count).toBe(4);
  });

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

    const worktree = await worktreeManager.createTaskWorkspace(taskId, masterRepoPath, "master");
    const profile = prepareHermesProfile({
      capability: { role: "developer", workspace: worktree.path },
      orchestratorHome: tmpDir,
      toolsetPath: "mcp-orchestrator",
    });
    await mkdir(profile.hermesHome, { recursive: true });
    await writeFile(join(profile.hermesHome, "config.yaml"), generateConfigYaml({
      capability: { role: "developer", workspace: worktree.path },
      toolsetPath: "mcp-orchestrator",
    }));
    const mcp = new McpServer(new RunCapability({
      id: `cap-${taskId}`,
      role: "developer",
      workspace: worktree.path,
      allowedTools: ["workspace.read", "workspace.patch", "git.status", "git.diff", "git.commit", "submit_result"],
    }));
    expect((await mcp.processRequest({ method: "tools/list" })).result).toEqual(expect.arrayContaining([{ name: "submit_result", description: expect.any(String) }]));

    driverReady(workflow, taskId);
    const runtime = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, {
      managedWorktree: worktree.path,
      environment: profile.env,
      timeoutMs: 180000,
    });
    const runs = new RunService(db!, runtime);
    const roles = ["Developer", "Reviewer", "QA", "Integration"];
    for (const role of roles) {
      const run = await runs.startRun({ role, model: process.env.HERMES_MODEL ?? "default", taskId, epicId: null, triggerReason: "task-assignment", contextVersion: "hermes-acceptance-v1", outputSchemaVersion: "1" });
      let inspected: AgentRun | undefined;
      for (let attempt = 0; attempt < 120 && !inspected; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try { inspected = await runtime.inspectRun(run.id); } catch { /* process still running */ }
      }
      expect(inspected, `${role} run did not finish`).toBeDefined();
      const outcome = await runtime.collectResult(run.id);
      expect(outcome.success, `${role} did not submit a successful result`).toBe(true);
      await runs.collectResult(run.id, outcome);
      await runs.collectUsage(run.id, await runtime.collectUsage(run.id));
      advanceRealStage(workflow, taskId, role);
    }
    expect(db!.all<{ role: string }>("SELECT role FROM agent_runs WHERE task_id = $id ORDER BY started_at", { id: taskId }).map((row) => row.role)).toEqual(roles);
    expect(workflow.currentStage(taskId)).toBe("READY_FOR_MERGE");
    const approval = approvalService.request({ type: "FINAL_MERGE", subjectId: taskId, subjectType: "TASK", requestedBy: "orchestrator" });
    expect(approval.status).toBe("PENDING");
    const approved = approvalService.approve(approval.id, "test-human", "real Hermes acceptance approval");
    mergeService.registerApproval({ id: approved.id, subjectId: approved.subjectId, type: approved.type, status: approved.status });
    workflow.transition(taskId, "MERGING", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: true, parentEpicReleased: false });
    expect((await mergeService.mergeApproved(taskId, approved.id)).success).toBe(true);
    workflow.transition(taskId, "DONE");
    await worktreeManager.removeWorkspace(worktree.id);
    expect(workflow.currentStage(taskId)).toBe("DONE");
    expect(db!.get<{ removed_at: string | null }>("SELECT removed_at FROM worktrees WHERE id = $id", { id: taskId })?.removed_at).not.toBeNull();
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id = $id AND input_tokens IS NOT NULL", { id: taskId })?.count).toBe(4);
  });
});

function driverReady(engine: WorkflowEngine, id: string): void { engine.transition(id, "READY"); }

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
