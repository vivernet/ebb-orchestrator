import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import { FakeAgentRuntime } from "../fakes/fake-agent-runtime.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { Database } from "../../src/platform/database/database.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import { containmentKindForPlatform, transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import { stopEvidenceForContainmentKind } from "../helpers/run-process-owner-fixture.js";
import { createResumeContextBaselineV1, digestResumeBindingV1 } from "../../src/modules/context/resume-eligibility.js";
import { digestRunPromptBytesV1 } from "../../src/modules/context/context-provenance.js";

const migrations = loadTestMigrations();

describe("run controls integration with real RunService + SchedulerService", () => {
  let db: Database;
  let tmpDir: string;
  let scheduler: SchedulerService;
  let runService: RunService;
  let runtime: FakeAgentRuntime & { pauseRun?: (runId: string) => Promise<void> };
  let app: ReturnType<typeof createApp>;
  let projectId: string;
  let taskId: string;
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-run-control-integration-"));
    db = createSqliteDatabase(join(tmpDir, `test-${randomUUID()}.db`));
    runMigrations(db, migrations);
    projectId = randomUUID();
    taskId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',1,$now,$now)", { id: taskId, projectId, now });
    // Dispatch eligibility: onboarding + approved project config.
    seedApprovedProjectConfig(db, projectId);
    const approvalId = db.get<{ id: string }>("SELECT id FROM approvals WHERE subject_id=$projectId AND type='WORKFLOW_CHANGE' ORDER BY created_at DESC LIMIT 1", { projectId })!.id;
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,'/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { projectId, approvalId, now });
    scheduler = new SchedulerService(db);
    runtime = new FakeAgentRuntime();
    runService = new RunService(db, runtime as unknown as AgentRuntime);
    app = createApp({ db, scheduler, runService, authService: createTestAuthService() });
    cleanups.push(async () => { await app.close(); db.close(); });
  }

  function headers(idempotencyKey: string): Record<string, string> {
    return { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN, "idempotency-key": idempotencyKey };
  }

  function seedPauseReadyRun(runId: string): void {
    const role = "reviewer";
    const containmentKind = containmentKindForPlatform(process.platform)!;
    const containmentId = (randomUUID() + randomUUID()).replaceAll("-", "");
    const launchNonce = (randomUUID() + randomUUID()).replaceAll("-", "");
    const sessionId = "original-session";
    const contextHash = "a".repeat(64);
    const workspaceHash = "b".repeat(64);
    const now = new Date().toISOString();
    const capRef = `cap-${runId}`;
    db.run(`INSERT INTO agent_runs(id,role,runtime,model,task_id,status,session_id,attempt,trigger_reason,context_version,prompt,output_schema_version,started_at,ended_at,exit_code,input_tokens,cached_input_tokens,output_tokens,cost,capability_ref,capability_json)
      VALUES($id,$role,'hermes','model',$taskId,'IN_PROGRESS',$sessionId,NULL,'REVIEW_REQUEST','1','prompt','1',$now,NULL,NULL,NULL,NULL,NULL,NULL,$capRef,$capJson)`,
      { id: runId, role, taskId, sessionId, now, capRef, capJson: JSON.stringify({ id: capRef, capabilityRef: capRef, runId, workspace: "/ws", allowedTools: ["submit_result"] }) });
    db.run(`INSERT INTO run_process_owner_generations(run_id,generation,run_attempt,source_tag,hermes_home,capture_state,containment_kind,containment_id,launch_nonce,state,stop_evidence,updated_at)
      VALUES($id,1,NULL,$tag,$home,'BOUND',$kind,$containmentId,$launchNonce,'STOPPED',$evidence,$now)`,
      { id: runId, tag: `ebb-run:${runId}`, home: `/home/${runId}`, kind: containmentKind, containmentId, launchNonce, evidence: stopEvidenceForContainmentKind(containmentKind), now });
    db.run(`INSERT INTO run_process_owners(run_id,source_tag,hermes_home,capture_state,containment_kind,containment_id,launch_nonce,state,stop_evidence,updated_at,current_generation)
      VALUES($id,$tag,$home,'BOUND',$kind,$containmentId,$launchNonce,'STOPPED',$evidence,$now,1)`,
      { id: runId, tag: `ebb-run:${runId}`, home: `/home/${runId}`, kind: containmentKind, containmentId, launchNonce, evidence: stopEvidenceForContainmentKind(containmentKind), now });
    db.run(`INSERT INTO run_resume_bindings(run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,workspace_snapshot_bound,workspace_snapshot_hash,resume_binding_hash,original_session_id,created_at)
      VALUES($id,1,$baseline,$contextHash,1,1,$workspaceHash,$bindingHash,$sessionId,$now)`,
      { id: runId, contextHash, workspaceHash, bindingHash: digestResumeBindingV1(contextHash, workspaceHash), sessionId, baseline: JSON.stringify(createResumeContextBaselineV1({ promptHash: digestRunPromptBytesV1(new TextEncoder().encode("prompt")), subjectType: "TASK", subjectId: taskId, role, contractOrRequestDigest: null, items: [], contextBuilderVersion: "1.0.0", roleVersion: null, runtime: "default", runtimeVersion: null, model: "model", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1", workspaceIdentity: { repository: "/tmp", workspace: "/ws", worktree: taskId }, targetHead: null, targetBranch: null, effectiveCapabilityIds: ["submit_result"], projectConfigRevisionId: null, projectConfigHash: null, policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null } })), now });
  }

  function insertRunReservation(runId: string): void {
    const reservationId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,approval_id,run_id) VALUES($id,'PHASE',$runId,$projectId,$ownerId,$now,1,'RESERVED','reviewer','default',NULL,$runId)", { id: reservationId, runId, projectId, ownerId: `run:${runId}`, now });
    db.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES($key,$id,$projectId,$ownerId,$now)", { key: `run:${runId}`, id: reservationId, projectId, ownerId: `run:${runId}`, now });
  }

  function insertExtraReservedReservation(): void {
    const otherRunId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO agent_runs(id,role,runtime,model,task_id,status,trigger_reason,context_version,prompt,output_schema_version,started_at,capability_ref,capability_json) VALUES($id,'developer','hermes','model',NULL,'IN_PROGRESS','DEVELOPMENT','1','prompt','1',$now,$capRef,'{}')", { id: otherRunId, now, capRef: `cap-${otherRunId}` });
    db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES($id,'PHASE',$runId,$projectId,$ownerId,$now,1,'RESERVED','developer','default',$runId)", { id: randomUUID(), runId: otherRunId, projectId, ownerId: `run:${otherRunId}`, now });
  }

  function markLaunchGenerationStopped(runId: string): void {
    db.transaction((tx) => {
      const owner = tx.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId });
      if (owner?.state === "PREPARED") {
        transitionRunProcessOwnerTx(tx, { runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED" });
      }
    });
  }

  function lockRowsForRun(runId: string): unknown[] {
    return db.all("SELECT * FROM scheduler_resource_locks WHERE reservation_id=(SELECT id FROM scheduler_reservations WHERE run_id=$runId AND status='RESERVED' AND kind <> 'LOCK' LIMIT 1)", { runId });
  }

  it("pause releases the scheduler hold; resume above capacity is blocked pre-launch", async () => {
    await setup();
    const runId = randomUUID();
    seedPauseReadyRun(runId);
    insertRunReservation(runId);
    runtime.pauseRun = async () => {};

    const pause = await app.inject({ method: "POST", url: `/api/v1/runs/${runId}/pause`, headers: headers("req-pause") });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().control?.state).toBe("PAUSED");
    expect(lockRowsForRun(runId)).toHaveLength(0);

    // Fill capacity beyond globalMax so the resume admission gate rejects.
    for (let i = 0; i < 4; i++) insertExtraReservedReservation();
    const resumeSpy = vi.spyOn(runtime, "resumeRun");

    const resume = await app.inject({ method: "POST", url: `/api/v1/runs/${runId}/resume`, headers: headers("req-resume-blocked") });
    expect(resume.statusCode).toBe(409);
    expect(resume.json().error?.code).toBe("WAITING_FOR_CAPACITY");
    expect(resumeSpy).not.toHaveBeenCalled();

    const state = db.get<{ state: string; checkpoint_id: string | null }>("SELECT state,checkpoint_id FROM run_control_state WHERE run_id=$runId", { runId });
    expect(state).toMatchObject({ state: "PAUSED", checkpoint_id: expect.any(String) });
    expect(db.get("SELECT status FROM run_control_commands WHERE request_id='req-resume-blocked'")?.status).toBe("FAILED");
    expect(lockRowsForRun(runId)).toHaveLength(0);
  });

  it("successful resume reacquires the scheduler hold and relaunches", async () => {
    await setup();
    const runId = randomUUID();
    seedPauseReadyRun(runId);
    insertRunReservation(runId);
    runtime.pauseRun = async () => {};

    const pause = await app.inject({ method: "POST", url: `/api/v1/runs/${runId}/pause`, headers: headers("req-pause-ok") });
    expect(pause.statusCode).toBe(200);

    const resumeSpy = vi.spyOn(runtime, "resumeRun").mockImplementation(async () => {});
    vi.spyOn(runtime, "collectResult").mockImplementation(async (rid: string) => {
      const output = JSON.stringify({ version: "1", outcome: "PASS" });
      await runService.completionStore().accept(runService.getCapabilityReference(rid), { runId: rid, role: "reviewer", output: JSON.parse(output) });
      markLaunchGenerationStopped(rid);
      return { success: true, exitCode: 0, output, validatedSubmission: true, diagnostics: { runId: rid, sessionId: "original-session", stderr: "", exitCode: 0, artifactReferences: [] } };
    });
    vi.spyOn(runtime, "collectUsage").mockResolvedValue({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: 0.1 });

    const resume = await app.inject({ method: "POST", url: `/api/v1/runs/${runId}/resume`, headers: headers("req-resume-ok") });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().control?.state).toBe("ACTIVE");
    expect(resumeSpy).toHaveBeenCalledWith(runId, expect.objectContaining({ sessionId: "original-session", attempt: 1 }));
    expect(lockRowsForRun(runId)).toHaveLength(1);
  });
});
