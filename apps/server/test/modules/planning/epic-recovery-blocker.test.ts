import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { EpicOrchestrator } from "../../../src/modules/planning/epic-orchestrator.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../../src/modules/workflow/templates.js";
import { EpicProjection } from "../../../src/app/read-models/epic-projection.js";

const unusedRuntime = {
  async startRun() { throw new Error("Unexpected runtime dispatch"); },
  async collectResult() { throw new Error("Unexpected runtime dispatch"); },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("Unexpected runtime dispatch"); },
  async runResult() { throw new Error("Unexpected runtime dispatch"); },
  async healthCheck() { return true; },
} as unknown as AgentRuntime;

describe("Epic recovery failure state", () => {
  it("persists a safe blocker on execution failure and clears it after startup resume succeeds", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    try {
      const now = new Date().toISOString();
      const projectId = randomUUID();
      const approvalId = randomUUID();
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'recovery','Recovery','ACTIVE',$now,$now)", { id: projectId, now });
      db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,created_at,resolved_at) VALUES($approvalId,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','tester','tester',$now,$now)", { approvalId, projectId, now });
      db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/recovery-repo','{}','{}','ACTIVE',$approvalId,$now,$now)", { projectId, approvalId, now });

      const planning = new PlanningService(db);
      const request = planning.createRequest(projectId, "Build the Recovery Epic", "tester");
      const plan = planning.preparePlan({
        projectId,
        requestedBy: "tester",
        epic: { title: "Recovery Epic" },
        tasks: [{ ref: "task_recovery", title: "Recovery task", acceptanceCriteria: ["works"], role: "developer", workflow: "standard" }],
      });
      db.run("UPDATE planning_requests SET classification='EPIC',plan_id=$planId,status='PLAN_PENDING_APPROVAL' WHERE id=$requestId", { planId: plan.id, requestId: request.id });

      let failProvisioning = true;
      const makeOrchestrator = (scheduler: SchedulerService = new SchedulerService(db)) => {
        const registry = new WorkflowRegistry();
        for (const template of Object.values(templates)) registry.register(template);
        return new EpicOrchestrator(
          db,
          new WorkflowEngine(db, registry),
          planning,
          new RunService(db, unusedRuntime),
          {} as never,
          scheduler,
          {
            epicWorkspaceProvisioner: { provisionForEpic: async () => ({ path: "/fake/epic-worktree" }) },
            taskWorkspaceProvisioner: { provisionForEpic: async () => {
              if (failProvisioning) {
                failProvisioning = false;
                throw new Error("PRIVATE_RUNTIME_FAILURE_SENTINEL");
              }
            } },
          },
        );
      };
      const orchestrator = makeOrchestrator();
      await expect(orchestrator.approveAndRun(plan.id, "tester", request.id)).rejects.toThrow("PRIVATE_RUNTIME_FAILURE_SENTINEL");

      const linkedRequest = db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: request.id });
      expect(linkedRequest).toEqual({ status: "FAILED", failure_code: "EPIC_RECOVERY_FAILED" });
      const epicId = db.get<{ epic_id: string }>("SELECT epic_id FROM planning_plans WHERE id=$id", { id: plan.id })?.epic_id;
      if (!epicId) throw new Error("Epic was not materialized");
      const blockedProjection = new EpicProjection(db).get(epicId)!;
      expect(blockedProjection.lifecycle).toMatchObject({ status: "BLOCKED", recoveryFailureCode: "EPIC_RECOVERY_FAILED" });
      expect(JSON.stringify(blockedProjection)).not.toContain("PRIVATE_RUNTIME_FAILURE_SENTINEL");

      db.run("UPDATE epic_orchestrations SET stage='FINAL_APPROVAL',final_approval_id='persisted-approval' WHERE epic_id=$id", { id: epicId });
      const completedRunId = randomUUID();
      db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES($id,'coordinator','persisted','persisted','COMPLETED')", { id: completedRunId });
      db.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,result_json,evidence_json,validated,status,created_at) VALUES($id,$epicId,NULL,'plan','coordinator',$runId,'{}','{}',1,'COMPLETED',$now)", {
        id: randomUUID(), epicId, runId: completedRunId, now,
      });

      const rejectingScheduler = {
        reconcile() {},
        assertProjectDispatchable() { throw new Error("PRIVATE_SCHEDULER_FAILURE_SENTINEL"); },
      } as unknown as SchedulerService;
      await expect(makeOrchestrator(rejectingScheduler).resumeApprovedEpics()).rejects.toThrow("PRIVATE_SCHEDULER_FAILURE_SENTINEL");
      expect(db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: request.id }))
        .toEqual({ status: "FAILED", failure_code: "EPIC_RECOVERY_FAILED" });
      expect(new EpicProjection(db).get(epicId)?.lifecycle).toMatchObject({ status: "BLOCKED", recoveryFailureCode: "EPIC_RECOVERY_FAILED" });

      await makeOrchestrator().resumeApprovedEpics();

      expect(db.get<{ status: string; failure_code: string | null }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: request.id }))
        .toEqual({ status: "MATERIALIZED", failure_code: null });
      expect(new EpicProjection(db).get(epicId)?.lifecycle).toMatchObject({ status: "IN_PROGRESS", recoveryFailureCode: null });
    } finally {
      db.close();
    }
  });
});
