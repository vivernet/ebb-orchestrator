import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import { transitionRunProcessOwnerTx } from "../../../src/modules/runtime/run-process-owner.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { registerCoordinatorPlanningJob, COORDINATOR_PLANNING_JOB } from "../../../src/modules/planning/coordinator-planning-job.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { BackgroundJobRegistry } from "../../../src/platform/jobs/background-job-registry.js";
import { JobRunner } from "../../../src/platform/jobs/job-runner.js";
import { enqueueJob } from "../../../src/platform/jobs/job-repository.js";
import type { Database } from "../../../src/platform/database/database.js";
import type { RunOutcome } from "../../../src/modules/runtime/run-types.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { ProjectConfigService } from "../../../src/modules/projects/project-config-service.js";
import { ProjectConfigRepository } from "../../../src/modules/projects/project-config-repository.js";
import { parseProjectConfigYaml } from "../../../src/platform/config/project-config.js";
import { digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import { createHermesAuthRouteFixture } from "../../helpers/hermes-auth-route-fixture.js";

const hermesSourceSnapshotKey = JSON.stringify({
  formatVersion: 1,
  hermesVersion: "v0.21.5+7357.g9244275",
  manifestDigest: "c".repeat(64),
  sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
  sourceTree: "d".repeat(40),
});

describe("Coordinator planning background job", () => {
  let db: Database | undefined;
  let root = "";

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function setup(output = epicOutput(), useHermesSelection = false) {
    root = await mkdtemp(join(tmpdir(), "ebb-coordinator-job-"));
    db = createSqliteDatabase(join(root, "state.db"));
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'plan','Plan','ACTIVE',$now,$now)", { id: projectId, now });
    const approvals = new ApprovalService(db);
    const approval = approvals.request({ type: "WORKFLOW_CHANGE", subjectId: projectId, subjectType: "PROJECT", requestedBy: "local-user" });
    approvals.approve(approval.id, "local-user");
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,$root,'{}','null','ACTIVE',$approvalId,$now,$now)", { id: projectId, root, approvalId: approval.id, now });
    seedApprovedProjectConfig(db, projectId);

    const runRef: { current?: RunService } = {};
    const outputs = new Map<string, unknown>();
    const hermesPreflightCalls: string[] = [];
    const hermesCleanupCalls: string[] = [];
    const runtime: AgentRuntime = {
      active: 0,
      maxActive: 1,
      calls: [],
      ...(useHermesSelection ? {
        prepareHermesRunSelection: async (runId: string) => {
          hermesPreflightCalls.push(runId);
          const authFixture = await createHermesAuthRouteFixture(
            runId, "openai-codex", "selected-hermes-model", join(root, "hermes-auth-root"),
          );
          const { profileHome } = authFixture;
          const modelId = "selected-hermes-model";
          return {
            selection: {
              runId,
              providerId: authFixture.providerSelection.providerId,
              modelId,
              endpointIdentity: "hermes-provider:openai-codex",
              endpointRevision: authFixture.providerSelection.endpointRevision!,
              sourceVersion: "v0.21.5+7357.g9244275",
              sourceCommit: "9244275491ee0d5bc3481590b041114c4e1d399a",
              sourceSnapshotKey: hermesSourceSnapshotKey,
              profileHome,
              ...(authFixture.profileHomePathChain ? { profileHomePathChain: authFixture.profileHomePathChain } : {}),
              authRouteEvidence: authFixture.authRouteEvidence,
            },
            cleanup: async () => { hermesCleanupCalls.push(runId); },
          };
        },
      } : {}),
      startRun: async (run: AgentRun) => {
        const result = run.role === "product_manager" ? productManagerOutput()
          : run.role === "architect" ? architectOutput()
            : output;
        outputs.set(run.id, result);
        const accepted = await runRef.current!.completionStore().accept(run.capabilityRef!, { runId: run.id, role: run.role, output: result });
        if (!accepted) throw new Error("test completion submission was rejected");
        db!.transaction((tx) => transitionRunProcessOwnerTx(tx, {
          runId: run.id, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
        }));
      },
      resumeRun: async () => {},
      cancelRun: async () => {},
      inspectRun: async () => { throw new Error("not used"); },
      collectResult: async (runId): Promise<RunOutcome> => ({
        success: true,
        exitCode: 0,
        output: JSON.stringify(outputs.get(runId)),
        validatedSubmission: true,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
      }),
      collectUsage: async () => { throw new Error("usage unavailable"); },
      runResult: async () => { throw new Error("not used"); },
      healthCheck: async () => true,
    };
    runRef.current = new RunService(db, runtime);
    const runs = runRef.current;
    const planning = new PlanningService(db);
    const request = planning.createQueuedRequest(projectId, "Implement the planned Epic", "local-user");
    const registry = new BackgroundJobRegistry();
    const scheduler = new SchedulerService(db);
    registerCoordinatorPlanningJob(registry, { db, planning, runs, scheduler });
    return { projectId, requestId: request.id, planning, registry, runs, scheduler, hermesPreflightCalls, hermesCleanupCalls };
  }

  it("keeps request, reservation, and resource lock active when Coordinator stop proof is unavailable", async () => {
    const { requestId, registry, runs } = await setup();
    vi.spyOn(runs, "executePreparedRun").mockImplementation(async (runId) => {
      db!.run("UPDATE agent_runs SET status='STARTED' WHERE id=$id", { id: runId });
      throw new Error("runtime stop is unproven");
    });
    vi.spyOn(runs, "failPreparedRun").mockReturnValue(false);

    const result = await new JobRunner(db!, registry).runOnce(new Date());

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(db!.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: requestId })?.status).toBe("PLANNING");
    const activeRun = db!.get<{ id: string }>("SELECT id FROM agent_runs WHERE role='coordinator' ORDER BY started_at DESC LIMIT 1")!;
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: activeRun.id })?.status).toBe("STARTED");
    const reservation = db!.get<{ id: string; status: string }>("SELECT id,status FROM scheduler_reservations WHERE run_id=$id", { id: activeRun.id });
    if (!reservation) throw new Error("Expected Coordinator scheduler reservation");
    expect(reservation.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservation.id })?.count).toBe(1);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(0);
  });

  it("keeps a planning role reservation when its failed Run has no persisted stop proof", async () => {
    const { requestId, registry, runs } = await setup();
    const execute = runs.executePreparedRun.bind(runs);
    vi.spyOn(runs, "executePreparedRun").mockImplementation(async (runId) => {
      const role = db!.get<{ role: string }>("SELECT role FROM agent_runs WHERE id=$id", { id: runId })?.role;
      if (role === "product_manager") {
        db!.run("UPDATE agent_runs SET status='STARTED' WHERE id=$id", { id: runId });
        throw new Error("runtime stop is unproven");
      }
      return execute(runId);
    });
    vi.spyOn(runs, "failPreparedRun").mockReturnValue(false);

    const result = await new JobRunner(db!, registry).runOnce(new Date());

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(db!.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: requestId })?.status).toBe("PLANNING");
    const activeRun = db!.get<{ id: string }>("SELECT id FROM agent_runs WHERE role='product_manager' ORDER BY started_at DESC LIMIT 1")!;
    const reservation = db!.get<{ id: string; status: string }>("SELECT id,status FROM scheduler_reservations WHERE run_id=$id", { id: activeRun.id });
    if (!reservation) throw new Error("Expected planning role scheduler reservation");
    expect(reservation.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservation.id })?.count).toBe(1);
  });

  it("persists validated PM and Architect decisions for explicit approval without child work, and duplicate delivery creates no duplicate planning Runs", async () => {
    const { projectId, requestId, registry, planning } = await setup();
    const runner = new JobRunner(db!, registry);

    const first = await runner.runOnce(new Date());
    expect(first).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(db!.get<{ status: string; classification: string; coordinator_run_id: string; plan_id: string }>(
      "SELECT status,classification,coordinator_run_id,plan_id FROM planning_requests WHERE id=$id", { id: requestId },
    )).toMatchObject({ status: "PLAN_PENDING_APPROVAL", classification: "EPIC" });
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(1);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(3);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id IS NOT NULL OR epic_id IS NOT NULL")?.count).toBe(0);
    const preparedRuns = db!.all<{ id: string; role: string; prompt: string; subject_type: string; request_id: string; prompt_hash: string }>(
      `SELECT r.id,r.role,r.prompt,cm.subject_type,cm.request_id,cm.prompt_hash
         FROM agent_runs r JOIN context_manifests cm ON cm.run_id=r.id ORDER BY r.role`,
    );
    expect(preparedRuns).toHaveLength(3);
    expect(preparedRuns.map(({ role }) => role)).toEqual(["architect", "coordinator", "product_manager"]);
    for (const run of preparedRuns) {
      expect(run).toMatchObject({ subject_type: "REQUEST", request_id: requestId });
      expect(run.prompt_hash).toBe(digestRunPromptBytesV1(new TextEncoder().encode(run.prompt)));
      const requestBinding = run.role === "coordinator"
        ? db!.get<{ run_id: string }>("SELECT coordinator_run_id AS run_id FROM planning_requests WHERE id=$requestId", { requestId })
        : db!.get<{ run_id: string }>("SELECT run_id FROM planning_request_role_runs WHERE request_id=$requestId AND role=$role", { requestId, role: run.role });
      expect(requestBinding?.run_id).toBe(run.id);
      expect(db!.get<{ source_tag: string; state: string; stop_evidence: string | null }>("SELECT source_tag,state,stop_evidence FROM run_process_owners WHERE run_id=$id", { id: run.id }))
        .toEqual({ source_tag: `ebb-run:${run.id}`, state: "STOPPED", stop_evidence: "NEVER_LAUNCHED" });
    }
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(3);
    expect(db!.get<{ status: string }>("SELECT status FROM planning_plans")?.status).toBe("PENDING");
    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations")?.status).toBe("RELEASED");
    expect(db!.all<{ role: string; run_id: string }>("SELECT role,run_id FROM planning_request_role_runs WHERE request_id=$requestId ORDER BY role", { requestId }))
      .toHaveLength(2);
    const savedPlan = JSON.parse(db!.get<{ plan_json: string }>("SELECT plan_json FROM planning_plans")!.plan_json) as { planningDecisions?: unknown };
    expect(savedPlan.planningDecisions).toEqual({
      productManager: expect.objectContaining({ outcome: "PRODUCT_DEFINITION", goal: "Deliver the requested user outcome" }),
      architect: expect.objectContaining({ outcome: "DESIGN", decisions: ["Keep the design within the existing module boundaries"] }),
    });

    enqueueJob(db!, { type: COORDINATOR_PLANNING_JOB, payload: { requestId, projectId }, dedupeKey: `duplicate:${requestId}` });
    const duplicate = await runner.runOnce(new Date());
    expect(duplicate).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(3);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(1);

    const request = db!.get<{ plan_id: string }>("SELECT plan_id FROM planning_requests WHERE id=$requestId", { requestId })!;
    planning.approvePlan(request.plan_id, "local-user", requestId);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(1);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(2);
  });

  it("preflights a fresh Hermes profile before each Coordinator, PM, and Architect transaction", async () => {
    const { requestId, registry, hermesPreflightCalls, hermesCleanupCalls } = await setup(epicOutput(), true);

    const result = await new JobRunner(db!, registry).runOnce(new Date());

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const runs = db!.all<{ id: string; role: string; model: string }>(
      "SELECT id,role,model FROM agent_runs WHERE role IN ('coordinator','product_manager','architect') ORDER BY role",
    );
    expect(runs).toHaveLength(3);
    expect(runs.every((run) => run.model === "selected-hermes-model")).toBe(true);
    expect(hermesPreflightCalls).toHaveLength(3);
    expect(new Set(hermesPreflightCalls)).toEqual(new Set(runs.map((run) => run.id)));
    expect(hermesCleanupCalls).toEqual([]);
    expect(db!.get<{ coordinator_run_id: string }>(
      "SELECT coordinator_run_id FROM planning_requests WHERE id=$requestId", { requestId },
    )?.coordinator_run_id).toBe(runs.find((run) => run.role === "coordinator")?.id);
    expect(db!.all<{ run_id: string }>(
      "SELECT run_id FROM planning_request_role_runs WHERE request_id=$requestId", { requestId },
    )).toHaveLength(2);
    for (const run of runs) {
      expect(db!.get<{ hermes_home: string }>(
        "SELECT hermes_home FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
      )?.hermes_home).toBe(join(root, "hermes-auth-root", "profiles", `ebb-orchestrator-run-${run.id}`));
    }
  });

  it("reuses a completed Coordinator Run after a crash before plan persistence", async () => {
    const { projectId, requestId, registry } = await setup();
    const runId = randomUUID();
    const now = new Date().toISOString();
    db!.run("INSERT INTO agent_runs(id,role,runtime,model,status,started_at,ended_at,output) VALUES($id,'coordinator','default','persisted','COMPLETED',$now,$now,$output)", {
      id: runId, now, output: JSON.stringify(epicOutput()),
    });
    db!.run("UPDATE planning_requests SET status='PLANNING',coordinator_run_id=$runId WHERE id=$requestId", { runId, requestId });
    enqueueJob(db!, { type: COORDINATOR_PLANNING_JOB, payload: { requestId, projectId }, dedupeKey: `recovery:${requestId}` });

    const result = await new JobRunner(db!, registry).runOnce(new Date());
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(db!.get<{ status: string; coordinator_run_id: string }>("SELECT status,coordinator_run_id FROM planning_requests WHERE id=$id", { id: requestId }))
      .toEqual({ status: "PLAN_PENDING_APPROVAL", coordinator_run_id: runId });
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(3);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id IS NOT NULL OR epic_id IS NOT NULL")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(1);
  });

  it("reuses the durable Product Manager Run after restart and creates only the missing Architect Run", async () => {
    const { projectId, requestId, registry } = await setup();
    const now = new Date().toISOString();
    const coordinatorRunId = randomUUID();
    const pmRunId = randomUUID();
    db!.run("INSERT INTO agent_runs(id,role,runtime,model,status,started_at,ended_at,output) VALUES($id,'coordinator','default','persisted','COMPLETED',$now,$now,$output)", {
      id: coordinatorRunId, now, output: JSON.stringify(epicOutput()),
    });
    db!.run("UPDATE planning_requests SET status='PLANNING',coordinator_run_id=$runId WHERE id=$requestId", { runId: coordinatorRunId, requestId });
    db!.run("INSERT INTO agent_runs(id,role,runtime,model,status,started_at,ended_at,output) VALUES($id,'product_manager','default','persisted','COMPLETED',$now,$now,$output)", {
      id: pmRunId, now, output: JSON.stringify(productManagerOutput()),
    });
    db!.run("INSERT INTO planning_request_role_runs(request_id,role,run_id,created_at) VALUES($requestId,'product_manager',$runId,$now)", { requestId, runId: pmRunId, now });

    enqueueJob(db!, { type: COORDINATOR_PLANNING_JOB, payload: { requestId, projectId }, dedupeKey: `restart-after-pm:${requestId}` });
    const result = await new JobRunner(db!, registry).runOnce(new Date());
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(db!.all<{ role: string }>("SELECT role FROM agent_runs ORDER BY role").map((row) => row.role).sort())
      .toEqual(["architect", "coordinator", "product_manager"]);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_request_role_runs WHERE request_id=$requestId", { requestId })?.count).toBe(2);
    expect(db!.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$requestId", { requestId })?.status).toBe("PLAN_PENDING_APPROVAL");
    const savedPlan = JSON.parse(db!.get<{ plan_json: string }>("SELECT plan_json FROM planning_plans")!.plan_json) as { planningDecisions?: { productManager: { goal?: string }; architect: { decisions?: string[] } } };
    expect(savedPlan.planningDecisions?.productManager.goal).toBe("Deliver the requested user outcome");
    expect(savedPlan.planningDecisions?.architect.decisions).toEqual(["Keep the design within the existing module boundaries"]);
  });

  it("records a controlled failure when a schema-valid output contradicts its classification", async () => {
    const invalid = { ...epicOutput(), classification: "TASK" };
    const { requestId, registry } = await setup(invalid);

    const result = await new JobRunner(db!, registry).runOnce(new Date());
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(db!.get<{ status: string; failure_code: string }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: requestId }))
      .toEqual({ status: "FAILED", failure_code: "COORDINATOR_OUTPUT_INVALID" });
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
  });
});

