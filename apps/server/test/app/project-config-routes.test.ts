import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { createApp } from "../../src/app/create-app.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, testAuthHeaders } from "../helpers/auth.js";
import { ProjectConfigError, ProjectConfigService } from "../../src/modules/projects/project-config-service.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { projectConfigRoutes } from "../../src/app/routes/project-config.js";

// These integration paths capture repository files and are skipped where production correctly fails closed.
const supportedCaptureRouteSuite = process.platform === "win32" ? describe.skip : describe;
supportedCaptureRouteSuite("Project Config routes", () => {
  it("requires the displayed manifest hash and rejects stale candidate approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "ebb-project-config-route-"));
    const configDir = join(root, ".ebb-orchestrator");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "project.yaml"), "schema_version: 1\nproject:\n  name: sample\n  default_branch: main\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "."], { cwd: root, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root, windowsHide: true });
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const service = new ProjectConfigService(db, new ApprovalService(db));
    const app = createApp({ db, scheduler: new SchedulerService(db), runtime: {} as never, projectConfigService: service, authService: createTestAuthService() });
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'sample','sample','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,created_at,updated_at) VALUES($id,$path,'{}','null','PROPOSED',$now,$now)", { id: projectId, path: root, now });
    try {
      const denied = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/config/candidates`, headers: { origin: "http://127.0.0.1:3000" }, payload: {} });
      expect(denied.statusCode).toBe(401);
      const candidateResponse = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/config/candidates`, headers: testAuthHeaders(), payload: {} });
      expect(candidateResponse.statusCode).toBe(201);
      const candidate = candidateResponse.json().candidate;
      const wrongHash = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/config/candidates/${candidate.candidateId}/approve`, headers: testAuthHeaders(), payload: { manifestHash: "0".repeat(64) } });
      expect(wrongHash.statusCode).toBe(409);
      const current = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/config`, headers: { cookie: testAuthHeaders().cookie } });
      expect(current.json().current.manifestHash).toBe(candidate.manifestHash);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_revisions")?.count).toBe(0);
      const firstRevision = service.approve(projectId, candidate.candidateId, candidate.manifestHash);
      writeFileSync(join(configDir, "project.yaml"), "schema_version: 1\nproject:\n  name: sample\n  default_branch: develop\n");
      const secondCandidate = service.capture(projectId);
      const secondRevision = service.approve(projectId, secondCandidate.candidateId, secondCandidate.manifestHash);
      db.exec("DROP TRIGGER trg_project_config_revision_immutable");
      db.run("UPDATE project_config_revisions SET normalized_payload_json='{}' WHERE revision_id=$id", { id: secondRevision.revisionId });
      const degraded = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/config`, headers: { cookie: testAuthHeaders().cookie } });
      expect(degraded.statusCode).toBe(200);
      expect(degraded.json().degraded).toBe(true);
      expect(degraded.json().active).toBeNull();
      expect(degraded.json().revisions.map((revision: { revisionId: string }) => revision.revisionId)).toEqual([firstRevision.revisionId]);
      const rollback = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/config/revisions/${firstRevision.revisionId}/rollback`, headers: testAuthHeaders(), payload: {} });
      expect(rollback.statusCode).toBe(201);
      expect(rollback.json().candidate.manifestHash).toBe(firstRevision.manifestHash);
      expect(() => service.getActive(projectId)).toThrow(/degraded/i);
    } finally { await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("Project Config capture error response", () => {
  it("returns 503 when capture is unsupported on the current platform", async () => {
    const db = createSqliteDatabase(":memory:");
    const service = new ProjectConfigService(db, new ApprovalService(db));
    vi.spyOn(service, "capture").mockImplementation(() => {
      throw new ProjectConfigError("PROJECT_CONFIG_UNSUPPORTED_PLATFORM", "Project Config capture is disabled on Windows until safe file-handle verification is supported.");
    });
    const app = Fastify();
    await app.register(projectConfigRoutes, { service });
    try {
      const response = await app.inject({ method: "POST", url: `/api/v1/projects/${randomUUID()}/config/candidates`, payload: {} });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "PROJECT_CONFIG_UNSUPPORTED_PLATFORM" });
    } finally {
      await app.close();
      db.close();
    }
  });
});
