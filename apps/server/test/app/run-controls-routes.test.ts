import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import type { CancelAllRunsResult, RunControlCommandResult } from "@ebb-orchestrator/contracts";
import type { RunCommandService } from "../../src/app/routes/runs.js";
import { randomUUID } from "node:crypto";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";

const NOW = "2026-10-25T00:00:00.000Z";

const ACTIVE_CONTROL: NonNullable<RunControlCommandResult["control"]> = { state: "ACTIVE", version: 1, updatedAt: NOW, checkpointId: null };

function seedRun(db: ReturnType<typeof createSqliteDatabase>, runId: string, fields: {
  role?: string; status?: string; taskId?: string | null; inputTokens?: number | null; cachedInputTokens?: number | null;
  outputTokens?: number | null; cost?: number | null; sessionId?: string | null; attempt?: number | null; exitCode?: number | null;
} = {}) {
  const taskId = fields.taskId === undefined ? "task-1" : fields.taskId;
  db.run(
    `INSERT INTO agent_runs(id,role,runtime,model,task_id,status,trigger_reason,context_version,prompt,output_schema_version,started_at,ended_at,exit_code,input_tokens,cached_input_tokens,output_tokens,cost,session_id,attempt,capability_ref,capability_json)
     VALUES($id,$role,'hermes',$model,$taskId,$status,'DEVELOPMENT','1','prompt','1',$now,$endedAt,$exitCode,$inputTokens,$cachedInputTokens,$outputTokens,$cost,$sessionId,$attempt,$capRef,$capJson)`,
    {
      id: runId, role: fields.role ?? "developer", model: "model", taskId: taskId ?? null, status: fields.status ?? "IN_PROGRESS",
      now: NOW, endedAt: null, exitCode: fields.exitCode ?? null,
      inputTokens: fields.inputTokens ?? null, cachedInputTokens: fields.cachedInputTokens ?? null,
      outputTokens: fields.outputTokens ?? null, cost: fields.cost ?? null,
      sessionId: fields.sessionId ?? null, attempt: fields.attempt ?? null,
      capRef: `cap-${runId}`, capJson: JSON.stringify({ id: `cap-${runId}`, capabilityRef: `cap-${runId}`, runId, workspace: "/ws", allowedTools: ["submit_result"] }),
    },
  );
}

function insertEvent(db: ReturnType<typeof createSqliteDatabase>, id: string, runId: string, type: string, createdAt: string, payload: unknown) {
  db.run(
    `INSERT INTO outbox_events(id,type,aggregate_type,aggregate_id,payload_json,created_at,available_at,attempts)
     VALUES($id,$type,'AgentRun',$runId,$payload,$createdAt,$createdAt,0)`,
    { id, type, runId, payload: JSON.stringify(payload), createdAt },
  );
}