function epicOutput() {
  return {
    version: "1.0.0",
    operation: "PLAN",
    classification: "EPIC",
    plan: {
      epic: { title: "Reviewable Epic", goal: "Deliver a bounded feature" },
      tasks: [
        { ref: "task_base", title: "Base work", acceptanceCriteria: ["Base is complete"], role: "developer", workflow: "standard" },
        { ref: "task_followup", title: "Follow-up", acceptanceCriteria: ["Follow-up is complete"], dependsOn: ["task_base"], role: "developer", workflow: "standard" },
      ],
    },
  };
}

function productManagerOutput() {
  return {
    version: "1.0.0", outcome: "PRODUCT_DEFINITION",
    goal: "Deliver the requested user outcome",
    scope: ["Implement the approved request"], nonGoals: ["Change unrelated modules"],
    requirements: ["Preserve existing approval boundaries"], acceptanceCriteria: ["The request is reviewable before approval"],
  };
}

function architectOutput() {
  return {
    version: "1.0.0", outcome: "DESIGN",
    components: ["Planning module"], interfaces: ["Project-scoped request detail"],
    decisions: ["Keep the design within the existing module boundaries"],
    proposals: [], architectureReviewRequired: false,
  };
}

function seedApprovedProjectConfig(database: Database, projectId: string): void {
  const projectYaml = "schema_version: 1\nproject:\n  name: sample\n  default_branch: main\n";
  const sourceFiles = { ".ebb-orchestrator/project.yaml": Buffer.from(projectYaml, "utf8").toString("base64") };
  const manifestJson = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: createHash("sha256").update(projectYaml, "utf8").digest("hex") }] });
  const hashDomain = (domain: string, value: string) => createHash("sha256").update(domain, "utf8").update(value, "utf8").digest("hex");
  const sortValue = (value: unknown): unknown => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, sortValue(entry)]))
    : value;
  const payload = { project: parseProjectConfigYaml(projectYaml), files: sourceFiles };
  const repo = new ProjectConfigRepository(database);
  const candidate = repo.capture({
    projectId, sourceHead: "a".repeat(40), manifestJson,
    manifestHash: hashDomain("ebb-project-config-manifest-v1\0", manifestJson),
    sourceFilesJson: JSON.stringify(sourceFiles), normalizedPayloadJson: JSON.stringify(sortValue(payload)), schemaVersion: 1,
  });
  new ProjectConfigService(database, new ApprovalService(database)).approve(projectId, candidate.candidate_id, candidate.manifest_hash);
}
