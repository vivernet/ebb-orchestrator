import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { HumanFeedbackService } from "../../../src/modules/github/human-feedback-service.js";
import { GitHubSyncWorker, SqliteFeedbackDeliveryState } from "../../../src/modules/github/github-sync-worker.js";
import { GitHubSyncService } from "../../../src/modules/github/github-sync-service.js";
import type { GitHosting } from "../../../src/modules/github/git-hosting.js";

const databases: ReturnType<typeof createSqliteDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("HumanFeedbackService", () => {
  it("atomically maps and persists Issue comments with delivery receipt and deduplicates repeat delivery", () => {
    const { db, projectId, service } = fixture();
    service.setMapping(projectId, "Owner/Repo");
    expect(service.receiveComment(comment())).toBe("DELIVERED");
    expect(service.receiveComment(comment())).toBe("DELIVERED");
    expect(service.list(projectId)).toMatchObject([{ status: "UNTRIAGED", sourceRepository: "owner/repo", sourceIssueNumber: 12, sourceCommentId: 34, authorLogin: "alice", body: "Please review" }]);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM human_feedback")?.count).toBe(1);
    expect(db.get<{ status: string }>("SELECT status FROM github_feedback_deliveries WHERE repository='owner/repo' AND comment_id=34")?.status).toBe("DELIVERED");
  });

  it("does not write a receipt or route comments when repository mapping is absent", () => {
    const { db, service } = fixture();
    expect(service.receiveComment(comment())).toBe("UNMAPPED");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM human_feedback")?.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_feedback_deliveries")?.count).toBe(0);
  });

  it("uses one durable callback for scheduled/manual polling and leaves unmapped comments receipt-free", async () => {
    const { db, projectId, service } = fixture();
    const comments = [{ id: 34, issueNumber: 12, body: "Please review", authorType: "User", authorLogin: "alice", sourceUrl: "https://github.com/owner/repo/issues/12#issuecomment-34", sourceCreatedAt: "2026-09-29T10:00:00Z", sourceUpdatedAt: "2026-09-29T10:00:00Z" }];
    const hosting = { listIssueComments: async () => ({ status: "OK" as const, value: comments }) } as unknown as GitHosting;
    const worker = new GitHubSyncWorker(hosting, new GitHubSyncService(hosting, { get: () => undefined, set: () => undefined }), new SqliteFeedbackDeliveryState(db), {
      persistFeedback: (value) => Promise.resolve(service.receiveComment(value)),
    });
    expect(await worker.syncIssues("owner/repo")).toBe("SYNC_PENDING");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_feedback_deliveries")?.count).toBe(0);
    service.setMapping(projectId, "owner/repo");
    expect(await worker.syncIssues("owner/repo")).toBe("SYNCED");
    expect(await worker.syncIssues("owner/repo")).toBe("SYNCED");
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM human_feedback")?.count).toBe(1);
  });

  it("rejects mapping collisions and cross-project links, and retains a source tombstone on deletion", () => {
    const { db, projectId, service } = fixture();
    const otherProjectId = insertProject(db);
    service.setMapping(projectId, "owner/repo");
    expect(() => service.setMapping(otherProjectId, "OWNER/REPO")).toThrow(/связан/i);
    service.receiveComment(comment());
    const item = service.list(projectId)[0]!;
    expect(() => service.link(projectId, item.id, "TASK", randomUUID())).toThrow(/не найден/i);
    service.delete(projectId, item.id);
    expect(service.list(projectId, "DELETED")).toMatchObject([{ id: item.id, status: "DELETED", body: "", sourceCommentId: 34 }]);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM human_feedback WHERE source_key='github.com:owner/repo:issue-comment:34'")?.count).toBe(1);
  });

  it("pages more than 100 inbox items without duplicates and rejects malformed cursors", () => {
    const { projectId, service } = fixture();
    service.setMapping(projectId, "owner/repo");
    for (let commentId = 1; commentId <= 101; commentId += 1) {
      service.receiveComment({ ...comment(), commentId, sourceUrl: `https://github.com/owner/repo/issues/12#issuecomment-${commentId}` });
    }
    const first = service.listPage(projectId);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = service.listPage(projectId, "UNTRIAGED", first.nextCursor!);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(101);
    expect(() => service.listPage(projectId, "UNTRIAGED", "not-a-valid-cursor")).toThrow(/cursor/i);
  });
});

function comment() { return { repository: "Owner/Repo", commentId: 34, issueNumber: 12, body: "Please review", authorLogin: "alice", authorType: "User", sourceUrl: "https://github.com/Owner/Repo/issues/12#issuecomment-34", sourceCreatedAt: "2026-09-29T10:00:00Z", sourceUpdatedAt: "2026-09-29T10:00:00Z" }; }
function fixture() {
  const db = createSqliteDatabase(":memory:");
  databases.push(db);
  runMigrations(db, loadTestMigrations());
  const projectId = insertProject(db);
  return { db, projectId, service: new HumanFeedbackService(db) };
}
function insertProject(db: ReturnType<typeof createSqliteDatabase>): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'sample','sample','ACTIVE',$now,$now)", { id, now });
  return id;
}
