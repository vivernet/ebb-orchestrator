import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";

describe("ApprovalService transaction port", () => {
  it("writes request approval on the caller transaction and preserves metadata/outbox", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const service = new ApprovalService(db);
    const approval = db.transaction((tx) => service.requestInTransaction(tx, {
      type: "WORKFLOW_CHANGE", subjectId: "project-1", subjectType: "PROJECT", requestedBy: "local-user", metadata: { kind: "semantic-config" },
    }));
    expect(approval.status).toBe("PENDING");
    expect(db.get("SELECT metadata_json FROM approval_metadata WHERE approval_id=$id", { id: approval.id })).toBeTruthy();
    expect(db.get<{ type: string }>("SELECT type FROM outbox_events WHERE aggregate_id='project-1'")).toEqual({ type: "ApprovalRequested" });
    db.close();
  });

  it("approves only the exact pending subject/type on the caller transaction", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const service = new ApprovalService(db);
    const requested = service.request({ type: "WORKFLOW_CHANGE", subjectId: "project-1", subjectType: "PROJECT", requestedBy: "local-user" });
    const approved = db.transaction((tx) => service.approveInTransaction(tx, { approvalId: requested.id, subjectId: "project-1", subjectType: "PROJECT", type: "WORKFLOW_CHANGE", actor: "local-user", note: "ok" }));
    expect(approved.status).toBe("APPROVED");
    expect(db.get<{ type: string }>("SELECT type FROM outbox_events WHERE aggregate_id='project-1' AND type='ApprovalApproved'")).toEqual({ type: "ApprovalApproved" });
    db.close();
  });

  it("persists a changes-requested decision and its outbox/audit records", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const service = new ApprovalService(db);
    const requested = service.request({ type: "WORKFLOW_CHANGE", subjectId: "project-1", subjectType: "PROJECT", requestedBy: "local-user" });
    const changed = service.requestChanges(requested.id, "reviewer", "Please revise the proposal");

    expect(changed.status).toBe("CHANGES_REQUESTED");
    expect(db.get<{ status: string }>("SELECT status FROM approvals WHERE id=$id", { id: requested.id })).toEqual({ status: "CHANGES_REQUESTED" });
    expect(db.get<{ type: string }>("SELECT type FROM outbox_events WHERE aggregate_id='project-1' AND type='ApprovalChangesRequested'")).toEqual({ type: "ApprovalChangesRequested" });
    expect(db.get<{ action: string; actor: string }>("SELECT action,actor FROM audit_log WHERE aggregate_id=$id", { id: requested.id })).toEqual({ action: "APPROVAL_CHANGES_REQUESTED", actor: "reviewer" });
    db.close();
  });
});
