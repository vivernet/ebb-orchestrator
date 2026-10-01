import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EpicProjection } from "../../../src/app/read-models/epic-projection.js";
import { EpicOrchestrator, type EpicAgentRequest } from "../../../src/modules/planning/epic-orchestrator.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../../src/modules/workflow/templates.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const neverRuntime = {
  async startRun() { throw new Error("Unexpected runtime dispatch"); },
  async collectResult() { throw new Error("Unexpected runtime dispatch"); },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("Unexpected runtime dispatch"); },
  async runResult() { throw new Error("Unexpected runtime dispatch"); },
  async healthCheck() { return true; },
} as unknown as AgentRuntime;

async function approvedEpic(taskCount = 1, seedCheckpoint = false) {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const approvalId = randomUUID();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'recovery-safety','Recovery safety','ACTIVE',$now,$now)", { id: projectId, now });
  db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,created_at,resolved_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','tester','tester',$now,$now)", { id: approvalId, projectId, now });
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/recovery-safety-repo','{}',$proposed,'ACTIVE',$approvalId,$now,$now)", {
    projectId, proposed: JSON.stringify({ defaultBranch: "main" }), approvalId, now,
  });

  const planning = new PlanningService(db);
  const request = planning.createRequest(projectId, "Create a recovery safety Epic", "tester");
  const input = {
    projectId,
    requestedBy: "tester",
    epic: { title: "Recovery safety Epic" },
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      ref: `task_recovery_${index + 1}`,
      title: `Recovery task ${index + 1}`,
      acceptanceCriteria: ["works"],
      role: "developer",
      workflow: "standard",
    })),
  };
  const plan = planning.preparePlan(input);
  db.run("UPDATE planning_requests SET classification='EPIC',plan_id=$planId,status='PLAN_PENDING_APPROVAL' WHERE id=$requestId", { planId: plan.id, requestId: request.id });
  planning.approvePlan(plan.id, "tester", request.id);
  const epicId = db.get<{ epic_id: string }>("SELECT epic_id FROM planning_plans WHERE id=$id", { id: plan.id })?.epic_id;
  if (!epicId) throw new Error("Approved plan did not materialize an Epic");

  const planRunId = randomUUID();
  db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES($id,'coordinator','test','test','COMPLETED')", { id: planRunId });
  db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,result_json,evidence_json,validated,status,created_at) VALUES($id,$epicId,NULL,'plan','coordinator',$runId,'{}','{}',1,'COMPLETED',$now)", {
    id: randomUUID(), epicId, runId: planRunId, now,
  });
  if (seedCheckpoint) {
    db.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES($epicId,$planId,$input,'CHILDREN','[\"plan\"]',$now,$now)", {
      epicId, planId: plan.id, input: JSON.stringify(input), now,
    });
  }

  const registry = new WorkflowRegistry();
  for (const template of Object.values(templates)) registry.register(template);
  const epicRow = db.get<{ display_id: string }>("SELECT display_id FROM epics WHERE id=$id", { id: epicId });
  if (!epicRow) throw new Error("Approved Epic was not persisted");
  const epicWorktreePath = `/fake/epic-${epicId}`;
  db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,'/recovery-safety-repo',$path,$branch,$now)", {
    id: `epic:${epicId}`, path: epicWorktreePath, branch: `epic/${epicRow.display_id}`, now,
  });
  db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED','/recovery-safety-repo',$branch,$worktreeId,'main',$now,$now)", {
    id: randomUUID(), branch: `epic/${epicRow.display_id}`, worktreeId: `epic:${epicId}`, now,
  });
  for (const task of db.all<{ id: string; display_id: string }>("SELECT id,display_id FROM tasks WHERE epic_id=$epicId", { epicId })) {
    const taskWorktreePath = `/fake/task-${task.id}`;
    db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,'/recovery-safety-repo',$path,$branch,$now)", {
      id: task.id, path: taskWorktreePath, branch: `task/${task.id}`, now,
    });
    db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED','/recovery-safety-repo',$branch,$taskId,$targetRef,$now,$now)", {
      id: randomUUID(), branch: `task/${task.id}`, taskId: task.id, targetRef: `epic/${epicRow.display_id}`, now,
    });
  }
  const scheduler = new SchedulerService(db);
  const workflow = new WorkflowEngine(db, registry);
  const persistedWorkspaceBranches = new Map(db.all<{ path: string; branch: string }>(
    "SELECT path,branch FROM worktrees WHERE repo_path='/recovery-safety-repo'",
  ).map((worktree) => [worktree.path, worktree.branch]));
  const git = {
    run: vi.fn(async (cwd: string, args: string[]) => {
      const branch = persistedWorkspaceBranches.get(cwd);
      if (!branch) throw new Error(`Unexpected recovery test Git cwd: ${cwd}`);
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { exitCode: 0, stdout: `${branch}\n`, stderr: "" };
      if (args[0] === "diff") return { exitCode: 0, stdout: "", stderr: "" };
      throw new Error(`Unexpected recovery test Git command: ${args.join(" ")}`);
    }),
  };
  const workspaceOptions = {
    epicWorkspaceProvisioner: { provisionForEpic: async () => ({ path: epicWorktreePath }) },
    taskWorkspaceProvisioner: { provisionForEpic: async () => undefined },
    git,
  };
  const orchestrator = new EpicOrchestrator(db, workflow, planning, new RunService(db, neverRuntime), {} as never, scheduler, workspaceOptions);
  const taskId = db.get<{ id: string }>("SELECT id FROM tasks WHERE epic_id=$epicId ORDER BY display_id LIMIT 1", { epicId })?.id;
  if (!taskId) throw new Error("Approved Epic plan did not materialize its child task");
  return { db, planning, request, plan, input, epicId, taskId, workflow, orchestrator, scheduler, workspaceOptions, git };
}

