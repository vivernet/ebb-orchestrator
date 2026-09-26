import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { OnboardingService } from "../../../src/modules/projects/onboarding-service.js";
import { listActiveApprovedOnboardingRepositories } from "../../../src/modules/projects/onboarding-service.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";
import type { RepositoryFacts } from "../../../src/modules/projects/repository-discovery.js";

const facts: RepositoryFacts = { root: process.cwd(), defaultBranch: "main", remotes: [], packageManager: "pnpm", languageHints: ["typescript"], testCommands: ["pnpm test"], untrustedExistingConfig: false };

describe("OnboardingService", () => {
  it("lists only active onboarding bound to its own approved workflow change", () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const mismatchedProjectId = randomUUID();
    for (const [id, name] of [[projectId, "matched"], [otherProjectId, "approval-owner"], [mismatchedProjectId, "mismatch"]] as const) db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,$name,$name,'ACTIVE',$now,$now)", { id, name, now });
    const matchingApproval = randomUUID();
    const mismatchedApproval = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: matchingApproval, projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$otherProjectId,'PROJECT','APPROVED','test',$now)", { id: mismatchedApproval, otherProjectId, now });
    for (const [id, name, approvalId] of [[projectId, "matched", matchingApproval], [mismatchedProjectId, "mismatch", mismatchedApproval]] as const) db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,$path,'{}','{}','ACTIVE',$approvalId,$now,$now)", { id, path: name, approvalId, now });

    const rows = listActiveApprovedOnboardingRepositories(db);
    expect(rows.map((row) => row.repository_path)).toEqual(["matched"]);
    db.close();
  });

  it("creates a reloadable DRAFT pair atomically and uses a new project on repeat", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const discovery = { discover: async () => facts } as never;
    const service = new OnboardingService(db, new ApprovalService(db), discovery);
    const first = await service.discoverAndCreateDraft(process.cwd());
    const second = await service.discoverAndCreateDraft(process.cwd());
    expect(first.status).toBe("DRAFT");
    expect(first.proposed).toBeNull();
    expect(first.projectId).not.toBe(second.projectId);
    expect(service.getProjection(first.projectId)).toEqual(first);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM projects")?.count).toBe(2);
    db.close();
  });

  it("never persists credentials from discovered remotes in facts or approval metadata", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const secret = "sensitive-token-not-for-storage";
    const discovered = { ...facts, remotes: [{ name: "origin", url: `https://user:${secret}@example.invalid/repo.git?access_token=${secret}#${secret}` }] };
    const service = new OnboardingService(db, new ApprovalService(db), { discover: async () => discovered } as never);
    const draft = await service.discoverAndCreateDraft(process.cwd());
    const stored = db.get<{ facts_json: string }>("SELECT facts_json FROM onboarding_configs WHERE project_id=$id", { id: draft.projectId })!;
    expect(stored.facts_json).not.toContain(secret);
    expect(stored.facts_json).not.toContain("user:");
    expect(draft.detected.remotes[0]?.url).toBe("https://example.invalid/repo.git");
    service.requestApproval(draft.projectId, { defaultBranch: "main", workflow: "standard", roles: ["Developer"], guidelines: [] });
    const metadata = db.get<{ metadata_json: string }>("SELECT metadata_json FROM approval_metadata")!;
    expect(metadata.metadata_json).not.toContain(secret);
    expect(metadata.metadata_json).not.toContain("user:");
    db.close();
  });

  it("restores a draft after rejection and preserves approval history on a new request", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const approvals = new ApprovalService(db);
    const service = new OnboardingService(db, approvals, { discover: async () => facts } as never);
    const draft = await service.discoverAndCreateDraft(process.cwd());
    const proposal = { defaultBranch: "main", workflow: "standard", roles: ["Developer"], guidelines: [] };
    const pending = service.requestApproval(draft.projectId, proposal);
    approvals.reject(pending.approval!.id, "local-user");
    expect(service.getProjection(draft.projectId)).toMatchObject({ status: "DRAFT", proposed: proposal, approval: null });
    expect(() => service.activate(draft.projectId)).toThrow();
    const next = service.requestApproval(draft.projectId, proposal);
    expect(next.status).toBe("APPROVAL_PENDING");
    expect(next.approval!.id).not.toBe(pending.approval!.id);
    expect(db.all<{ status: string }>("SELECT status FROM approvals WHERE subject_id=$id", { id: draft.projectId }).map((row) => row.status).sort()).toEqual(["REJECTED", "PENDING"].sort());
    db.close();
  });

  it("restores a draft after requested changes and preserves decision history", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const approvals = new ApprovalService(db);
    const service = new OnboardingService(db, approvals, { discover: async () => facts } as never);
    const draft = await service.discoverAndCreateDraft(process.cwd());
    const proposal = { defaultBranch: "main", workflow: "standard", roles: ["Developer"], guidelines: [] };
    const pending = service.requestApproval(draft.projectId, proposal);
    const decision = approvals.requestChanges(pending.approval!.id, "local-user", "Нужно уточнить настройки");

    expect(decision.status).toBe("CHANGES_REQUESTED");
    expect(service.getProjection(draft.projectId)).toMatchObject({ status: "DRAFT", proposed: proposal, approval: null });
    expect(() => service.activate(draft.projectId)).toThrow();
    const next = service.requestApproval(draft.projectId, proposal);
    expect(next.status).toBe("APPROVAL_PENDING");
    expect(next.approval!.id).not.toBe(pending.approval!.id);
    expect(db.all<{ status: string }>("SELECT status FROM approvals WHERE subject_id=$id", { id: draft.projectId }).map((row) => row.status).sort()).toEqual(["CHANGES_REQUESTED", "PENDING"].sort());
    expect(db.all<{ type: string }>("SELECT type FROM outbox_events WHERE aggregate_id=$id", { id: draft.projectId }).map((row) => row.type)).toContain("ApprovalChangesRequested");
    db.close();
  });

  it("keeps approval and activation in the persisted lifecycle", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const service = new OnboardingService(db, new ApprovalService(db), { discover: async () => facts } as never);
    const draft = await service.discoverAndCreateDraft(process.cwd());
    const pending = service.requestApproval(draft.projectId, { defaultBranch: "main", workflow: "standard", roles: ["Developer"], guidelines: [] });
    expect(pending.status).toBe("APPROVAL_PENDING");
    expect(service.approve(draft.projectId, "approved").status).toBe("APPROVED");
    expect(service.activate(draft.projectId).status).toBe("ACTIVE");
    expect(service.activate(draft.projectId).status).toBe("ACTIVE");
    db.close();
  });

  it("does not project inconsistent persisted onboarding states as a valid DRAFT", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const service = new OnboardingService(db, new ApprovalService(db), { discover: async () => facts } as never);
    const draftWithoutProposal = await service.discoverAndCreateDraft(process.cwd());
    db.run("UPDATE onboarding_configs SET proposed_json='{}' WHERE project_id=$id", { id: draftWithoutProposal.projectId });
    expect(() => service.getProjection(draftWithoutProposal.projectId)).toThrow("Persisted onboarding state is inconsistent");

    const activeWithoutApproval = await service.discoverAndCreateDraft(process.cwd());
    db.run("UPDATE onboarding_configs SET status='ACTIVE' WHERE project_id=$id", { id: activeWithoutApproval.projectId });
    expect(() => service.getProjection(activeWithoutApproval.projectId)).toThrow("Persisted onboarding state is inconsistent");
    db.close();
  });
});
