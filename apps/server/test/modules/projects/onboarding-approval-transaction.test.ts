import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";
import { OnboardingService } from "../../../src/modules/projects/onboarding-service.js";
import type { RepositoryFacts } from "../../../src/modules/projects/repository-discovery.js";

const facts: RepositoryFacts = { root: process.cwd(), defaultBranch: "main", remotes: [], packageManager: "pnpm", languageHints: ["typescript"], testCommands: ["pnpm test"], untrustedExistingConfig: false };
const proposal = { defaultBranch: "main", workflow: "standard", roles: ["Developer"], guidelines: ["Review changes"] };

function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const service = new OnboardingService(db, new ApprovalService(db), { discover: async () => facts } as never);
  return { db, service };
}

describe("onboarding approval transaction atomicity", () => {
  it("rolls back the draft config, approval metadata, outbox and audit when config write fails", async () => {
    const { db, service } = setup();
    await service.discoverAndCreateDraft(process.cwd());
    db.exec("CREATE TRIGGER injected_onboarding_failure BEFORE UPDATE ON onboarding_configs BEGIN SELECT RAISE(ABORT, 'injected_onboarding_failure'); END");
    const draft = db.get<{ id: string }>("SELECT id FROM projects");
    expect(() => service.requestApproval(draft!.id, proposal)).toThrow("injected_onboarding_failure");
    expect(db.get("SELECT 1 FROM approvals WHERE subject_id=$id", { id: draft!.id })).toBeUndefined();
    expect(db.get("SELECT 1 FROM approval_metadata")).toBeUndefined();
    expect(db.get("SELECT 1 FROM onboarding_configs WHERE project_id=$id AND proposed_json <> 'null'", { id: draft!.id })).toBeUndefined();
    expect(db.get("SELECT 1 FROM outbox_events")).toBeUndefined();
    expect(db.get("SELECT 1 FROM audit_log")).toBeUndefined();
    db.close();
  });

  it("rolls back approval state and ApprovalApproved side effects when config update fails", async () => {
    const { db, service } = setup();
    const draft = await service.discoverAndCreateDraft(process.cwd());
    service.requestApproval(draft.projectId, proposal);
    db.exec("CREATE TRIGGER injected_onboarding_failure BEFORE UPDATE ON onboarding_configs BEGIN SELECT RAISE(ABORT, 'injected_onboarding_failure'); END");
    expect(() => service.approve(draft.projectId, "approved")).toThrow("injected_onboarding_failure");
    expect(db.get<{ status: string }>("SELECT status FROM approvals WHERE subject_id=$id", { id: draft.projectId })).toEqual({ status: "PENDING" });
    expect(db.get<{ status: string; proposed_json: string }>("SELECT status,proposed_json FROM onboarding_configs WHERE project_id=$id", { id: draft.projectId })?.status).toBe("PROPOSED");
    expect(db.get("SELECT 1 FROM outbox_events WHERE type='ApprovalApproved'")).toBeUndefined();
    expect(db.get("SELECT 1 FROM audit_log WHERE action='APPROVAL_APPROVED'")).toBeUndefined();
    db.close();
  });

  it("rolls back approval and side effects when conditional config update affects zero rows", async () => {
    const { db, service } = setup();
    const draft = await service.discoverAndCreateDraft(process.cwd());
    service.requestApproval(draft.projectId, proposal);
    db.exec("CREATE TRIGGER ignore_onboarding_approval_update BEFORE UPDATE ON onboarding_configs BEGIN SELECT RAISE(IGNORE); END");
    expect(() => service.approve(draft.projectId, "approved")).toThrow();
    expect(db.get<{ status: string }>("SELECT status FROM approvals WHERE subject_id=$id", { id: draft.projectId })?.status).toBe("PENDING");
    expect(db.get("SELECT 1 FROM outbox_events WHERE type='ApprovalApproved'")).toBeUndefined();
    expect(db.get("SELECT 1 FROM audit_log WHERE action='APPROVAL_APPROVED'")).toBeUndefined();
    db.close();
  });

  it("preserves exact metadata, outbox payload and approval audit on success", async () => {
    const { db, service } = setup();
    const draft = await service.discoverAndCreateDraft(process.cwd());
    service.requestApproval(draft.projectId, proposal);
    const requested = db.get<{ payload_json: string }>("SELECT payload_json FROM outbox_events WHERE type='ApprovalRequested'");
    const approval = db.get<{ id: string; metadata_json: string }>("SELECT a.id,m.metadata_json FROM approvals a JOIN approval_metadata m ON m.approval_id=a.id WHERE a.subject_id=$id", { id: draft.projectId });
    expect(JSON.parse(approval!.metadata_json)).toMatchObject({ kind: "semantic-config", repositoryPath: facts.root, proposed: proposal });
    expect(JSON.parse(requested!.payload_json)).toMatchObject({ approvalId: approval!.id, subjectId: draft.projectId, approvalType: "WORKFLOW_CHANGE" });
    service.approve(draft.projectId, "approved");
    expect(db.get<{ type: string }>("SELECT type FROM outbox_events WHERE type='ApprovalApproved'")).toEqual({ type: "ApprovalApproved" });
    expect(db.get<{ action: string; details_json: string }>("SELECT action,details_json FROM audit_log WHERE action='APPROVAL_APPROVED'")?.details_json).toContain('"resolutionNote":"approved"');
    db.close();
  });
});