type PrivateCalls = {
  runPhase(epicId: string, taskId: string | undefined, phase: string, role: string, request: EpicAgentRequest): Promise<unknown>;
  runChild(task: { id: string; display_id: string; status: string }, epicId: string, branch: string): Promise<void>;
};

function fakeRunService(db: ReturnType<typeof createSqliteDatabase>, failFirst = true) {
  let attempts = 0;
  const roles = new Map<string, string>();
  return {
    prepareRun(options: { runId: string; role: string; taskId: string; epicId: string }) {
      roles.set(options.runId, options.role);
      db.run("INSERT INTO agent_runs(id,role,runtime,model,task_id,epic_id,status,started_at) VALUES($id,$role,'test','test',$taskId,$epicId,'STARTED',$now)", {
        id: options.runId, role: options.role, taskId: options.taskId || null, epicId: options.epicId, now: new Date().toISOString(),
      });
    },
    async executePreparedRun(runId: string) {
      attempts += 1;
      if (failFirst && attempts === 1) throw new Error("controlled phase failure");
      const role = roles.get(runId);
      const outcome = role === "developer" ? "COMPLETED" : role === "product_manager" ? "PRODUCT_DEFINITION" : role === "architect" ? "DESIGN" : "PASS";
      const output = JSON.stringify({ version: "1.0.0", outcome });
      db.run("UPDATE agent_runs SET status='COMPLETED',ended_at=$now,exit_code=0,output=$output WHERE id=$id", {
        id: runId, now: new Date().toISOString(), output,
      });
      return { run: { cost: 0.25 }, outcome: { success: true, exitCode: 0, output } };
    },
    failPreparedRun(runId: string) {
      const current = db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId });
      if (!current) return false;
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) return true;
      db.run("UPDATE agent_runs SET status='FAILED',ended_at=$now,exit_code=-1 WHERE id=$id AND status IN ('STARTED','IN_PROGRESS','COMPLETING')", { id: runId, now: new Date().toISOString() });
      return (db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId })?.status) === "FAILED";
    },
  } as unknown as RunService;
}