/** Делает проект dispatch-элигибельным (onboarding + approved project config). */
function seedDispatchEligibleProject(db: ReturnType<typeof createSqliteDatabase>) {
  const now = NOW;
  db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE','project-1','PROJECT','APPROVED','test',$now)", { id: randomUUID(), now });
  seedApprovedProjectConfig(db, "project-1");
  const approvalId = db.get<{ id: string }>("SELECT id FROM approvals WHERE subject_id='project-1' AND type='WORKFLOW_CHANGE' ORDER BY created_at DESC LIMIT 1")!.id;
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES('project-1','/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { approvalId, now });
}

/** Резервирует PHASE-слот Run с удержанным resource lock (как после dispatch). */
function insertRunReservation(db: ReturnType<typeof createSqliteDatabase>, runId: string) {
  const reservationId = randomUUID();
  const now = NOW;
  db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES($id,'PHASE',$runId,'project-1',$ownerId,$now,1,'RESERVED','reviewer','default',$runId)", { id: reservationId, runId, ownerId: `run:${runId}`, now });
  db.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES($key,$id,'project-1',$ownerId,$now)", { key: `run:${runId}`, id: reservationId, ownerId: `run:${runId}`, now });
}

describe("run controls HTTP routes", () => {
  const cleanups: (() => Promise<void>)[] = [];
  let db: ReturnType<typeof createSqliteDatabase>;
  let scheduler: SchedulerService;
  let runService: {
    cancelRun: ReturnType<typeof vi.fn>;
    createCheckpoint?: ReturnType<typeof vi.fn>;
    pauseRun?: ReturnType<typeof vi.fn>;
    resumeRunControl?: ReturnType<typeof vi.fn>;
    cancelAllRuns?: ReturnType<typeof vi.fn>;
  } & Partial<RunCommandService>;
  let app: ReturnType<typeof createApp>;
  let headers: Record<string, string>;

  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  function setup(overrides: { runService?: Partial<typeof runService> } = {}) {
    db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES('project-1','p','P','ACTIVE',$now,$now)", { now: NOW });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('task-1','project-1','T-1','Task','READY','{}',$now,$now)", { now: NOW });
    scheduler = new SchedulerService(db);
    runService = {
      cancelRun: vi.fn(async () => undefined),
      createCheckpoint: vi.fn(async (_runId: string, _requestId: string): Promise<RunControlCommandResult> => ({
        command: "CHECKPOINT", status: "FAILED", control: ACTIVE_CONTROL, failureCode: "CHECKPOINT_UNPROVEN",
      })),
      pauseRun: vi.fn(async (_runId: string, _requestId: string): Promise<RunControlCommandResult> => ({
        command: "PAUSE", status: "COMPLETED", control: { state: "PAUSED", version: 2, updatedAt: NOW, checkpointId: "cp-1" }, failureCode: null,
      })),
      resumeRunControl: vi.fn(async (_runId: string, _requestId: string): Promise<RunControlCommandResult> => ({
        command: "RESUME", status: "COMPLETED", control: ACTIVE_CONTROL, failureCode: null,
      })),
      cancelAllRuns: vi.fn(async (expectedRunIds: string[]): Promise<CancelAllRunsResult> => ({
        results: expectedRunIds.map((runId) => ({ runId, outcome: "CANCELLED" as const })),
      })),
      ...overrides.runService,
    } as unknown as typeof runService;
    app = createApp({ db, scheduler, runService: runService as unknown as RunCommandService, authService: createTestAuthService() });
    cleanups.push(async () => { await app.close(); db.close(); });
    headers = { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN };
    return { app, db, runService, headers };
  }

  it("preserves numeric zero vs NULL unavailable per usage field in the run detail projection", async () => {
    setup();
    seedRun(db, "run-zero", { inputTokens: 0, cachedInputTokens: null, outputTokens: 120, cost: 0 });
    seedRun(db, "run-null", { inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null });

    const zero = await app.inject({ method: "GET", url: "/api/v1/runs/run-zero", headers: { cookie: TEST_COOKIE } });
    expect(zero.statusCode).toBe(200);
    expect(zero.json().usage).toEqual({
      inputTokens: { availability: "available", value: 0 },
      cachedInputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      outputTokens: { availability: "available", value: 120 },
      effectiveCost: { availability: "available", value: 0 },
    });

    const absent = await app.inject({ method: "GET", url: "/api/v1/runs/run-null", headers: { cookie: TEST_COOKIE } });
    expect(absent.statusCode).toBe(200);
    expect(absent.json().usage).toEqual({
      inputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      cachedInputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      outputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      effectiveCost: { availability: "unavailable", reason: "NOT_RECORDED" },
    });
    // Никакого ?? 0 fallback: NULL не превращается в 0.
    expect(absent.json().usage.inputTokens).not.toEqual({ availability: "available", value: 0 });
  });

  it("pages run events by a bounded outbox cursor in (created_at,id) order, contained to the Run", async () => {
    setup();
    seedRun(db, "run-1");
    seedRun(db, "run-2");
    insertEvent(db, "e1", "run-1", "AgentRunStarted", "2026-10-25T00:00:01.000Z", { runId: "run-1" });
    insertEvent(db, "e2", "run-1", "AgentRunCheckpointed", "2026-10-25T00:00:01.000Z", { runId: "run-1" });
    insertEvent(db, "e3", "run-1", "AgentRunPaused", "2026-10-25T00:00:02.000Z", { runId: "run-1" });
    insertEvent(db, "x1", "run-2", "AgentRunStarted", "2026-10-25T00:00:03.000Z", { runId: "run-2" });

    const first = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/events?limit=2", headers: { cookie: TEST_COOKIE } });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((item: { id: string }) => item.id)).toEqual(["e1", "e2"]);
    expect(first.json().nextCursor).toBe("e2");

    const second = await app.inject({ method: "GET", url: `/api/v1/runs/run-1/events?afterId=${first.json().nextCursor}&limit=2`, headers: { cookie: TEST_COOKIE } });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((item: { id: string }) => item.id)).toEqual(["e3"]);
    expect(second.json().nextCursor).toBeNull();

    // Курсор из чужого Run не расширяет scope: 400 INVALID_CURSOR.
    const foreign = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/events?afterId=x1", headers: { cookie: TEST_COOKIE } });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });

    // Неизвестный курсор — тот же 400.
    const unknown = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/events?afterId=nope", headers: { cookie: TEST_COOKIE } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });

    // limit вне [1,200] отклоняется.
    const badLimit = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/events?limit=201", headers: { cookie: TEST_COOKIE } });
    expect(badLimit.statusCode).toBe(400);
  });

  it("sanitizes secret-shaped strings from the run event DTO", async () => {
    setup();
    seedRun(db, "run-1");
    insertEvent(db, "e1", "run-1", "AgentRunStarted", "2026-10-25T00:00:01.000Z",
      { runId: "run-1", note: "credential sk-abcdef1234567890abcdef1234567890 leaked" });

    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/events?limit=10", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).not.toContain("sk-abcdef1234567890abcdef1234567890");
    expect(body).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]+/);
  });

  it("exposes the terminal projection as unavailable without a sanitized persisted source", async () => {
    setup();
    seedRun(db, "run-1");
    const response = await app.inject({ method: "GET", url: "/api/v1/runs/run-1/terminal", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ availability: "unavailable", reason: "NO_SANITIZED_PERSISTED_SOURCE" });
    expect(response.body).not.toMatch(/sk-|Bearer\s+\S+/);
  });

  it("runs cancel-all only over the confirmed list and returns ordered per-ID outcomes", async () => {
    setup({
      runService: {
        cancelAllRuns: vi.fn(async (expectedRunIds: string[]): Promise<CancelAllRunsResult> => {
          const results: CancelAllRunsResult["results"] = [
            { runId: "run-1", outcome: "CANCELLED" },
            { runId: "run-2", outcome: "NOT_ACTIVE" },
            { runId: "run-3", outcome: "FAILED" },
          ];
          return { results: results.filter((entry) => expectedRunIds.includes(entry.runId)) };
        }),
      },
    });
    seedRun(db, "run-1");
    seedRun(db, "run-2", { status: "COMPLETED" });
    seedRun(db, "run-3");

    const response = await app.inject({
      method: "POST", url: "/api/v1/runs/cancel-all", headers,
      payload: { expectedRunIds: ["run-1", "run-2", "run-3"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        { runId: "run-1", outcome: "CANCELLED" },
        { runId: "run-2", outcome: "NOT_ACTIVE" },
        { runId: "run-3", outcome: "FAILED" },
      ],
    });
    expect(runService.cancelAllRuns).toHaveBeenCalledWith(["run-1", "run-2", "run-3"]);
    // Никакой новый Run не добавляется неявно.
    expect(runService.cancelAllRuns).toHaveBeenCalledTimes(1);
  });

  it("rejects empty or duplicate cancel-all lists", async () => {
    setup();
    for (const payload of [{ expectedRunIds: [] }, { expectedRunIds: ["run-1", "run-1"] }, { extra: true }]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/runs/cancel-all", headers, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(runService.cancelAllRuns).not.toHaveBeenCalled();
  });

  it("maps pause/resume/checkpoint service outcomes and typed conflicts to HTTP codes", async () => {
    setup({
      runService: {
        pauseRun: vi.fn(async (): Promise<RunControlCommandResult> => ({
          command: "PAUSE", status: "COMPLETED",
          control: { state: "PAUSED", version: 2, updatedAt: NOW, checkpointId: "cp-1" },
          failureCode: null,
        })),
        resumeRunControl: vi.fn(async (): Promise<RunControlCommandResult> => ({
          command: "RESUME", status: "COMPLETED",
          control: { state: "ACTIVE", version: 4, updatedAt: NOW, checkpointId: null },
          failureCode: null,
        })),
        createCheckpoint: vi.fn(async (): Promise<RunControlCommandResult> => ({
          command: "CHECKPOINT", status: "FAILED", control: ACTIVE_CONTROL, failureCode: "CHECKPOINT_UNPROVEN",
        })),
      },
    });
    seedRun(db, "run-1");
    seedDispatchEligibleProject(db);
    insertRunReservation(db, "run-1");

    const pause = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/pause", headers: { ...headers, "idempotency-key": "key-pause" } });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({ command: "PAUSE", status: "COMPLETED", control: { state: "PAUSED" } });

    const resume = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/resume", headers: { ...headers, "idempotency-key": "key-resume" } });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({ command: "RESUME", status: "COMPLETED", control: { state: "ACTIVE" } });

    const checkpoint = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/checkpoint", headers: { ...headers, "idempotency-key": "key-cp" } });
    expect(checkpoint.statusCode).toBe(503);
    expect(checkpoint.json()).toMatchObject({ error: { code: "CHECKPOINT_UNPROVEN" } });
  });

  it("requires idempotency key for run control mutations and returns 401 unauthenticated", async () => {
    setup();
    seedRun(db, "run-1");

    const noKey = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/pause", headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({ error: { code: "RUN_REQUEST_IDEMPOTENCY_KEY_REQUIRED" } });

    const unauthenticated = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/pause" });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("rejects run control on an unknown run", async () => {
    setup({
      runService: {
        pauseRun: vi.fn(async () => { throw new Error("Run run-missing not found"); }),
      },
    });
    const pause = await app.inject({ method: "POST", url: "/api/v1/runs/run-missing/pause", headers: { ...headers, "idempotency-key": "key-missing" } });
    expect(pause.statusCode).toBe(404);
  });

  it("accepts an idempotent replay of the same control request", async () => {
    setup();
    seedRun(db, "run-1");
    const call = () => app.inject({ method: "POST", url: "/api/v1/runs/run-1/pause", headers: { ...headers, "idempotency-key": "key-replay" } });
    const first = await call();
    expect(first.statusCode).toBe(200);
    const replay = await call();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(runService.pauseRun).toHaveBeenCalledTimes(2);
  });

  it("rejects stale control state conflicts with a typed 409", async () => {
    setup({
      runService: {
        pauseRun: vi.fn(async () => { throw new Error("RUN_CONTROL_STATE_CONFLICT"); }),
      },
    });
    seedRun(db, "run-1");
    const response = await app.inject({ method: "POST", url: "/api/v1/runs/run-1/pause", headers: { ...headers, "idempotency-key": "key-conflict" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "RUN_CONTROL_STATE_CONFLICT" } });
  });
});
