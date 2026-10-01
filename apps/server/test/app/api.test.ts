import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { OnboardingService } from "../../src/modules/projects/onboarding-service.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ArtifactRepository } from "../../src/platform/artifacts/artifact-repository.js";
import { ArtifactStore } from "../../src/platform/artifacts/artifact-store.js";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return { version: Number(match[1]), name: match[2]!, sql: readFileSync(join(migrationDir, file), "utf8") };
});

const mockRuntime: AgentRuntime = {
  active: 0, maxActive: 0, calls: [],
  async startRun() {},
  async runResult(_runId: string) { return { version: "1.0", summary: "" } as never; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("not implemented"); },
  async collectResult() { return { success: true, exitCode: 0, output: "", validatedSubmission: false, diagnostics: { runId: "", sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } } as never; },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};

function makeApp() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const scheduler = new SchedulerService(db);
  return createApp({ db, scheduler, runtime: mockRuntime, authService: createTestAuthService() });
}

function makeAppWithDatabase() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const scheduler = new SchedulerService(db);
  const authService = createTestAuthService();
  const approvalService = new ApprovalService(db);
  const onboardingService = new OnboardingService(db, approvalService);
  return { app: createApp({ db, scheduler, runtime: mockRuntime, authService, approvalService, onboardingService }), db, authService };
}

const validContract = {
  version: 1,
  goal: "Implement health endpoint",
  context: "The service needs a stable health probe.",
  requirements: ["Expose GET /health"],
  acceptanceCriteria: ["Returns HTTP 200"],
  dependencies: [],
  nonGoals: [],
  definitionOfDone: ["Tests pass"],
};

function mutationHeaders(_app: ReturnType<typeof makeApp>) {
  return {
    cookie: TEST_COOKIE,
    origin: "http://127.0.0.1:3000",
    "x-csrf-token": TEST_CSRF_TOKEN,
  };
}