function setPhaseCheckpoint(f: Awaited<ReturnType<typeof approvedEpic>>, phase: "pm" | "architect", sequence: string[], state: "FAILED" | "COMPLETED", validated: 0 | 1) {
  const input = { ...f.input, ...(phase === "pm" ? { includeProductManager: true } : { includeArchitect: true }) };
  f.db.run("UPDATE planning_plans SET plan_json=$input WHERE id=$id", { id: f.plan.id, input: JSON.stringify(input) });
  f.db.run("UPDATE epic_orchestrations SET input_json=$input,stage='FINAL_APPROVAL',sequence_json=$sequence,final_approval_id='persisted-final-approval' WHERE epic_id=$id", {
    id: f.epicId, input: JSON.stringify(input), sequence: JSON.stringify(sequence),
  });
  const role = phase === "pm" ? "product_manager" : "architect";
  const result = phase === "pm"
    ? { accepted: true, output: { version: "1.0.0", outcome: "PRODUCT_DEFINITION" } }
    : { accepted: true, output: { version: "1.0.0", outcome: "DESIGN" }, architectureChangingProposalAccepted: false };
  const runId = randomUUID();
  f.db.run("INSERT INTO agent_runs(id,role,runtime,model,epic_id,status) VALUES($id,$role,'test','test',$epicId,$status)", {
    id: runId, role, epicId: f.epicId, status: state,
  });
  f.db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,result_json,evidence_json,validated,status,created_at) VALUES($id,$epicId,NULL,$phase,$role,$runId,$result,'{}',$validated,$status,$now)", {
    id: randomUUID(), epicId: f.epicId, phase, role, runId, result: JSON.stringify(result), validated, status: state, now: new Date().toISOString(),
  });
  return { input, runId };
}

