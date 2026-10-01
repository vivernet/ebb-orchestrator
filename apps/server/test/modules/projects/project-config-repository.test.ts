import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { ProjectConfigRepository } from "../../../src/modules/projects/project-config-repository.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const databases: ReturnType<typeof createSqliteDatabase>[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("ProjectConfigRepository", () => {
  it("returns only the current identical candidate and atomically stales it when replacing its snapshot", () => {
    const { repository, projectId, database } = createFixture();
    const first = repository.capture(candidate(projectId, "a"));
    expect(repository.capture(candidate(projectId, "a")).candidate_id).toBe(first.candidate_id);

    const second = repository.capture(candidate(projectId, "b"));
    expect(second.candidate_id).not.toBe(first.candidate_id);
    expect(database.get<{ status: string }>("SELECT status FROM project_config_candidates WHERE candidate_id=$id", { id: first.candidate_id })?.status).toBe("STALE");
    expect(database.get<{ current_candidate_id: string; active_revision_id: string | null }>("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=$projectId", { projectId }))
      .toEqual({ current_candidate_id: second.candidate_id, active_revision_id: null });
  });

  it("never follows candidate or active revision pointers into another project", () => {
    const { repository, projectId, database } = createFixture();
    const otherProjectId = randomUUID();
    const now = new Date().toISOString();
    database.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'other','other','ACTIVE',$now,$now)", { id: otherProjectId, now });
    const ownCandidate = repository.capture(candidate(projectId, "own"));
    const foreignCandidate = repository.capture(candidate(otherProjectId, "foreign"));
    const foreignRevision = repository.approveCandidate(otherProjectId, foreignCandidate.candidate_id, foreignCandidate.manifest_hash, (tx) => {
      const approvalId = randomUUID();
      const createdAt = new Date().toISOString();
      tx.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','local-user',$createdAt)", { id: approvalId, projectId: otherProjectId, createdAt });
      return { revisionId: randomUUID(), revisionHash: "f".repeat(64), approvalId, createdAt };
    });
    expect(foreignRevision).toBeDefined();

    database.run("UPDATE project_config_state SET current_candidate_id=$candidateId,active_revision_id=$revisionId WHERE project_id=$projectId", {
      projectId, candidateId: foreignCandidate.candidate_id, revisionId: foreignRevision!.revision_id,
    });

    expect(ownCandidate.project_id).toBe(projectId);
    expect(repository.getCurrentCandidate(projectId)).toBeUndefined();
    expect(repository.getActiveRevision(projectId).state?.active_revision_id).toBe(foreignRevision!.revision_id);
    expect(repository.getActiveRevision(projectId).revision).toBeUndefined();
  });

  it("does not mark a newly approved revision degraded from a stale integrity check", () => {
    const { repository, projectId, database } = createFixture();
    const firstCandidate = repository.capture(candidate(projectId, "first"));
    const firstRevision = repository.approveCandidate(projectId, firstCandidate.candidate_id, firstCandidate.manifest_hash, (tx) => createApproval(tx, projectId));
    const nextCandidate = repository.capture(candidate(projectId, "next"));
    const nextRevision = repository.approveCandidate(projectId, nextCandidate.candidate_id, nextCandidate.manifest_hash, (tx) => createApproval(tx, projectId));

    repository.markDegraded(projectId, firstRevision!.revision_id);

    expect(database.get<{ active_revision_id: string; config_status: string }>("SELECT active_revision_id,config_status FROM project_config_state WHERE project_id=$projectId", { projectId }))
      .toEqual({ active_revision_id: nextRevision!.revision_id, config_status: "READY" });
  });

  it("rolls back approval and revision writes if the active-pointer compare-and-set fails", () => {
    const { repository, projectId, database } = createFixture();
    const pending = repository.capture(candidate(projectId, "c"));
    database.exec(`CREATE TRIGGER fail_project_config_activation BEFORE UPDATE OF active_revision_id ON project_config_state
      WHEN NEW.active_revision_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'forced activation failure'); END`);

    expect(() => repository.approveCandidate(projectId, pending.candidate_id, pending.manifest_hash, (tx) => {
      const approvalId = randomUUID();
      const now = new Date().toISOString();
      tx.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','local-user',$now)", { id: approvalId, projectId, now });
      return { revisionId: randomUUID(), revisionHash: "f".repeat(64), approvalId, createdAt: now };
    })).toThrow(/forced activation failure/i);

    expect(database.get<{ status: string }>("SELECT status FROM project_config_candidates WHERE candidate_id=$id", { id: pending.candidate_id })?.status).toBe("PENDING_REVIEW");
    expect(database.get<{ current_candidate_id: string; active_revision_id: string | null }>("SELECT current_candidate_id,active_revision_id FROM project_config_state WHERE project_id=$projectId", { projectId }))
      .toEqual({ current_candidate_id: pending.candidate_id, active_revision_id: null });
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_revisions WHERE project_id=$projectId", { projectId })?.count).toBe(0);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM approvals WHERE subject_id=$projectId", { projectId })?.count).toBe(0);
  });
});

function candidate(projectId: string, marker: string) {
  const manifest = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: marker }] });
  return {
    projectId,
    sourceHead: "head",
    manifestJson: manifest,
    manifestHash: marker,
    sourceFilesJson: JSON.stringify({}),
    normalizedPayloadJson: JSON.stringify({ marker }),
    schemaVersion: 1,
  };
}

function createApproval(tx: Parameters<Parameters<ProjectConfigRepository["approveCandidate"]>[3]>[0], projectId: string) {
  const approvalId = randomUUID();
  const createdAt = new Date().toISOString();
  tx.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','local-user',$createdAt)", { id: approvalId, projectId, createdAt });
  return { revisionId: randomUUID(), revisionHash: "e".repeat(64), approvalId, createdAt };
}

function createFixture() {
  const database = createSqliteDatabase(":memory:");
  databases.push(database);
  runMigrations(database, loadTestMigrations());
  const projectId = randomUUID();
  const now = new Date().toISOString();
  database.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'repo-test','repo-test','ACTIVE',$now,$now)", { id: projectId, now });
  return { database, projectId, repository: new ProjectConfigRepository(database) };
}