describe("orchestrator read API", () => {
  it("lists only run-scoped artifact metadata and never returns artifact contents", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const scheduler = new SchedulerService(db);
    const artifactsDirectory = await mkdtemp(join(tmpdir(), "run-artifact-metadata-"));
    const artifactStore = new ArtifactStore(artifactsDirectory, new ArtifactRepository(db));
    const runId = "run-artifact-metadata";
    db.run(
      "INSERT INTO agent_runs (id,role,runtime,model,status) VALUES ($id,'developer','hermes','test','COMPLETED')",
      { id: runId },
    );
    const artifact = await artifactStore.writeArtifact({
      type: "test-report",
      contentType: "text/plain",
      bytes: Buffer.from("private artifact fixture"),
      runId,
    });
    await artifactStore.writeArtifact({
      type: "other-run-report",
      contentType: "text/plain",
      bytes: Buffer.from("unrelated fixture"),
      runId: "another-run",
    });
    const app = createApp({
      db,
      scheduler,
      runtime: mockRuntime,
      authService: createTestAuthService(),
      artifactStore,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${runId}/artifacts`,
        headers: { cookie: TEST_COOKIE },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([{
        id: artifact.id,
        type: "test-report",
        contentType: "text/plain",
        sizeBytes: Buffer.byteLength("private artifact fixture"),
        sha256: artifact.sha256,
        status: "ACTIVE",
        createdAt: expect.any(String),
      }]);
      expect(response.body).not.toContain("private artifact fixture");
      expect(response.body).not.toContain("unrelated fixture");
      expect(response.body).not.toContain("storagePath");

      const missingRun = await app.inject({
        method: "GET",
        url: "/api/v1/runs/missing-run/artifacts",
        headers: { cookie: TEST_COOKIE },
      });
      expect(missingRun.statusCode).toBe(404);
    } finally {
      await app.close();
      db.close();
      await rm(artifactsDirectory, { recursive: true, force: true });
    }
  });

  it("returns safe subject-bound context manifest availability for Task, Epic, and Request runs", async () => {
    const { app, db } = makeAppWithDatabase();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES ('context-project','context','Context','ACTIVE',$now,$now)", { now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('context-task','context-project','T-1','Task','READY','{}',$now,$now)", { now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('other-context-task','context-project','T-2','Other task','READY','{}',$now,$now)", { now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('third-context-task','context-project','T-3','Third task','READY','{}',$now,$now)", { now });
    db.run("UPDATE tasks SET contract_json=$contract WHERE id='context-task'", { contract: JSON.stringify({ note: "private contract sentinel", knowledge: "private knowledge sentinel" }) });
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('context-epic','context-project','E-1','Epic','OPEN','{}',$now,$now)", { now });
    db.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,task_id) VALUES ('context-run','developer','hermes','test','COMPLETED','context-task')",
    );
    db.run("UPDATE agent_runs SET prompt=$prompt WHERE id='context-run'", { prompt: "private task prompt sentinel credential-sentinel hidden runtime prompt sentinel" });
    db.run("INSERT INTO agent_runs(id,role,runtime,model,status,task_id) VALUES ('other-context-run','reviewer','hermes','test','COMPLETED','context-task')");
    db.run("INSERT INTO agent_runs(id,role,runtime,model,status,task_id) VALUES ('wrong-task-run','reviewer','hermes','test','COMPLETED','other-context-task')");
    db.run(
      `INSERT INTO context_manifests(
        id,run_id,subject_type,task_id,role,contract_request_digest,items_json,prompt_hash,context_hash,
        context_builder_version,initial_token_size,created_at
      ) VALUES (
        'manifest-1','context-run','TASK','context-task','developer',$contractDigest,
        $items,$promptHash,$contextHash,
        'context-builder-v2',999,$now
      )`,
      {
        now,
        contractDigest: "a".repeat(64),
        items: JSON.stringify([
          { id: "guideline-1", version: 3, digest: "b".repeat(64) },
          { id: "decision-2", version: null, digest: "c".repeat(64) },
          { id: "finding-3", version: null, digest: "d".repeat(64) },
          { id: "defect-4", version: null, digest: "e".repeat(64) },
        ]),
        promptHash: "f".repeat(64),
        contextHash: "1".repeat(64),
      },
    );
    db.run("INSERT INTO agent_runs(id,role,runtime,model,status,capability_json) VALUES ('request-run','coordinator','hermes','test','COMPLETED',$capability)", { capability: JSON.stringify({ requestId: "context-request" }) });
    db.run("INSERT INTO planning_requests(id,project_id,request,requested_by,created_at,coordinator_run_id,status,updated_at) VALUES ('context-request','context-project','private request sentinel','user',$now,'request-run','RECEIVED',$now)", { now });
    db.run("INSERT INTO agent_runs(id,role,runtime,model,status,epic_id) VALUES ('epic-run','architect','hermes','test','COMPLETED','context-epic')");
    db.run("INSERT INTO agent_runs(id,role,runtime,model,status,task_id) VALUES ('legacy-run','qa','hermes','test','COMPLETED','third-context-task')");
    db.run(
      `INSERT INTO context_manifests(
       id,run_id,subject_type,task_id,role,contract_request_digest,items_json,prompt_hash,context_hash,context_builder_version,created_at
       ) VALUES ('other-run-manifest','other-context-run','TASK','context-task','reviewer',NULL,'[]',$promptHash,$contextHash,'builder-v2',$now)`,
      { now, promptHash: "4".repeat(64), contextHash: "5".repeat(64) },
    );
    db.run(
      `INSERT INTO context_manifests(
        id,run_id,subject_type,task_id,role,contract_request_digest,items_json,prompt_hash,context_hash,context_builder_version,created_at
       ) VALUES ('wrong-task-manifest','wrong-task-run','TASK','other-context-task','reviewer',NULL,'[]',$promptHash,$contextHash,'builder-v2',$now)`,
      { now, promptHash: "2".repeat(64), contextHash: "3".repeat(64) },
    );
    db.run(
      `INSERT INTO context_manifests(
        id,run_id,subject_type,epic_id,role,contract_request_digest,items_json,prompt_hash,context_hash,context_builder_version,created_at
       ) VALUES ('epic-manifest','epic-run','EPIC','context-epic','architect',NULL,'[]',$promptHash,$contextHash,'builder-v3',$now)`,
      { now, promptHash: "6".repeat(64), contextHash: "7".repeat(64) },
    );
    db.run(
      `INSERT INTO context_manifests(
        id,run_id,subject_type,request_id,role,contract_request_digest,items_json,prompt_hash,context_hash,context_builder_version,created_at
       ) VALUES ('request-manifest','request-run','REQUEST','context-request','coordinator',NULL,'[]',$promptHash,$contextHash,'builder-v4',$now)`,
      { now, promptHash: "8".repeat(64), contextHash: "9".repeat(64) },
    );

    try {
      const taskResponse = await app.inject({
        method: "GET",
        url: "/api/v1/runs/context-run/context-manifests",
        headers: { cookie: TEST_COOKIE },
      });
      expect(taskResponse.statusCode).toBe(200);
      expect(JSON.parse(taskResponse.body)).toEqual({
        availability: "available",
        id: "manifest-1",
        runId: "context-run",
        subject: { type: "TASK", id: "context-task" },
        role: "developer",
        contractRequestDigest: "a".repeat(64),
        items: [
          { id: "guideline-1", version: 3, digest: "b".repeat(64) },
          { id: "decision-2", version: null, digest: "c".repeat(64) },
          { id: "finding-3", version: null, digest: "d".repeat(64) },
          { id: "defect-4", version: null, digest: "e".repeat(64) },
        ],
        promptHash: "f".repeat(64),
        contextHash: "1".repeat(64),
        contextBuilderVersion: "context-builder-v2",
        initialTokenSize: 999,
      });
      for (const secret of ["private task prompt sentinel", "private contract sentinel", "private knowledge sentinel", "credential-sentinel", "hidden runtime prompt sentinel"]) {
        expect(taskResponse.body).not.toContain(secret);
      }
      expect(taskResponse.body).not.toContain("wrong-task-manifest");
      expect(taskResponse.body).not.toContain("other-run-manifest");

      const emptyResponse = await app.inject({ method: "GET", url: "/api/v1/runs/other-context-run/context-manifests", headers: { cookie: TEST_COOKIE } });
      expect(emptyResponse.statusCode).toBe(200);
      expect(JSON.parse(emptyResponse.body)).toMatchObject({ availability: "available", subject: { type: "TASK", id: "context-task" }, items: [] });

      const epicResponse = await app.inject({ method: "GET", url: "/api/v1/runs/epic-run/context-manifests", headers: { cookie: TEST_COOKIE } });
      expect(epicResponse.statusCode).toBe(200);
      expect(JSON.parse(epicResponse.body)).toMatchObject({ availability: "available", id: "epic-manifest", subject: { type: "EPIC", id: "context-epic" }, role: "architect", items: [], promptHash: "6".repeat(64), contextHash: "7".repeat(64) });

      const requestResponse = await app.inject({ method: "GET", url: "/api/v1/runs/request-run/context-manifests", headers: { cookie: TEST_COOKIE } });
      expect(requestResponse.statusCode).toBe(200);
      expect(JSON.parse(requestResponse.body)).toMatchObject({ availability: "available", id: "request-manifest", subject: { type: "REQUEST", id: "context-request" }, role: "coordinator", items: [], promptHash: "8".repeat(64), contextHash: "9".repeat(64) });
      expect(requestResponse.body).not.toContain("private request sentinel");

      const legacyResponse = await app.inject({ method: "GET", url: "/api/v1/runs/legacy-run/context-manifests", headers: { cookie: TEST_COOKIE } });
      expect(legacyResponse.statusCode).toBe(200);
      expect(JSON.parse(legacyResponse.body)).toEqual({ availability: "unavailable", runId: "legacy-run", subject: { type: "TASK", id: "third-context-task" }, role: "qa", reason: "LEGACY_PROVENANCE_UNAVAILABLE" });

      db.exec("PRAGMA ignore_check_constraints = ON");
      db.run("UPDATE context_manifests SET items_json='not-json' WHERE id='manifest-1'");
      db.exec("PRAGMA ignore_check_constraints = OFF");
      const corruptedManifestResponse = await app.inject({
        method: "GET",
        url: "/api/v1/runs/context-run/context-manifests",
        headers: { cookie: TEST_COOKIE },
      });
      expect(corruptedManifestResponse.statusCode).toBe(200);
      expect(JSON.parse(corruptedManifestResponse.body)).toEqual({ availability: "unavailable", runId: "context-run", subject: { type: "TASK", id: "context-task" }, role: "developer", reason: "INVALID_PERSISTED_PROVENANCE" });
      db.run("UPDATE context_manifests SET items_json='[1]' WHERE id='manifest-1'");
      const invalidIdsResponse = await app.inject({
        method: "GET",
        url: "/api/v1/runs/context-run/context-manifests",
        headers: { cookie: TEST_COOKIE },
      });
      expect(invalidIdsResponse.statusCode).toBe(200);
      expect(JSON.parse(invalidIdsResponse.body)).toEqual({ availability: "unavailable", runId: "context-run", subject: { type: "TASK", id: "context-task" }, role: "developer", reason: "INVALID_PERSISTED_PROVENANCE" });

      const missingRun = await app.inject({
        method: "GET",
        url: "/api/v1/runs/missing-run/context-manifests",
        headers: { cookie: TEST_COOKIE },
      });
      expect(missingRun.statusCode).toBe(404);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("closes the application while an SSE client is connected", async () => {
    const { app, db } = makeAppWithDatabase();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose an address");

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, {
      headers: { cookie: TEST_COOKIE },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);

    const closePromise = app.close();
    try {
      const result = await Promise.race([
        closePromise.then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]);
      expect(result).toBe("closed");
    } finally {
      controller.abort();
      await closePromise;
      db.close();
    }
  });

  it("creates projects, epics, and tasks through strict command routes", async () => {
    const { app, db } = makeAppWithDatabase();
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: mutationHeaders(app),
      payload: { name: "health-service", displayName: "Health Service" },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = JSON.parse(projectResponse.body).project;

    const epicResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/epics`,
      headers: mutationHeaders(app),
      payload: validContract,
    });
    expect(epicResponse.statusCode).toBe(201);
    const epic = JSON.parse(epicResponse.body).epic;

    const standaloneResponse = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      headers: mutationHeaders(app),
      payload: validContract,
    });
    expect(standaloneResponse.statusCode).toBe(201);
    expect(JSON.parse(standaloneResponse.body).task.projectId).toBe(project.id);

    const childResponse = await app.inject({
      method: "POST",
      url: `/api/v1/epics/${epic.id}/tasks`,
      headers: mutationHeaders(app),
      payload: validContract,
    });
    expect(childResponse.statusCode).toBe(201);
    expect(JSON.parse(childResponse.body).task.epicId).toBe(epic.id);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(2);
    await app.close();
    db.close();
  });

  it("rejects extra command fields and missing parents", async () => {
    const { app, db } = makeAppWithDatabase();
    const invalidProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: mutationHeaders(app),
      payload: { name: "x", displayName: "X", repositoryPath: "C:/secret" },
    });
    expect(invalidProject.statusCode).toBe(400);

    const missingProject = await app.inject({
      method: "POST",
      url: "/api/v1/projects/missing/tasks",
      headers: mutationHeaders(app),
      payload: validContract,
    });
    expect(missingProject.statusCode).toBe(404);

    const invalidContract = await app.inject({
      method: "POST",
      url: "/api/v1/projects/missing/epics",
      headers: mutationHeaders(app),
      payload: { ...validContract, prompt: "unexpected" },
    });
    expect(invalidContract.statusCode).toBe(400);
    await app.close();
    db.close();
  });

  it("returns 503 when command services are not composed", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const scheduler = new SchedulerService(db);
    const app = createApp({ scheduler, authService: createTestAuthService() });
    const headers = mutationHeaders(app);

    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { name: "x", displayName: "X" } });
    expect(project.statusCode).toBe(503);
    const task = await app.inject({ method: "POST", url: "/api/v1/projects/p/tasks", headers, payload: validContract });
    expect(task.statusCode).toBe(503);

    await app.close();
    db.close();
  });

  it("fails closed when onboarding activation has no persisted semantic approval authority", async () => {
    const { app, db } = makeAppWithDatabase();
    const now = "2026-09-20T00:00:00.000Z";
    db.run(
      "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $displayName, 'ACTIVE', $now, $now)",
      { id: "project-1", name: "project", displayName: "Project", now },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/project-1/activate",
      headers: {
        cookie: TEST_COOKIE,
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": TEST_CSRF_TOKEN,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ contractVersion: 1, error: { code: "ONBOARDING_NOT_APPROVED" } });
    expect(db.get<{ status: string }>("SELECT status FROM projects WHERE id = $id", { id: "project-1" })?.status).toBe("ACTIVE");
    await app.close();
    db.close();
  });

  it("persists semantic onboarding approval and activates only after backend approval", async () => {
    const { app, db, authService } = makeAppWithDatabase();
    const headers = mutationHeaders(app);
    const discovered = await app.inject({ method: "POST", url: "/api/v1/onboarding/discover", headers, payload: { repositoryPath: process.cwd() } });
    expect(discovered.statusCode).toBe(201);
    const projectId = JSON.parse(discovered.body).projectId as string;
    const invalid = await app.inject({ method: "POST", url: `/api/v1/onboarding/${projectId}/approval`, headers, payload: { repositoryPath: "relative/path" } });
    expect(invalid.statusCode).toBe(400);

    const proposal = await app.inject({ method: "POST", url: `/api/v1/onboarding/${projectId}/approval`, headers, payload: { proposed: { defaultBranch: "main", workflow: "standard", roles: ["Developer"], guidelines: [] } } });
    expect(proposal.statusCode).toBe(201);
    const approvalId = JSON.parse(proposal.body).approval?.id ?? JSON.parse(proposal.body).approvalId;
    expect(db.get<{ metadata_json: string }>("SELECT metadata_json FROM approval_metadata WHERE approval_id=$id", { id: approvalId })?.metadata_json).toContain("semantic-config");

    const beforeApproval = await app.inject({ method: "POST", url: `/api/v1/onboarding/${projectId}/activate`, headers, payload: {} });
    expect(beforeApproval.statusCode).toBe(409);
    const approved = await app.inject({ method: "POST", url: `/api/v1/onboarding/${projectId}/approve`, headers, payload: {} });
    expect(approved.statusCode).toBe(200);
    const activated = await app.inject({ method: "POST", url: `/api/v1/onboarding/${projectId}/activate`, headers, payload: {} });
    expect(activated.statusCode).toBe(200);
    expect(JSON.parse(activated.body)).toMatchObject({ projectId, status: "ACTIVE" });
    authService.resetAuthOperationCounts();
    const view = await app.inject({ method: "GET", url: `/api/v1/onboarding/${projectId}`, headers: { cookie: TEST_COOKIE } });
    expect(view.statusCode).toBe(200);
    expect(JSON.parse(view.body).status).toBe("ACTIVE");
    await app.close();
    db.close();
  });

  it("exposes a safe Agent Run detail projection without prompt or capability data", async () => {
    const { app, db } = makeAppWithDatabase();
    db.run(
      `INSERT INTO agent_runs (id, role, runtime, model, status, task_id, trigger_reason, started_at, input_tokens, cached_input_tokens, output_tokens, cost, prompt, capability_ref)
       VALUES ($id, $role, $runtime, $model, $status, $task_id, $trigger_reason, $started_at, $input_tokens, $cached_input_tokens, $output_tokens, $cost, $prompt, $capability_ref)`,
      {
        id: "run-1", role: "Developer", runtime: "hermes", model: "model", status: "IN_PROGRESS", task_id: "task-1",
        trigger_reason: "DEVELOPMENT", started_at: "2026-09-20T00:00:00.000Z", input_tokens: 10, cached_input_tokens: 2,
        output_tokens: 3, cost: 0.42, prompt: "sensitive prompt", capability_ref: "sensitive-capability",
      },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1",
      headers: { cookie: TEST_COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      id: "run-1", role: "Developer", runtime: "hermes", model: "model", status: "IN_PROGRESS", taskId: "task-1", epicId: null,
      triggerReason: "DEVELOPMENT", startedAt: "2026-09-20T00:00:00.000Z", endedAt: null,
      usage: { inputTokens: 10, cachedTokens: 2, outputTokens: 3, cost: 0.42 },
    });
    await app.close();
    db.close();
  });

  it.each([
    "/api/v1/dashboard",
    "/api/v1/projects/project-1",
    "/api/v1/epics/epic-1",
    "/api/v1/tasks/task-1",
    "/api/v1/execution",
    "/api/v1/approvals",
  ])("exposes %s as an authenticated read endpoint", async (url) => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url,
      headers: { cookie: TEST_COOKIE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("accepts an authenticated request-changes decision and returns its persisted status", async () => {
    const { app, db } = makeAppWithDatabase();
    const service = new ApprovalService(db);
    const approval = service.request({ type: "WORKFLOW_CHANGE", subjectId: "project-changes", subjectType: "PROJECT", requestedBy: "local-user" });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approval.id}/request-changes`,
      headers: mutationHeaders(app),
      payload: { note: "Please revise the proposal" },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "CHANGES_REQUESTED" });
    expect(db.get<{ status: string; resolution_note: string }>("SELECT status,resolution_note FROM approvals WHERE id=$id", { id: approval.id })).toEqual({ status: "CHANGES_REQUESTED", resolution_note: "Please revise the proposal" });
    await app.close();
    db.close();
  });

  it.each([
    ["/api/v1/approvals/approval-1/approve", "POST"],
    ["/api/v1/tasks/task-1/pause", "POST"],
    ["/api/v1/runs/run-1/cancel", "POST"],
  ] as const)("rejects unauthenticated mutation %s", async (url, method) => {
    const app = makeApp();
    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an authenticated mutation from an untrusted origin", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/approve",
      headers: {
        cookie: TEST_COOKIE,
        origin: "https://evil.example",
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an authenticated mutation without an Origin header", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/approve",
      headers: { cookie: TEST_COOKIE },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects malformed approval bodies before calling the service", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/approve",
      headers: {
        cookie: TEST_COOKIE,
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": TEST_CSRF_TOKEN,
      },
      payload: { note: "x", unexpected: true },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
