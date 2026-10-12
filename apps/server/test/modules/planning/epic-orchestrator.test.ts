import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../../src/modules/workflow/templates.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { EpicOrchestrator, type EpicAgentRequest } from "../../../src/modules/planning/epic-orchestrator.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";

function migrations(): Migration[] {
  const directory = join(import.meta.dirname, "../../../src/platform/database/migrations");
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name, index) => ({ version: index + 1, name: name.slice(0, -4), sql: readFileSync(join(directory, name), "utf8") }));
}
const neverRuntime = {
  async startRun() { throw new Error("draft guard should prevent runtime start"); }, async collectResult() { throw new Error("unexpected"); },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; }, async resumeRun() {}, async cancelRun() {},
  async inspectRun() { throw new Error("unexpected"); }, async runResult() { throw new Error("unexpected"); }, async healthCheck() { return true; },
} as unknown as AgentRuntime;
type PrivateCalls = {
  execute(epicId: string, input: { tasks: Array<{ ref: string }> }): Promise<unknown>;
  runChild(task: { id: string; display_id: string; status: string }, epicId: string, branch: string): Promise<void>;
  runPhase(epicId: string, taskId: string | undefined, phase: string, role: string, request: EpicAgentRequest, prompt?: string): Promise<unknown>;
  approvedEpicCoordinatorPrompt(input: { epic?: { title: string }; tasks: Array<{ ref: string; title: string; role: string; workflow: string; acceptanceCriteria: string[]; dependsOn?: string[] }> }): string;
  persistedPhase(epicId: string, taskId: string | undefined, phase: string, role: string, result: { accepted: boolean; output: unknown }, agentRunId: string, phaseId: string): Promise<unknown>;
};
async function draftFixture() {
  const root = await mkdtemp(join(tmpdir(), "epic-draft-guard-"));
  const db = createSqliteDatabase(join(root, "test.sqlite")); runMigrations(db, migrations());
  const projectId = randomUUID(); const epicId = randomUUID(); const taskId = randomUUID(); const planId = randomUUID(); const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'draft','Draft','ACTIVE',$now,$now)", { id: projectId, now });
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,created_at,updated_at) VALUES($id,'/draft-repo','{}','{}','PROPOSED',$now,$now)", { id: projectId, now });
  db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'EPIC-DRAFT','Draft epic','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
  db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,$epicId,'TASK-DRAFT','Draft task','DRAFT','{}',1,$now,$now)", { id: taskId, projectId, epicId, now });
  db.run("INSERT INTO planning_plans(id,project_id,plan_json,epic_id,status,approval_required,created_at) VALUES($id,$projectId,$plan,$epicId,'PENDING',1,$now)", { id: planId, projectId, plan: JSON.stringify({ projectId, tasks: [] }), epicId, now });
  const scheduler = new SchedulerService(db); const registry = new WorkflowRegistry();
  for (const template of Object.values(templates)) registry.register(template);
  const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), new RunService(db, neverRuntime), {} as never, scheduler);
  return { root, db, epicId, taskId, planId, orchestrator, calls: orchestrator as unknown as PrivateCalls };
}
function expectNoDispatchRows(db: Database) {
  expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
  expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM orchestration_phase_runs")?.count).toBe(0);
  expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations")?.count).toBe(0);
}
describe("EpicOrchestrator draft onboarding guard", () => {
  async function coordinatorPhaseFixture() {
    const f = await draftFixture();
    const plan = {
      projectId: f.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$id", { id: f.epicId })!.project_id,
      requestedBy: "tester",
      epic: { title: "Approved Epic" },
      tasks: [
        { ref: "task_first", title: "First", role: "developer", workflow: "standard", acceptanceCriteria: ["done"] },
        { ref: "task_second", title: "Second", role: "developer", workflow: "standard", acceptanceCriteria: ["done"] },
      ],
    };
    const now = new Date().toISOString();
    f.db.run("UPDATE planning_plans SET plan_json=$plan,status='APPROVED' WHERE id=$id", { id: f.planId, plan: JSON.stringify(plan) });
    f.db.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES($epicId,$planId,$input,'CHILDREN','[]',$now,$now)", { epicId: f.epicId, planId: f.planId, input: JSON.stringify(plan), now });
    const runId = randomUUID(); const phaseId = randomUUID();
    f.db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,status,validated,created_at) VALUES($id,$epicId,NULL,'plan','coordinator',$runId,'RUNNING',0,$now)", { id: phaseId, epicId: f.epicId, runId, now });
    return { ...f, plan, runId, phaseId };
  }

  it.each([
    { label: "missing plan", output: { version: "1", operation: "PLAN", classification: "EPIC" } },
    { label: "mismatched plan", output: { version: "1", operation: "PLAN", classification: "EPIC", plan: { epic: { title: "Changed Epic" }, tasks: [{ ref: "task_first", title: "Changed task", role: "developer", workflow: "standard", acceptanceCriteria: ["done"] }] } } },
    { label: "missing Epic classification", output: { version: "1", operation: "PLAN", plan: { epic: { title: "Approved Epic" }, tasks: [{ ref: "task_first", title: "First", role: "developer", workflow: "standard", acceptanceCriteria: ["done"] }] } } },
  ])("rejects Coordinator confirmation with $label", async ({ output }) => {
    const f = await coordinatorPhaseFixture();
    try {
      await expect(f.calls.persistedPhase(f.epicId, undefined, "plan", "coordinator", { accepted: true, output }, f.runId, f.phaseId))
        .rejects.toThrow("EPIC_COORDINATOR_PLAN_MISMATCH");
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("accepts Coordinator confirmation that exactly matches the durable approved plan", async () => {
    const f = await coordinatorPhaseFixture();
    try {
      const actual = await f.calls.persistedPhase(f.epicId, undefined, "plan", "coordinator", {
        accepted: true,
        output: { version: "1", operation: "PLAN", classification: "EPIC", plan: { epic: f.plan.epic, tasks: f.plan.tasks } },
      }, f.runId, f.phaseId);
      expect(actual).toMatchObject({ accepted: true });
      expect(f.db.get<{ validated: number; status: string }>("SELECT validated,status FROM orchestration_phase_runs WHERE id=$id", { id: f.phaseId }))
        .toEqual({ validated: 1, status: "COMPLETED" });
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("rejects a Coordinator confirmation whose version is not the required v1 contract", async () => {
    const f = await coordinatorPhaseFixture();
    try {
      await expect(f.calls.persistedPhase(f.epicId, undefined, "plan", "coordinator", {
        accepted: true,
        output: { version: "0.9", operation: "PLAN", classification: "EPIC", plan: { epic: f.plan.epic, tasks: f.plan.tasks } },
      }, f.runId, f.phaseId)).rejects.toThrow("EPIC_COORDINATOR_PLAN_MISMATCH");
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("passes the approved-plan confirmation prompt from execute into the Coordinator runtime phase", async () => {
    const f = await coordinatorPhaseFixture();
    try {
      const approvalId = randomUUID();
      const now = new Date().toISOString();
      f.db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,created_at,resolved_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','tester','tester',$now,$now)", { id: approvalId, projectId: f.plan.projectId, now });
      f.db.run("UPDATE onboarding_configs SET status='ACTIVE',approval_id=$approvalId WHERE project_id=$projectId", { approvalId, projectId: f.plan.projectId });
      const dispatch = vi.spyOn(f.calls, "runPhase").mockRejectedValue(new Error("captured Coordinator dispatch"));
      await expect(f.calls.execute(f.epicId, f.plan)).rejects.toThrow("captured Coordinator dispatch");
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[5]).toContain("existing persisted approved plan");
      expect(dispatch.mock.calls[0]?.[5]).toContain(JSON.stringify({ epic: f.plan.epic, tasks: f.plan.tasks }));
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("asks the Epic Coordinator to confirm the persisted approved plan with CoordinatorOutput", async () => {
    const f = await draftFixture();
    const approvedPlan = {
      epic: { title: "Approved Epic" },
      tasks: [{ ref: "task_first", title: "First", role: "developer", workflow: "standard", acceptanceCriteria: ["done"], dependsOn: [] }],
    };
    try {
      const prompt = f.calls.approvedEpicCoordinatorPrompt(approvedPlan);
      expect(prompt).toContain("existing persisted approved plan");
      expect(prompt).toContain("Do not replan, create IDs, materialize tasks, or change orchestration state");
      expect(prompt).toContain('"version":"1"');
      expect(prompt).toContain('"operation":"PLAN"');
      expect(prompt).toContain('"classification":"EPIC"');
      expect(prompt).toContain(JSON.stringify({ epic: approvedPlan.epic, tasks: approvedPlan.tasks }));
      expect(prompt).toContain("submit_result");
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("serializes concurrent approval-run requests with a durable execution claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "epic-execution-claim-"));
    const db = createSqliteDatabase(join(root, "test.sqlite"));
    runMigrations(db, migrations());
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'claim','Claim','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,created_at,resolved_at) VALUES('claim-approval','WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','tester','tester',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,$root,'{}','{}','ACTIVE','claim-approval',$now,$now)", { id: projectId, root, now });
    const planning = new PlanningService(db);
    const plan = planning.preparePlan({ projectId, requestedBy: "tester", epic: { title: "Claimed Epic" }, tasks: [
      { ref: "task_first", title: "First", acceptanceCriteria: ["complete"], role: "developer", workflow: "standard" },
      { ref: "task_second", title: "Second", acceptanceCriteria: ["complete"], role: "developer", workflow: "standard" },
    ] });
    const approvedPlan = planning.approvePlan(plan.id, "tester");
    const epicId = db.get<{ epic_id: string }>("SELECT epic_id FROM planning_plans WHERE id=$id", { id: plan.id })!.epic_id;
    const approvedInput = db.get<{ plan_json: string }>("SELECT plan_json FROM planning_plans WHERE id=$id", { id: plan.id })!.plan_json;
    db.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES($epicId,$planId,$input,'CHILDREN','[]',$now,$now)", {
      epicId, planId: plan.id, input: approvedInput, now,
    });
    const phaseRunId = randomUUID();
    const runId = randomUUID();
    db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,status,validated,created_at) VALUES($id,$epicId,NULL,'plan','coordinator',$runId,'RUNNING',0,$now)", {
      id: phaseRunId, epicId, runId, now,
    });
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const coordinator = new EpicOrchestrator(
      db, new WorkflowEngine(db, registry), planning, new RunService(db, neverRuntime), {} as never, new SchedulerService(db),
    ) as unknown as PrivateCalls;
    await coordinator.persistedPhase(epicId, undefined, "plan", "coordinator", {
      accepted: true,
      output: { version: "1", operation: "PLAN", classification: "EPIC", plan: { epic: approvedPlan.epic, tasks: approvedPlan.tasks } },
    }, runId, phaseRunId);
    let provisionEntered!: () => void;
    const enteredProvisioning = new Promise<void>((resolve) => { provisionEntered = resolve; });
    let allowProvisionFailure!: () => void;
    const holdProvisioning = new Promise<void>((resolve) => { allowProvisionFailure = resolve; });
    const orchestrator = new EpicOrchestrator(
      db, new WorkflowEngine(db, registry), planning, new RunService(db, neverRuntime), {} as never, new SchedulerService(db),
      {
        epicWorkspaceProvisioner: { provisionForEpic: async () => ({ path: "/fake/epic-worktree" }) },
        taskWorkspaceProvisioner: { provisionForEpic: async () => { provisionEntered(); await holdProvisioning; throw new Error("intentional test stop"); } },
      },
    );
    try {
      const first = orchestrator.approveAndRun(plan.id, "tester");
      await enteredProvisioning;
      expect(db.get<{ execution_token: string | null }>("SELECT execution_token FROM epic_orchestrations WHERE plan_id=$id", { id: plan.id })?.execution_token).toBeTruthy();
      await expect(orchestrator.approveAndRun(plan.id, "tester")).rejects.toThrow("EPIC_ORCHESTRATION_ALREADY_RUNNING");
      allowProvisionFailure();
      await expect(first).rejects.toThrow("intentional test stop");
      expect(db.get<{ execution_token: string | null }>("SELECT execution_token FROM epic_orchestrations WHERE plan_id=$id", { id: plan.id })?.execution_token).toBeNull();
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(1);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(2);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("selects only approved unfinished Epics for startup resume", async () => {
    const f = await draftFixture();
    try {
      const resume = vi.spyOn(f.orchestrator, "approveAndRun").mockResolvedValue({ epicId: f.epicId, sequence: [], childStatuses: [], finalApprovalRequired: true, pendingFinalApproval: true });
      await f.orchestrator.resumeApprovedEpics();
      expect(resume).not.toHaveBeenCalled();
      f.db.run("UPDATE planning_plans SET status='APPROVED' WHERE id=$id", { id: f.planId });
      await f.orchestrator.resumeApprovedEpics();
      expect(resume).toHaveBeenCalledExactlyOnceWith(f.planId, "recovery");
      f.db.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,final_approval_id,created_at,updated_at) VALUES($epicId,$planId,'{}','FINAL_APPROVAL','[]','approval-1',$now,$now)", { epicId: f.epicId, planId: f.planId, now: new Date().toISOString() });
      await f.orchestrator.resumeApprovedEpics();
      expect(resume).toHaveBeenCalledTimes(1);
      f.db.run("UPDATE epic_orchestrations SET final_approval_id=NULL WHERE epic_id=$id", { id: f.epicId });
      await f.orchestrator.resumeApprovedEpics();
      expect(resume).toHaveBeenCalledTimes(2);
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("returns persisted validated phase evidence before checking current onboarding", async () => {
    const f = await draftFixture();
    try {
      const runId = randomUUID(); const phaseRunId = randomUUID(); const result = { ok: true };
      f.db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,status,validated,result_json,created_at) VALUES($id,$epicId,NULL,'plan','coordinator',$runId,'COMPLETED',1,$result,$now)", { id: phaseRunId, epicId: f.epicId, runId, result: JSON.stringify(result), now: new Date().toISOString() });
      const actual = await f.calls.runPhase(f.epicId, undefined, "plan", "coordinator", { phase: "plan", role: "coordinator", epicId: f.epicId });
      expect(actual).toEqual(result);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations")?.count).toBe(0);
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects approveAndRun before approval, provisioning, or orchestration writes", async () => {
    const f = await draftFixture();
    try {
      await expect(f.orchestrator.approveAndRun(f.planId, "tester")).rejects.toThrow("ONBOARDING_NOT_ACTIVE");
      expect(f.db.get<{ status: string }>("SELECT status FROM planning_plans WHERE id=$id", { id: f.planId })?.status).toBe("PENDING");
      expect(f.db.get("SELECT epic_id FROM epic_orchestrations WHERE epic_id=$id", { id: f.epicId })).toBeUndefined(); expectNoDispatchRows(f.db);
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects execute before changing Epic state or creating dispatch rows", async () => {
    const f = await draftFixture();
    try {
      await expect(f.calls.execute(f.epicId, { tasks: [] })).rejects.toThrow("ONBOARDING_NOT_ACTIVE");
      expect(f.db.get<{ status: string }>("SELECT status FROM epics WHERE id=$id", { id: f.epicId })?.status).toBe("OPEN"); expectNoDispatchRows(f.db);
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it("rejects runChild before transitioning a DRAFT child", async () => {
    const f = await draftFixture();
    try {
      await expect(f.calls.runChild({ id: f.taskId, display_id: "TASK-DRAFT", status: "DRAFT" }, f.epicId, "epic/draft")).rejects.toThrow("ONBOARDING_NOT_ACTIVE");
      expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: f.taskId })?.status).toBe("DRAFT"); expectNoDispatchRows(f.db);
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });
  it.each([
    { label: "non-task phase", task: undefined, phase: "plan", role: "coordinator" },
    { label: "child task phase", task: "child", phase: "child_task", role: "developer" },
    { label: "child integration phase", task: "child", phase: "integration", role: "integration" },
  ])("rejects runPhase for $label before phase intent, run preparation, or integration", async ({ task, phase, role }) => {
    const f = await draftFixture();
    try {
      await expect(f.calls.runPhase(f.epicId, task ? f.taskId : undefined, phase, role, { phase, role, epicId: f.epicId, ...(task ? { taskId: f.taskId } : {}) })).rejects.toThrow("ONBOARDING_NOT_ACTIVE");
      expectNoDispatchRows(f.db);
    } finally { f.db.close(); await rm(f.root, { recursive: true, force: true }); }
  });
});
