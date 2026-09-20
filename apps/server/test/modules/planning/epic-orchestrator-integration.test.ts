import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { Database } from "../../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../../src/modules/workflow/templates.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { EpicOrchestrator, type IntegrationServiceFactory } from "../../../src/modules/planning/epic-orchestrator.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import type { RunOutcome } from "../../../src/modules/runtime/run-types.js";
import { DatabaseCompletionStore } from "../../../src/modules/execution/mcp/submit-result-tool.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import type { IntegrationAttempt, IntegrationService } from "../../../src/modules/git/integration-service.js";

class IntegrationRuntime implements AgentRuntime {
  active = 0;
  maxActive = 0;
  calls: Array<{ phase: string; role: string }> = [];
  private readonly completion: DatabaseCompletionStore;
  constructor(private readonly db: Database) { this.completion = new DatabaseCompletionStore(db); }
  async startRun(run: AgentRun): Promise<void> {
    this.calls.push({ phase: "integration", role: run.role });
    const output = { version: "1.0", outcome: "PASS", evidence: ["integration"] };
    if (!run.capabilityRef || !(await this.completion.accept(run.capabilityRef, { runId: run.id, role: run.role, output }))) throw new Error("completion rejected");
  }
  async collectResult(runId: string): Promise<RunOutcome> { const output = this.completion.getSubmission(runId)?.output ?? ""; return { success: true, exitCode: 0, output, validatedSubmission: true, diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } }; }
  async collectUsage(): Promise<{ inputTokens: number; cachedInputTokens: number; outputTokens: number; cost: number }> { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; }
  async resumeRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
  async inspectRun(): Promise<AgentRun> { throw new Error("not implemented"); }
  async runResult(runId: string): Promise<RunOutcome> { return this.collectResult(runId); }
  async healthCheck(): Promise<boolean> { return true; }
}

function migrations(): Migration[] {
  return readdirSync(join(import.meta.dirname, "../../../src/platform/database/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name, index) => ({ version: index + 1, name: name.slice(0, -4), sql: readFileSync(join(import.meta.dirname, "../../../src/platform/database/migrations", name), "utf8") }));
}

describe("EpicOrchestrator child integration wiring", () => {
  it("uses only persisted Git/onboarding refs and executes inside the bound integration worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-integration-wiring-"));
    const db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    try {
      runMigrations(db, migrations());
      const projectId = randomUUID();
      const epicId = randomUUID();
      const taskId = randomUUID();
      const now = new Date().toISOString();
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-1','E','IN_PROGRESS','{}',$now,$now)", { id: epicId, projectId, now });
      db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,$epicId,'TASK-1','T','INTEGRATION','{}',$now,$now)", { id: taskId, projectId, epicId, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,created_at,updated_at) VALUES($projectId,$repo,'{}',$proposed,'ACTIVE',$now,$now)", { projectId, repo: join(root, "journal-repo"), proposed: JSON.stringify({ defaultBranch: "persisted-target" }), now });
      db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,target_ref,created_at) VALUES($id,'WORKTREE','VERIFIED',$repo,$branch,'persisted-target',$now)", { id: randomUUID(), repo: join(root, "journal-repo"), branch: `task/${taskId}`, now });
      db.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,10,0,0)", { projectId });

      const attempt: IntegrationAttempt = { id: "integration-attempt", sourceBranch: `task/${taskId}`, currentTargetBranch: "persisted-target", expectedTargetBranch: "persisted-target", expectedTargetSha: "target-sha", sourceSha: "source-sha", worktreePath: join(root, "integration-worktree"), repoPath: join(root, "journal-repo"), status: "PREPARED", createdAt: now };
      const calls: string[] = [];
      const integrationService = {
        prepareIntegration: async (source: string, target: string, repo: string) => { calls.push(`prepare:${source}:${target}:${repo}`); return attempt; },
        bindIntegrationRun: (prepared: IntegrationAttempt, runId: string) => { calls.push(`bind:${runId}`); return { ...prepared, integrationRunId: runId }; },
        mergePreparedSource: async () => { calls.push("merge"); },
        runInIntegrationWorktree: async (_prepared: IntegrationAttempt, runner: (path: string, value: Readonly<IntegrationAttempt>) => Promise<unknown>) => { calls.push("execute"); return runner(attempt.worktreePath, attempt); },
      } as unknown as IntegrationService;
      let factoryContext: { repoPath: string; worktreeRoot: string; taskId: string; epicId: string } | undefined;
      const factory: IntegrationServiceFactory = (context) => { factoryContext = context; return integrationService; };
      const registry = new WorkflowRegistry();
      for (const template of Object.values(templates)) registry.register(template);
      const runtime = new IntegrationRuntime(db);
      const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), new RunService(db, runtime), {} as never, new SchedulerService(db), { integrationServiceFactory: factory, integrationWorktreeRoot: join(root, "integration-root") });
      const result = await (orchestrator as unknown as { runPhase: (epic: string, task: string, phase: string, role: string, request: unknown) => Promise<{ accepted: boolean }> }).runPhase(epicId, taskId, "integration", "integration", { phase: "integration", role: "integration", taskId, epicId, targetBranch: "attacker-controlled" });

      expect(result.accepted).toBe(true);
      expect(factoryContext).toEqual({ repoPath: join(root, "journal-repo"), worktreeRoot: join(root, "integration-root"), taskId, epicId });
      expect(calls.slice(0, 3)).toEqual([`prepare:task/${taskId}:persisted-target:${join(root, "journal-repo")}`, expect.stringMatching(/^bind:/), "merge"]);
      expect(calls.at(-1)).toBe("execute");
      expect(db.get<{ workspace: string }>("SELECT json_extract(capability_json,'$.workspace') AS workspace FROM agent_runs ORDER BY started_at DESC LIMIT 1")?.workspace).toBe(attempt.worktreePath);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")?.count).toBe(0);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