describe("Epic orchestrator recovery safety", () => {
  it("keeps the execution claim and blocker clear until every sibling child settles, then preserves the first failure", async () => {
    const f = await approvedEpic(2);
    try {
      let firstEntered!: () => void;
      const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
      let siblingEntered!: () => void;
      const siblingStarted = new Promise<void>((resolve) => { siblingEntered = resolve; });
      let releaseSibling!: () => void;
      const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
      const calls = f.orchestrator as unknown as PrivateCalls;
      calls.runChild = async (task) => {
        if (task.display_id.endsWith("1")) {
          firstEntered();
          throw new Error("first meaningful child failure");
        }
        siblingEntered();
        await siblingGate;
      };

      const execution = f.orchestrator.approveAndRun(f.plan.id, "tester", f.request.id).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await Promise.all([firstStarted, siblingStarted]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.db.get<{ execution_token: string | null; recovery_failure_code: string | null }>("SELECT execution_token,recovery_failure_code FROM epic_orchestrations WHERE epic_id=$id", { id: f.epicId }))
        .toMatchObject({ execution_token: expect.any(String), recovery_failure_code: null });
      expect(f.db.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: f.request.id })?.status).toBe("MATERIALIZED");

      releaseSibling();
      expect((await execution).error).toMatchObject({ message: "first meaningful child failure" });
      expect(f.db.get<{ execution_token: string | null; recovery_failure_code: string | null }>("SELECT execution_token,recovery_failure_code FROM epic_orchestrations WHERE epic_id=$id", { id: f.epicId }))
        .toEqual({ execution_token: null, recovery_failure_code: "EPIC_RECOVERY_FAILED" });
      expect(f.db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: f.request.id }))
        .toEqual({ status: "FAILED", failure_code: "EPIC_RECOVERY_FAILED" });
    } finally {
      f.db.close();
    }
  });

  it("retries a terminal failed phase in the same orchestrator and reuses the unique phase row", async () => {
    const f = await approvedEpic();
    try {
      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, fakeRunService(f.db), {} as never, f.scheduler, f.workspaceOptions);
      const calls = orchestrator as unknown as PrivateCalls;
      f.workflow.transition(f.taskId, "READY");
      const request = { phase: "child_task", role: "developer", taskId: f.taskId, epicId: f.epicId };

      await expect(calls.runPhase(f.epicId, f.taskId, "child_task", "developer", request)).rejects.toThrow("controlled phase failure");
      expect(f.git.run).toHaveBeenCalledWith(`/fake/task-${f.taskId}`, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
      expect(f.git.run).toHaveBeenCalledWith(`/fake/task-${f.taskId}`, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const failed = f.db.get<{ id: string; agent_run_id: string; status: string; validated: number }>("SELECT id,agent_run_id,status,validated FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id=$taskId AND phase='child_task'", { epicId: f.epicId, taskId: f.taskId });
      expect(failed).toMatchObject({ status: "FAILED", validated: 0 });
      expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: failed!.agent_run_id })?.status).toBe("FAILED");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND run_id=$id", { id: failed!.agent_run_id })?.count).toBe(0);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND subject_id=$id", { id: f.taskId })?.count).toBe(0);

      const result = await calls.runPhase(f.epicId, f.taskId, "child_task", "developer", request) as { accepted: boolean };
      expect(result.accepted).toBe(true);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id=$taskId AND phase='child_task'", { epicId: f.epicId, taskId: f.taskId })?.count).toBe(1);
      expect(f.db.get<{ id: string; status: string; validated: number }>("SELECT id,status,validated FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id=$taskId AND phase='child_task'", { epicId: f.epicId, taskId: f.taskId }))
        .toEqual({ id: failed!.id, status: "COMPLETED", validated: 1 });
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$id AND role='developer'", { id: f.epicId })?.count).toBe(2);
      expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: failed!.agent_run_id })?.status).toBe("FAILED");
      const projectId = f.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$id", { id: f.epicId })?.project_id;
      if (!projectId) throw new Error("Epic project is missing");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND project_id=$id", { id: projectId })?.count).toBe(0);
    } finally {
      f.db.close();
    }
  });

  it.each([
    { phaseStatus: "INTENT", runStatus: "FAILED", reservationStatus: "RELEASED" },
    { phaseStatus: "RUNNING", runStatus: "FAILED", reservationStatus: "RELEASED" },
    { phaseStatus: "FAILED", runStatus: "STARTED", reservationStatus: "RELEASED" },
    { phaseStatus: "FAILED", runStatus: "FAILED", reservationStatus: "RESERVED" },
  ])("fails closed for phase=$phaseStatus, AgentRun=$runStatus, reservation=$reservationStatus", async ({ phaseStatus, runStatus, reservationStatus }) => {
    const f = await approvedEpic();
    try {
      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, fakeRunService(f.db), {} as never, f.scheduler, f.workspaceOptions);
      const calls = orchestrator as unknown as PrivateCalls;
      const request = { phase: "epic_review", role: "reviewer", epicId: f.epicId };
      await expect(calls.runPhase(f.epicId, undefined, "epic_review", "reviewer", request)).rejects.toThrow("controlled phase failure");
      const previous = f.db.get<{ id: string; agent_run_id: string }>("SELECT id,agent_run_id FROM orchestration_phase_runs WHERE epic_id=$id AND phase='epic_review'", { id: f.epicId })!;
      f.db.run("UPDATE orchestration_phase_runs SET status=$status,validated=0 WHERE id=$id", { id: previous.id, status: phaseStatus });
      f.db.run("UPDATE agent_runs SET status=$status WHERE id=$id", { id: previous.agent_run_id, status: runStatus });
      f.db.run("UPDATE scheduler_reservations SET status=$status WHERE run_id=$id", { id: previous.agent_run_id, status: reservationStatus });

      await expect(calls.runPhase(f.epicId, undefined, "epic_review", "reviewer", request)).rejects.toThrow();
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$id AND role='reviewer'", { id: f.epicId })?.count).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it("preserves an unvalidated failed phase, its reservation, and worktrees when RunService cannot prove stop", async () => {
    const f = await approvedEpic(1, true);
    try {
      const { runId } = setPhaseCheckpoint(f, "pm", ["plan", "pm"], "FAILED", 0);
      f.db.run("UPDATE agent_runs SET status='STARTED',ended_at=NULL,exit_code=NULL WHERE id=$id", { id: runId });
      const projectId = f.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$id", { id: f.epicId })!.project_id;
      f.db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES($id,'PHASE',$runId,$projectId,$owner,$now,1,'RESERVED','product_manager','test',$runId)", {
        id: randomUUID(), runId, projectId, owner: `run:${runId}`, now: new Date().toISOString(),
      });
      const runs = {
        ...fakeRunService(f.db, false),
        failPreparedRun: vi.fn(() => false),
      } as unknown as RunService;

      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, runs, {} as never, f.scheduler, f.workspaceOptions);
      orchestrator.reconcileInterruptedRuns();

      expect(runs.failPreparedRun).toHaveBeenCalledWith(runId, expect.any(Error));
      expect(f.db.get<{ status: string; validated: number }>("SELECT status,validated FROM orchestration_phase_runs WHERE agent_run_id=$id", { id: runId }))
        .toEqual({ status: "FAILED", validated: 0 });
      expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId })?.status).toBe("STARTED");
      expect(f.db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE run_id=$id", { id: runId })?.status).toBe("RESERVED");
      expect(f.db.get<{ path: string }>("SELECT path FROM worktrees WHERE id=$id", { id: `epic:${f.epicId}` })?.path).toBe(`/fake/epic-${f.epicId}`);
      expect(f.db.get<{ path: string }>("SELECT path FROM worktrees WHERE id=$id", { id: f.taskId })?.path).toBe(`/fake/task-${f.taskId}`);
    } finally {
      f.db.close();
    }
  });

  it("does not retry a failed child phase while a task-level reservation is still active", async () => {
    const f = await approvedEpic();
    try {
      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, fakeRunService(f.db), {} as never, f.scheduler, f.workspaceOptions);
      const calls = orchestrator as unknown as PrivateCalls;
      const request = { phase: "child_task", role: "developer", taskId: f.taskId, epicId: f.epicId };
      await expect(calls.runPhase(f.epicId, f.taskId, "child_task", "developer", request)).rejects.toThrow("controlled phase failure");
      const previous = f.db.get<{ id: string; agent_run_id: string }>("SELECT id,agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id=$taskId AND phase='child_task'", { epicId: f.epicId, taskId: f.taskId })!;
      const projectId = f.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$id", { id: f.epicId })!.project_id;
      f.db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES($id,'TASK',$taskId,$projectId,$owner,$now,0,'RESERVED','developer','test',$runId)", {
        id: randomUUID(), taskId: f.taskId, projectId, owner: `task:${f.taskId}`, now: new Date().toISOString(), runId: previous.agent_run_id,
      });

      await expect(calls.runPhase(f.epicId, f.taskId, "child_task", "developer", request)).rejects.toThrow("not safely retryable");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$id AND role='developer'", { id: f.epicId })?.count).toBe(1);
      expect(f.db.get<{ status: string }>("SELECT status FROM orchestration_phase_runs WHERE id=$id", { id: previous.id })?.status).toBe("FAILED");
    } finally {
      f.db.close();
    }
  });

  it("keeps an active Epic phase and its reservation when failure stop proof is unavailable", async () => {
    const f = await approvedEpic();
    try {
      const runs = {
        ...fakeRunService(f.db, false),
        executePreparedRun: vi.fn().mockRejectedValue(new Error("controlled phase failure")),
        failPreparedRun: vi.fn(() => false),
      } as unknown as RunService;
      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, runs, {} as never, f.scheduler, f.workspaceOptions);
      const calls = orchestrator as unknown as PrivateCalls;

      await expect(calls.runPhase(f.epicId, f.taskId, "child_task", "developer", {
        phase: "child_task", role: "developer", taskId: f.taskId, epicId: f.epicId,
      })).rejects.toThrow("EPIC_RUN_STOP_UNPROVEN");

      const phase = f.db.get<{ status: string; agent_run_id: string }>(
        "SELECT status,agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id=$taskId AND phase='child_task'",
        { epicId: f.epicId, taskId: f.taskId },
      );
      expect(phase?.status).toBe("RUNNING");
      expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: phase!.agent_run_id })?.status).toBe("STARTED");
      expect(f.db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE run_id=$id", { id: phase!.agent_run_id })?.status).toBe("RESERVED");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=(SELECT id FROM scheduler_reservations WHERE run_id=$id)", { id: phase!.agent_run_id })?.count).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it("does not mark the planning request failed when approveAndRun cannot prove runtime stop", async () => {
    const f = await approvedEpic(1, true);
    try {
      const runs = {
        ...fakeRunService(f.db, false),
        executePreparedRun: vi.fn().mockRejectedValue(new Error("runtime stop is unproven")),
        failPreparedRun: vi.fn(() => false),
      } as unknown as RunService;
      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, runs, {} as never, f.scheduler, f.workspaceOptions);

      await expect(orchestrator.approveAndRun(f.plan.id, "tester", f.request.id)).rejects.toThrow("EPIC_RUN_STOP_UNPROVEN");

      expect(f.db.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: f.request.id })?.status).toBe("MATERIALIZED");
      const phase = f.db.get<{ status: string; agent_run_id: string }>(
        "SELECT status,agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND phase='child_task'",
        { epicId: f.epicId },
      );
      expect(phase?.status).toBe("RUNNING");
      expect(f.db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE run_id=$id", { id: phase!.agent_run_id })?.status).toBe("RESERVED");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=(SELECT id FROM scheduler_reservations WHERE run_id=$id)", { id: phase!.agent_run_id })?.count).toBe(1);
      expect(f.db.get<{ execution_token: string | null }>("SELECT execution_token FROM epic_orchestrations WHERE epic_id=$id", { id: f.epicId })?.execution_token).toBeTruthy();

      await expect(orchestrator.approveAndRun(f.plan.id, "tester", f.request.id)).rejects.toThrow("EPIC_ORCHESTRATION_ALREADY_RUNNING");
      expect(f.db.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: f.request.id })?.status).toBe("MATERIALIZED");
      expect(f.db.get<{ status: string }>("SELECT status FROM orchestration_phase_runs WHERE agent_run_id=$id", { id: phase!.agent_run_id })?.status).toBe("RUNNING");
    } finally {
      f.db.close();
    }
  });

  it("does not reconcile terminal Run reservations in the Epic constructor before process-owner preflight", async () => {
    const f = await approvedEpic();
    try {
      const runId = randomUUID();
      const projectId = f.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$id", { id: f.epicId })!.project_id;
      const now = new Date().toISOString();
      f.db.run("INSERT INTO agent_runs(id,role,runtime,model,status,epic_id) VALUES($id,'reviewer','test','test','FAILED',$epicId)", { id: runId, epicId: f.epicId });
      f.db.run(
        `INSERT INTO run_process_owners(run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,updated_at)
         VALUES($id,$tag,$home,'systemd-user-service',$containment,$nonce,'LIVE',$now)`,
        { id: runId, tag: `ebb-run:${runId}`, home: `/fake/hermes-home-${runId}`, containment: "a".repeat(64), nonce: "b".repeat(64), now },
      );
      f.db.run(
        `INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,result_json,evidence_json,validated,status,created_at)
         VALUES($id,$epicId,NULL,'child_review','reviewer',$runId,'{}','{}',0,'RUNNING',$now)`,
        { id: randomUUID(), epicId: f.epicId, runId, now },
      );
      f.scheduler.dispatchAgentRun(runId, projectId, "reviewer", "test");
      const reservation = f.db.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE run_id=$id", { id: runId })!;
      const runs = new RunService(f.db, neverRuntime);
      const failPreparedRun = vi.spyOn(runs, "failPreparedRun");

      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, runs, {} as never, f.scheduler, f.workspaceOptions);

      expect(failPreparedRun).not.toHaveBeenCalled();
      expect(f.db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE id=$id", { id: reservation.id })?.status).toBe("RESERVED");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservation.id })?.count).toBe(1);

      f.db.run("UPDATE run_process_owners SET state='STOPPED',stop_evidence='SUPERVISOR_SCOPE_EMPTY',updated_at=$now WHERE run_id=$id", { id: runId, now: new Date().toISOString() });
      orchestrator.reconcileInterruptedRuns();
      expect(failPreparedRun).toHaveBeenCalledWith(runId, expect.any(Error));
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE agent_run_id=$id", { id: runId })?.count).toBe(0);
      expect(f.scheduler.reconcile().releasedReservationIds).toContain(reservation.id);
      expect(f.db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE id=$id", { id: reservation.id })?.status).toBe("RELEASED");
    } finally {
      f.db.close();
    }
  });

  it.each(["pm", "architect"] as const)("does not trust sequence entry %s when its phase failed and is unvalidated", async (phase) => {
    const f = await approvedEpic(1, true);
    try {
      const { runId } = setPhaseCheckpoint(f, phase, ["plan", phase], "FAILED", 0);
      const orchestrator = new EpicOrchestrator(f.db, f.workflow, f.planning, fakeRunService(f.db, false), {} as never, f.scheduler, f.workspaceOptions);

      const result = await orchestrator.approveAndRun(f.plan.id, "recovery", f.request.id);
      expect(result.sequence).toContain(phase);
      expect(f.db.get<{ status: string; validated: number }>("SELECT status,validated FROM orchestration_phase_runs WHERE epic_id=$epicId AND phase=$phase", { epicId: f.epicId, phase }))
        .toEqual({ status: "COMPLETED", validated: 1 });
      expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId })?.status).toBe("FAILED");
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$id AND role=$role", { id: f.epicId, role: phase === "pm" ? "product_manager" : "architect" })?.count).toBe(2);
    } finally {
      f.db.close();
    }
  });

  it.each(["pm", "architect"] as const)("does not accept sequence entry %s when the phase is FAILED despite validated=1", async (phase) => {
    const f = await approvedEpic(1, true);
    try {
      setPhaseCheckpoint(f, phase, ["plan", phase], "FAILED", 1);
      await expect(f.orchestrator.approveAndRun(f.plan.id, "recovery", f.request.id)).rejects.toThrow("not safely retryable");
      expect(f.db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: f.request.id }))
        .toEqual({ status: "FAILED", failure_code: "EPIC_RECOVERY_FAILED" });
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$id AND role=$role", { id: f.epicId, role: phase === "pm" ? "product_manager" : "architect" })?.count).toBe(1);
    } finally {
      f.db.close();
    }
  });

  it.each(["pm", "architect"] as const)("repairs a missing %s sequence append from its completed persisted phase", async (phase) => {
    const f = await approvedEpic(1, true);
    try {
      setPhaseCheckpoint(f, phase, ["plan"], "COMPLETED", 1);
      const before = f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$id", { id: f.epicId })?.count;

      const result = await f.orchestrator.approveAndRun(f.plan.id, "recovery", f.request.id);

      expect(result.sequence).toContain(phase);
      expect(f.db.get<{ sequence_json: string }>("SELECT sequence_json FROM epic_orchestrations WHERE epic_id=$id", { id: f.epicId })?.sequence_json).toContain(`"${phase}"`);
      expect(f.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$id", { id: f.epicId })?.count).toBe(before);
      expect(f.db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: f.request.id }))
        .toEqual({ status: "MATERIALIZED", failure_code: null });
    } finally {
      f.db.close();
    }
  });

  it.each(["invalid JSON", "invalid typed fields"] as const)("records a safe blocker for approved plans with %s even when no orchestration row exists", async (corruption) => {
    const f = await approvedEpic();
    try {
      const privateSentinel = "PRIVATE_APPROVED_PLAN_SENTINEL";
      const malformed = corruption === "invalid JSON"
        ? privateSentinel
        : JSON.stringify({ ...f.input, includeArchitect: privateSentinel });
      f.db.run("UPDATE planning_plans SET plan_json=$json WHERE id=$id", { id: f.plan.id, json: malformed });
      await expect(f.orchestrator.approveAndRun(f.plan.id, "recovery", f.request.id)).rejects.toThrow("EPIC_RECOVERY_CHECKPOINT_INVALID");

      const checkpoint = f.db.get<{ input_json: string; recovery_failure_code: string | null; execution_token: string | null }>("SELECT input_json,recovery_failure_code,execution_token FROM epic_orchestrations WHERE epic_id=$id", { id: f.epicId });
      expect(checkpoint).toMatchObject({ recovery_failure_code: "EPIC_RECOVERY_FAILED", execution_token: null });
      expect(checkpoint?.input_json).not.toContain(privateSentinel);
      expect(f.db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: f.request.id }))
        .toEqual({ status: "FAILED", failure_code: "EPIC_RECOVERY_FAILED" });
      expect(new EpicProjection(f.db).get(f.epicId)?.lifecycle).toMatchObject({ status: "BLOCKED", recoveryFailureCode: "EPIC_RECOVERY_FAILED" });
      expect(JSON.stringify(new EpicProjection(f.db).get(f.epicId))).not.toContain(privateSentinel);
    } finally {
      f.db.close();
    }
  });

  it.each(["input_json", "sequence_json"] as const)("records a safe blocker for malformed orchestration %s", async (column) => {
    const f = await approvedEpic(1, true);
    try {
      const privateSentinel = `PRIVATE_${column}_SENTINEL`;
      f.db.run(`UPDATE epic_orchestrations SET ${column}=$value WHERE epic_id=$id`, { value: privateSentinel, id: f.epicId });
      await expect(f.orchestrator.approveAndRun(f.plan.id, "recovery", f.request.id)).rejects.toThrow("EPIC_RECOVERY_CHECKPOINT_INVALID");

      expect(f.db.get<{ recovery_failure_code: string | null; execution_token: string | null }>("SELECT recovery_failure_code,execution_token FROM epic_orchestrations WHERE epic_id=$id", { id: f.epicId }))
        .toEqual({ recovery_failure_code: "EPIC_RECOVERY_FAILED", execution_token: null });
      expect(f.db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: f.request.id }))
        .toEqual({ status: "FAILED", failure_code: "EPIC_RECOVERY_FAILED" });
      expect(JSON.stringify(new EpicProjection(f.db).get(f.epicId))).not.toContain(privateSentinel);
    } finally {
      f.db.close();
    }
  });
});
