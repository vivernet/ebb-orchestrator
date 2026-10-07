import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
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
import { EpicOrchestrator, type IntegrationServiceFactory, type IntegrationServiceFactoryContext } from "../../../src/modules/planning/epic-orchestrator.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import type { RunOutcome } from "../../../src/modules/runtime/run-types.js";
import { DatabaseCompletionStore } from "../../../src/modules/execution/mcp/submit-result-tool.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import type { IntegrationAttempt, IntegrationService } from "../../../src/modules/git/integration-service.js";
import { digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import { ProjectConfigService } from "../../../src/modules/projects/project-config-service.js";
import { ProjectConfigRepository } from "../../../src/modules/projects/project-config-repository.js";
import { parseProjectConfigYaml } from "../../../src/platform/config/project-config.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";
import { transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";

class IntegrationRuntime implements AgentRuntime {
  active = 0;
  maxActive = 0;
  calls: Array<{ phase: string; role: string }> = [];
  prompts: string[] = [];
  runIds: string[] = [];
  private readonly completion: DatabaseCompletionStore;
  constructor(private readonly db: Database) { this.completion = new DatabaseCompletionStore(db); }
  async startRun(run: AgentRun): Promise<void> {
    this.calls.push({ phase: "integration", role: run.role });
    this.runIds.push(run.id);
    this.prompts.push((run as AgentRun & { prompt?: string }).prompt ?? "");
    const attempt = this.db.get<{ id: string; expected_target_sha: string; source_sha: string }>(
      "SELECT id,expected_target_sha,source_sha FROM integration_attempts WHERE integration_run_id=$runId", { runId: run.id });
    if (!attempt) throw new Error("Integration attempt was not persisted before runner start");
    const output = {
      version: "1.0", outcome: "PASS", baseSha: attempt.expected_target_sha, sourceSha: attempt.source_sha,
      provenance: [`integration_attempt:${attempt.id}`], evidence: ["Verified prepared source SHA in the integration worktree"],
    };
    if (!run.capabilityRef || !(await this.completion.accept(run.capabilityRef, { runId: run.id, role: run.role, output }))) throw new Error("completion rejected");
    this.db.transaction((tx) => transitionRunProcessOwnerTx(tx, {
      runId: run.id, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
    }));
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
      const approvalId = randomUUID();
      const repoPath = join(root, "journal-repo");
      const taskWorktreePath = join(root, "task-worktree");
      const epicWorktreePath = join(root, "epic-worktree");
      const epicContract = JSON.stringify({ version: 1, goal: "Epic outcome remains authoritative", context: "Epic-wide product context", requirements: ["Epic requirement"], acceptanceCriteria: ["Epic acceptance"], dependencies: [], nonGoals: ["Epic non-goal"], definitionOfDone: ["Epic done"] });
      const taskContract = JSON.stringify({ version: 1, goal: "Task delivers the distinct persistence boundary", context: "Task-specific implementation context", requirements: ["Task requirement"], acceptanceCriteria: ["Task acceptance"], dependencies: ["Task dependency"], nonGoals: ["Task non-goal"], definitionOfDone: ["Task done"] });
      const planInput = { projectId, tasks: [{ ref: "task_1", title: "T", role: "integration", workflow: "standard", acceptanceCriteria: ["Task acceptance"], goal: "Task delivers the distinct persistence boundary", context: "Task-specific implementation context", requirements: ["Task requirement"] }] };
      mkdirSync(repoPath, { recursive: true });
      mkdirSync(taskWorktreePath, { recursive: true });
      mkdirSync(epicWorktreePath, { recursive: true });
      const now = new Date().toISOString();
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
      const projectYaml = "schema_version: 1\nproject:\n  name: sample\n  default_branch: master\n";
      const sourceFiles = { ".ebb-orchestrator/project.yaml": Buffer.from(projectYaml, "utf8").toString("base64") };
      const manifestJson = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: createHash("sha256").update(projectYaml, "utf8").digest("hex") }] });
      const hashDomain = (domain: string, value: string) => createHash("sha256").update(domain, "utf8").update(value, "utf8").digest("hex");
      const sortValue = (value: unknown): unknown => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, sortValue(entry)]))
        : value;
      const normalizedPayload = { project: parseProjectConfigYaml(projectYaml), files: sourceFiles };
      const configRepository = new ProjectConfigRepository(db);
      const configCandidate = configRepository.capture({
        projectId, sourceHead: "a".repeat(40), manifestJson,
        manifestHash: hashDomain("ebb-project-config-manifest-v1\0", manifestJson),
        sourceFilesJson: JSON.stringify(sourceFiles), normalizedPayloadJson: JSON.stringify(sortValue(normalizedPayload)), schemaVersion: 1,
      });
      const approvedConfig = new ProjectConfigService(db, new ApprovalService(db)).approve(projectId, configCandidate.candidate_id, configCandidate.manifest_hash);
      const planJson = JSON.stringify(planInput);
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { approvalId, projectId, now });
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-1','E','IN_PROGRESS',$contract,$now,$now)", { id: epicId, projectId, contract: epicContract, now });
      const planId = randomUUID();
      db.run("INSERT INTO planning_plans(id,project_id,plan_json,epic_id,status,approval_required,created_at) VALUES($id,$projectId,$plan,$epicId,'APPROVED',1,$now)", { id: planId, projectId, plan: planJson, epicId, now });
      db.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES($epicId,$planId,$input,'INTEGRATION','[]',$now,$now)", { epicId, planId, input: planJson, now });
      db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,$epicId,'TASK-1','T','INTEGRATION',$contract,$now,$now)", { id: taskId, projectId, epicId, contract: taskContract, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repo,'{}',$proposed,'ACTIVE',$approvalId,$now,$now)", { projectId, repo: repoPath, proposed: JSON.stringify({ defaultBranch: "master" }), approvalId, now });
      db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$repo,$path,$branch,$now)", { id: taskId, repo: repoPath, path: taskWorktreePath, branch: `task/${taskId}`, now });
      db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$repo,$branch,$worktreeId,'master',$now,$now)", { id: randomUUID(), repo: repoPath, branch: `task/${taskId}`, worktreeId: taskId, now });
      const epicWorktreeId = `epic:${epicId}`;
      db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$repo,$path,'epic/EPIC-1',$now)", { id: epicWorktreeId, repo: repoPath, path: epicWorktreePath, now });
      db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$repo,'epic/EPIC-1',$worktreeId,'master',$now,$now)", { id: randomUUID(), repo: repoPath, worktreeId: epicWorktreeId, now });
      db.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,10,0,0)", { projectId });

      const attempts: IntegrationAttempt[] = [];
      const calls: string[] = [];
      let factoryIntegrationRunId: string | undefined;
      const integrationService = {
        prepareIntegration: async (source: string, target: string, repo: string) => {
          calls.push(`prepare:${source}:${target}:${repo}`);
          const worktreePath = join(root, `integration-worktree-${attempts.length}`);
          mkdirSync(worktreePath, { recursive: true });
          if (!factoryIntegrationRunId) throw new Error("integration Run ID was not passed to the factory");
          const attempt: IntegrationAttempt = { id: `integration-attempt-${attempts.length}`, sourceBranch: source, currentTargetBranch: target, expectedTargetBranch: target, expectedTargetSha: "b".repeat(40), sourceSha: "c".repeat(40), worktreePath, repoPath: repo, provenanceDatabasePath: join(repoPath, ".ebb-orchestrator", "integration-provenance.sqlite"), status: "PREPARED", createdAt: now, integrationRunId: factoryIntegrationRunId };
          db.run("INSERT INTO integration_attempts(id,repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,integration_run_id,status,created_at) VALUES($id,$repo,$source,$target,$expected,$sourceSha,$path,$run,'PREPARED',$now)", { id: attempt.id, repo: attempt.repoPath, source: attempt.sourceBranch, target: attempt.currentTargetBranch, expected: attempt.expectedTargetSha, sourceSha: attempt.sourceSha, path: attempt.worktreePath, run: factoryIntegrationRunId, now: attempt.createdAt });
          attempts.push(attempt);
          return attempt;
        },
        bindIntegrationRun: (prepared: IntegrationAttempt, runId: string) => {
          calls.push(`bind:${runId}`);
          if (prepared.integrationRunId !== runId) throw new Error("integration Run ID does not match prepared provenance");
          return prepared;
        },
        mergePreparedSource: async () => { calls.push("merge"); },
        runInIntegrationWorktree: async (prepared: IntegrationAttempt, runner: (path: string, value: Readonly<IntegrationAttempt>) => Promise<unknown>) => {
          calls.push("execute");
          db.run("UPDATE integration_attempts SET status='MERGING' WHERE id=$id", { id: prepared.id });
          const result = await runner(prepared.worktreePath, prepared);
          db.run("UPDATE integration_attempts SET status='MERGED' WHERE id=$id", { id: prepared.id });
          return result;
        },
      } as unknown as IntegrationService;
      const factoryContexts: IntegrationServiceFactoryContext[] = [];
      const factory: IntegrationServiceFactory = (context) => { factoryContexts.push(context); factoryIntegrationRunId = context.integrationRunId; return integrationService; };
      const registry = new WorkflowRegistry();
      for (const template of Object.values(templates)) registry.register(template);
      const runtime = new IntegrationRuntime(db);
      const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), new RunService(db, runtime), {} as never, new SchedulerService(db), { integrationServiceFactory: factory, integrationWorktreeRoot: join(root, "integration-root") });
      const internal = orchestrator as unknown as { resolvePersistedIntegrationGit: (epic: string, task: string | undefined) => { repoPath: string; sourceBranch: string; targetBranch: string } };
      expect(() => internal.resolvePersistedIntegrationGit(epicId, taskId)).toThrow(/parent Epic branch/i);
      db.run("UPDATE git_operations SET target_ref='epic/EPIC-1' WHERE branch_name=$branch", { branch: `task/${taskId}` });
      const result = await (orchestrator as unknown as { runPhase: (epic: string, task: string, phase: string, role: string, request: unknown) => Promise<{ accepted: boolean }> }).runPhase(epicId, taskId, "integration", "integration", { phase: "integration", role: "integration", taskId, epicId, targetBranch: "attacker-controlled" });
      const finalIntegration = await (orchestrator as unknown as { runPhase: (epic: string, task: undefined, phase: string, role: string, request: unknown) => Promise<{ accepted: boolean }> }).runPhase(epicId, undefined, "integration", "integration", { phase: "integration", role: "integration", epicId, targetBranch: "attacker-controlled" });

      expect(result.accepted).toBe(true);
      expect(finalIntegration.accepted).toBe(true);
      expect(factoryContexts[0]).toMatchObject({ repoPath: join(root, "journal-repo"), worktreeRoot: join(root, "integration-root"), integrationRunId: expect.any(String), taskId, epicId });
      expect(factoryContexts[1]).toMatchObject({ repoPath: join(root, "journal-repo"), worktreeRoot: join(root, "integration-root"), integrationRunId: expect.any(String), epicId });
      expect(factoryContexts[1]?.integrationRunId).not.toBe(factoryContexts[0]?.integrationRunId);
      for (const [index, attempt] of attempts.entries()) {
        expect(runtime.prompts[index]).toContain(`Expected target SHA: ${attempt.expectedTargetSha}`);
        expect(runtime.prompts[index]).toContain(`Expected source SHA: ${attempt.sourceSha}`);
        expect(runtime.prompts[index]).toContain(`Integration attempt ID: ${attempt.id}`);
        expect(runtime.prompts[index]).not.toContain("attacker-controlled");
      }
      for (const [index, runId] of runtime.runIds.entries()) {
        const persisted = db.get<{ prompt: string }>("SELECT prompt FROM agent_runs WHERE id=$runId", { runId });
        const manifest = db.get<{ prompt_hash: string; subject_type: string; role: string }>("SELECT prompt_hash,subject_type,role FROM context_manifests WHERE run_id=$runId", { runId });
        const owner = db.get<{ source_tag: string; state: string; stop_evidence: string | null }>("SELECT source_tag,state,stop_evidence FROM run_process_owners WHERE run_id=$runId", { runId });
        expect(persisted?.prompt).toBe(runtime.prompts[index]);
        expect(manifest).toMatchObject({ prompt_hash: digestRunPromptBytesV1(new TextEncoder().encode(runtime.prompts[index] ?? "")), subject_type: index === 0 ? "TASK" : "EPIC", role: "integration" });
        expect(owner).toMatchObject({ source_tag: `ebb-run:${runId}`, state: "STOPPED", stop_evidence: "NEVER_LAUNCHED" });
      }
      expect(approvedConfig.revisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(runtime.prompts[0]).toContain("Goal: Task delivers the distinct persistence boundary");
      expect(runtime.prompts[0]).toContain("Context: Task-specific implementation context");
      expect(runtime.prompts[1]).toContain("Goal: Epic outcome remains authoritative");
      expect(runtime.prompts[1]).toContain("Task TASK-1 (T) goal: Task delivers the distinct persistence boundary");
      expect(runtime.prompts[1]).toContain("Task context: Task-specific implementation context");
      expect(calls.slice(0, 3)).toEqual([`prepare:task/${taskId}:epic/EPIC-1:${repoPath}`, expect.stringMatching(/^bind:/), "merge"]);
      expect(calls).toContain(`prepare:epic/EPIC-1:master:${repoPath}`);
      expect(calls.filter((call) => call === "execute")).toHaveLength(2);
      const finalRun = db.get<{ agent_run_id: string }>("SELECT agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS NULL AND phase='integration'", { epicId });
      if (!finalRun) throw new Error("Epic-level Integration phase was not persisted");
      expect(db.get<{ source_branch: string; target_branch: string; status: string }>("SELECT source_branch,target_branch,status FROM integration_attempts WHERE integration_run_id=$runId", { runId: finalRun.agent_run_id })).toMatchObject({ source_branch: "epic/EPIC-1", target_branch: "master", status: "MERGED" });
      const exactAttempt = db.get<{ id: string; expected_target_sha: string; source_sha: string; integration_run_id: string }>("SELECT id,expected_target_sha,source_sha,integration_run_id FROM integration_attempts WHERE integration_run_id=$runId AND status='MERGED'", { runId: finalRun.agent_run_id });
      const validatedResult = db.get<{ output: string }>("SELECT output FROM agent_runs WHERE id=$runId", { runId: finalRun.agent_run_id });
      const phaseEvidence = db.get<{ evidence_json: string }>("SELECT evidence_json FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS NULL AND phase='integration'", { epicId });
      if (!exactAttempt || !validatedResult || !phaseEvidence) throw new Error("Validated Epic Integration provenance was not fully persisted");
      const structuredResult = JSON.parse(validatedResult.output) as { baseSha: string; sourceSha: string; provenance: string[] };
      const persistedEvidence = JSON.parse(phaseEvidence.evidence_json) as { integrationAttemptId?: string };
      expect(exactAttempt.integration_run_id).toBe(finalRun.agent_run_id);
      expect(structuredResult).toMatchObject({ baseSha: exactAttempt.expected_target_sha, sourceSha: exactAttempt.source_sha, provenance: [`integration_attempt:${exactAttempt.id}`] });
      expect(persistedEvidence.integrationAttemptId).toBe(exactAttempt.id);
      expect(db.get<{ workspace: string }>("SELECT json_extract(capability_json,'$.workspace') AS workspace FROM agent_runs WHERE id=$runId", { runId: finalRun.agent_run_id })?.workspace).toBe(attempts[1]?.worktreePath);
      const finalPhase = db.get<{ id: string }>("SELECT id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS NULL AND phase='integration'", { epicId });
      if (!finalPhase) throw new Error("Epic-level Integration phase was not persisted");
      const persistedPhase = orchestrator as unknown as { persistedPhase: (epic: string, task: undefined, phase: string, role: string, result: { accepted: boolean; output: unknown }, runId: string, phaseId: string) => unknown };
      for (const invalid of [
        { baseSha: "d".repeat(40), sourceSha: "c".repeat(40), provenance: [`integration_attempt:${attempts[1]?.id}`] },
        { baseSha: "b".repeat(40), sourceSha: "e".repeat(40), provenance: [`integration_attempt:${attempts[1]?.id}`] },
        { baseSha: "b".repeat(40), sourceSha: "c".repeat(40), provenance: ["integration_attempt:other-attempt"] },
      ]) {
        expect(() => persistedPhase.persistedPhase(epicId, undefined, "integration", "integration", {
          accepted: true,
          output: { version: "1.0", outcome: "PASS", ...invalid, evidence: ["verification evidence"] },
        }, finalRun.agent_run_id, finalPhase.id)).toThrow(/exact verified persisted attempt and SHAs/);
      }
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")?.count).toBe(0);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the validated Epic-level Integration run for final approval, never a child Integration run", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-final-integration-provenance-"));
    const db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    try {
      runMigrations(db, migrations());
      const projectId = randomUUID();
      const epicId = randomUUID();
      const planId = randomUUID();
      const childRunId = randomUUID();
      const epicRunId = randomUUID();
      const approvalId = randomUUID();
      const onboardingApprovalId = randomUUID();
      const repoPath = join(root, "repo");
      const now = new Date().toISOString();
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-FINAL','E','IN_PROGRESS','{}',$now,$now)", { id: epicId, projectId, now });
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,created_at,resolved_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','tester','tester',$now,$now)", { id: onboardingApprovalId, projectId, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repo,'{}',$proposed,'ACTIVE',$approvalId,$now,$now)", { projectId, repo: repoPath, proposed: JSON.stringify({ defaultBranch: "master" }), approvalId: onboardingApprovalId, now });
      const epicWorkspaceId = `epic:${epicId}`;
      const epicWorkspacePath = join(root, "epic-worktree");
      db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$repo,$path,'epic/EPIC-FINAL',$now)", { id: epicWorkspaceId, repo: repoPath, path: epicWorkspacePath, now });
      db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES('epic-worktree-op','CREATE_WORKTREE','VERIFIED',$repo,'epic/EPIC-FINAL',$worktreeId,'master',$now,$now)", { repo: repoPath, worktreeId: epicWorkspaceId, now });
      db.run("INSERT INTO planning_plans(id,project_id,plan_json,epic_id,status,approval_required,created_at) VALUES($id,$projectId,'{}',$epicId,'APPROVED',1,$now)", { id: planId, projectId, epicId, now });
      db.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,final_approval_id,created_at,updated_at) VALUES($epicId,$planId,'{}','FINAL_APPROVAL','[]',$approvalId,$now,$now)", { epicId, planId, approvalId, now });
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,created_at,resolved_at) VALUES($approvalId,'FINAL_MERGE',$epicId,'EPIC','APPROVED','tester','tester',$now,$now)", { approvalId, epicId, now });
      for (const [runId, taskId, sourceBranch] of [
        [childRunId, "task-child", "task/task-child"],
        [epicRunId, null, "epic/EPIC-FINAL"],
      ] as const) {
        db.run("INSERT INTO agent_runs(id,role,runtime,model,task_id,epic_id,status,trigger_reason) VALUES($runId,'integration','persisted','persisted',$taskId,$epicId,'COMPLETED','epic-integration')", { runId, taskId, epicId });
        db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,validated,status,created_at) VALUES($id,$epicId,$taskId,'integration','integration',$runId,1,'COMPLETED',$now)", { id: randomUUID(), epicId, taskId, runId, now });
        db.run("INSERT INTO integration_attempts(id,repository_path,source_branch,target_branch,expected_target_sha,worktree_path,integration_run_id,source_sha,status,created_at) VALUES($id,$repo,$source,'master','expected',$path,$runId,'source','MERGED',$now)", { id: randomUUID(), repo: join(root, "repo"), source: sourceBranch, path: join(root, `integration-${runId}`), runId, now });
      }
      db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,target_ref,created_at,verified_at,approval_id,source_sha,expected_target_sha,resulting_target_sha) VALUES('merge-op','MERGE','VERIFIED',$repo,'epic/EPIC-FINAL','master',$now,$now,$approvalId,'source','expected','result')", { repo: join(root, "repo"), now, approvalId });
      let selectedRunId: string | undefined;
      const mergeAuthority = {
        async mergeApprovedForIntegration(_epicId: string, _approvalId: string, runId: string) {
          selectedRunId = runId;
          return { success: true, verifiedCompletion: true, resultingTargetSha: "result", targetBranch: "master" };
        },
      };
      const registry = new WorkflowRegistry();
      for (const template of Object.values(templates)) registry.register(template);
      const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), new RunService(db, {} as AgentRuntime), mergeAuthority as never, new SchedulerService(db));

      await orchestrator.approveFinalMergeAsync(epicId, approvalId);

      expect(selectedRunId).toBe(epicRunId);
      expect(db.get<{ status: string }>("SELECT status FROM epics WHERE id=$id", { id: epicId })?.status).toBe("DONE");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
