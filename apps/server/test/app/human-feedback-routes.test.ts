import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { createApp } from "../../src/app/create-app.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, testAuthHeaders } from "../helpers/auth.js";
import { HumanFeedbackService } from "../../src/modules/github/human-feedback-service.js";

describe("HumanFeedback routes", () => {
  it("protects mapping/inbox routes and confines triage to the owning Project", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const service = new HumanFeedbackService(db);
    const app = createApp({ db, scheduler: new SchedulerService(db), runtime: {} as never, humanFeedbackService: service, authService: createTestAuthService() });
    const projectId = insertProject(db);
    const otherProjectId = insertProject(db);
    try {
      expect((await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/human-feedback` })).statusCode).toBe(401);
      const mapping = await app.inject({ method: "PUT", url: `/api/v1/projects/${projectId}/github/mapping`, headers: testAuthHeaders(), payload: { repository: "Owner/Repo" } });
      expect(mapping.statusCode).toBe(200);
      expect(mapping.json().repository).toBe("owner/repo");
      const conflict = await app.inject({ method: "PUT", url: `/api/v1/projects/${otherProjectId}/github/mapping`, headers: testAuthHeaders(), payload: { repository: "OWNER/REPO" } });
      expect(conflict.statusCode).toBe(409);
      service.receiveComment({ repository: "owner/repo", commentId: 34, issueNumber: 12, body: "<script>bad()</script>", authorLogin: "alice", authorType: "User", sourceUrl: "https://github.com/owner/repo/issues/12#issuecomment-34", sourceCreatedAt: null, sourceUpdatedAt: null });
      const inbox = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/human-feedback`, headers: { cookie: testAuthHeaders().cookie } });
      const item = inbox.json().items[0];
      expect(item.body).toBe("<script>bad()</script>");
      expect(inbox.json().nextCursor).toBeNull();
      const badCursor = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/human-feedback?cursor=invalid`, headers: { cookie: testAuthHeaders().cookie } });
      expect(badCursor.statusCode).toBe(400);
      const crossProject = await app.inject({ method: "POST", url: `/api/v1/projects/${otherProjectId}/human-feedback/${item.id}/resolve`, headers: testAuthHeaders(), payload: {} });
      expect(crossProject.statusCode).toBe(404);
      const ignored = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/human-feedback/${item.id}/ignore`, headers: testAuthHeaders(), payload: {} });
      expect(ignored.statusCode).toBe(200);
      expect(ignored.json().item.status).toBe("IGNORED");
    } finally { await app.close(); db.close(); }
  });
});

function insertProject(db: ReturnType<typeof createSqliteDatabase>): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'sample','sample','ACTIVE',$now,$now)", { id, now });
  return id;
}
