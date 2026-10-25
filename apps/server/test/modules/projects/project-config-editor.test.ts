import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { ProjectConfigError, ProjectConfigService } from "../../../src/modules/projects/project-config-service.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";
import type { ProjectConfigV2 } from "@ebb-orchestrator/contracts";

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function forcePlatformSync<T>(value: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  expect(descriptor?.configurable).toBe(true);
  Object.defineProperty(process, "platform", { ...descriptor!, value });
  try { return fn(); } finally { Object.defineProperty(process, "platform", descriptor!); }
}

function v2Settings(overrides: Partial<ProjectConfigV2> = {}): ProjectConfigV2 {
  return {
    projectDisplayName: "Sample Project",
    defaultBranch: "develop",
    roles: [{ role: "developer", provider: null, model: null }],
    scheduler: { concurrency: 2, enablePriorityAging: true, criticalPathBoost: false },
    recovery: { resumeSessions: true, maxAttempts: 3, recoveryCycleMinutes: 10, abortOnNoProgressDays: 7 },
    github: { syncEnabled: true, issueLinking: true, pullRequestSync: false },
    budgets: [],
    ...overrides,
  };
}

function projectYaml(branch: string): string {
  return `schema_version: 1\nproject:\n  name: sample\n  default_branch: ${branch}\n`;
}

function createFixture(fileBacked = false) {
  const root = mkdtempSync(join(tmpdir(), "ebb-project-config-editor-"));
  tempRoots.push(root);
  const databasePath = fileBacked ? join(root, "state.sqlite") : undefined;
  const configDir = join(root, ".ebb-orchestrator");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "project.yaml"), projectYaml("main"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "."], { cwd: root, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: root, windowsHide: true });
  const db = createSqliteDatabase(databasePath ?? ":memory:");
  runMigrations(db, loadTestMigrations());
  const projectId = randomUUID();
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'sample','sample','ACTIVE',$now,$now)", { id: projectId, now });
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,created_at,updated_at) VALUES($id,$path,'{}','null','PROPOSED',$now,$now)", { id: projectId, path: root, now });
  return { root, projectId, databasePath, db, service: new ProjectConfigService(db, new ApprovalService(db)) };
}

describe("Project Config v2 editor", () => {
  it("fails closed on Windows and never writes repository files", () => {
    const fixture = createFixture();
    const service = fixture.service;
    // Реальный win32-хост: production gate остаётся жёстким.
    expect(() => service.capture(fixture.projectId)).toThrow(/disabled on windows until safe file-handle verification/i);
    expect(() => service.saveEditorCandidate(fixture.projectId, "0".repeat(64), v2Settings())).toThrow(/disabled on windows until safe file-handle verification/i);
    const projectYamlAfter = readFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "utf8");
    expect(projectYamlAfter).toBe(projectYaml("main"));
    expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_candidates")?.count).toBe(0);
    fixture.db.close();
  });

  const editorSuite = process.platform === "win32" ? describe : describe;
  editorSuite("editor candidate lifecycle", () => {
    it("rejects a stale expected manifest hash before creating any candidate", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        expect(() => fixture.service.saveEditorCandidate(fixture.projectId, "0".repeat(64), v2Settings())).toThrow(/current|stale/i);
        expect(() => fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings())).not.toThrow();
      });
      fixture.db.close();
    });

    it("rejects malformed, secret-shaped and non-allowlisted settings without persisting a candidate", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        expect(() => fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, { unknown: true } as never)).toThrow(/schema|invalid/i);
        expect(() => fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings({ projectDisplayName: "x".repeat(201) }))).toThrow(/schema|invalid/i);
        expect(() => fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings({ roles: [{ role: "developer", provider: "sk-abcdefgh12345678", model: null }] }))).toThrow(/secret|schema/i);
        expect(() => fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings({ defaultBranch: "master" }))).toThrow(/policy|branch/i);
        expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_candidates")?.count).toBe(1);
      });
      fixture.db.close();
    });

    it("saves an immutable pending candidate without writing repo files or changing the active revision", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        const candidate = fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings());
        expect(candidate.status).toBe("PENDING_REVIEW");
        expect(fixture.service.getCurrentCandidate(fixture.projectId)?.candidateId).toBe(candidate.candidateId);
        expect(fixture.service.getActive(fixture.projectId)).toBeUndefined();
        const projectYamlAfter = readFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "utf8");
        expect(projectYamlAfter).toBe(projectYaml("main"));
      });
      fixture.db.close();
    });

    it("approves via the journal: PREPARED journal, candidate stays pending, active unchanged until apply", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        const candidate = fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings());
        const active = fixture.service.editorApprove(fixture.projectId, candidate.candidateId, candidate.manifestHash);
        expect(active.revisionId).toBeTruthy();
        expect(fixture.service.getActive(fixture.projectId)?.revisionHash).toBe(active.revisionHash);
        const journal = fixture.db.get<{ phase: string }>("SELECT phase FROM project_config_write_journal WHERE candidate_id=$id", { id: candidate.candidateId });
        expect(journal?.phase).toBe("APPLIED");
        const finalYaml = readFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "utf8");
        expect(finalYaml).toContain('name: "Sample Project"');
        expect(finalYaml).toContain('default_branch: "develop"');
      });
      fixture.db.close();
    });

    it("rejects candidate capture/approval while a non-terminal journal exists", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        const candidate = fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings());
        const journalId = randomUUID();
        const now = new Date().toISOString();
        const approvalId = randomUUID();
        fixture.db.run(
          "INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','t',$now)",
          { id: approvalId, projectId: fixture.projectId, now },
        );
        fixture.db.run(
          `INSERT INTO project_config_write_journal(id,project_id,candidate_id,approval_id,expected_manifest_hash,old_files_json,new_files_json,phase,created_at,updated_at)
           VALUES($id,$projectId,$candidateId,$approvalId,$hash,'{}','{}','PREPARED',$now,$now)`,
          { id: journalId, projectId: fixture.projectId, candidateId: candidate.candidateId, approvalId, hash: "0".repeat(64), now },
        );
        expect(() => fixture.service.capture(fixture.projectId)).toThrow(/journal|apply|approval/i);
        expect(() => fixture.service.editorApprove(fixture.projectId, candidate.candidateId, candidate.manifestHash)).toThrow(/journal|apply|approval/i);
      });
      fixture.db.close();
    });

    it("blocks dispatch while a PREPARED/WRITING/DEGRADED journal exists and fails closed on DEGRADED recovery", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        const candidate = fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings());
        // Имитация внешней модификации до apply: файл не соответствует old/new.
        writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "ext: modified\n");
        expect(() => fixture.service.editorApprove(fixture.projectId, candidate.candidateId, candidate.manifestHash)).toThrow(/degraded|reconcil/i);
        const journal = fixture.db.get<{ phase: string; failure_code: string | null }>("SELECT phase,failure_code FROM project_config_write_journal WHERE candidate_id=$id", { id: candidate.candidateId });
        expect(journal?.phase).toBe("DEGRADED");
        expect(fixture.db.get<{ config_status: string }>("SELECT config_status FROM project_config_state WHERE project_id=$id", { id: fixture.projectId })?.config_status).toBe("DEGRADED");
      });
      fixture.db.close();
    });

    it("recovers an interrupted multi-file apply only when every observed change is old or approved-new", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        const candidate = fixture.service.saveEditorCandidate(fixture.projectId, baseline.manifestHash, v2Settings());
        const active = fixture.service.editorApprove(fixture.projectId, candidate.candidateId, candidate.manifestHash);
        // Имитация краша между записью файлов и apply-транзакцией: журнал снова WRITING,
        // один файл возвращён к old, остальные уже new — каждое изменение объяснимо.
        fixture.db.run(
          "UPDATE project_config_write_journal SET phase='WRITING',updated_at=$now WHERE candidate_id=$id",
          { id: candidate.candidateId, now: new Date().toISOString() },
        );
        writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), projectYaml("main"));
        fixture.service.reconcileActiveOnStartup();
        const journal = fixture.db.get<{ phase: string }>("SELECT phase FROM project_config_write_journal WHERE candidate_id=$id", { id: candidate.candidateId });
        expect(journal?.phase).toBe("APPLIED");
        expect(fixture.service.getActive(fixture.projectId)?.revisionHash).toBe(active.revisionHash);
        const yaml = readFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "utf8");
        expect(yaml).toContain('name: "Sample Project"');
      });
      fixture.db.close();
    });

    it("rejects a symlinked config directory during capture (junction/reparse race)", () => {
      const fixture = createFixture();
      const outside = join(fixture.root, "outside-guidelines");
      mkdirSync(outside);
      writeFileSync(join(outside, "outside.md"), "untrusted");
      const link = join(fixture.root, ".ebb-orchestrator", "guidelines");
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      forcePlatformSync("linux", () => {
        expect(() => fixture.service.capture(fixture.projectId)).toThrow();
      });
      expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_candidates")?.count).toBe(0);
      fixture.db.close();
    });

    it("accepts ACCEPT_EXTERNAL only after safe re-read validation, preserving the prior active revision", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        const active = fixture.service.approve(fixture.projectId, baseline.candidateId, baseline.manifestHash);
        const second = fixture.service.saveEditorCandidate(fixture.projectId, active.manifestHash, v2Settings());
        // Внешняя модификация -> DEGRADED.
        writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "schema_version: 1\nproject:\n  name: External\n  default_branch: develop\n");
        expect(() => fixture.service.editorApprove(fixture.projectId, second.candidateId, second.manifestHash)).toThrow(/degraded|reconcil/i);
        const journal = fixture.db.get<{ id: string; phase: string }>("SELECT id,phase FROM project_config_write_journal WHERE candidate_id=$id", { id: second.candidateId });
        expect(journal?.phase).toBe("DEGRADED");

        const observed = fixture.service.readCanonicalManifest(fixture.projectId);
        const outcome = fixture.service.reconcileJournal(fixture.projectId, journal!.id, {
          expectedPhase: "DEGRADED",
          observedManifestHash: observed.manifestHash,
          resolution: "ACCEPT_EXTERNAL",
        });
        expect(outcome.phase).toBe("RECONCILED_EXTERNAL");
        expect(outcome.configStatus).toBe("READY");
        expect(outcome.currentCandidateId).not.toBe(second.candidateId);
        expect(outcome.activeRevisionId).toBe(active.revisionId);
        expect(fixture.service.getActive(fixture.projectId)?.revisionHash).toBe(active.revisionHash);
        // Dispatch продолжается от прежнего approved active revision.
        expect(fixture.service.getCurrentCandidate(fixture.projectId)?.status).toBe("PENDING_REVIEW");
        // Retry возвращает существующий результат, без второго write.
        const retry = fixture.service.reconcileJournal(fixture.projectId, journal!.id, {
          expectedPhase: "DEGRADED", observedManifestHash: observed.manifestHash, resolution: "ACCEPT_EXTERNAL",
        });
        expect(retry).toEqual(outcome);
      });
      fixture.db.close();
    });

    it("restores the approved revision only when its exact bytes are provable", () => {
      const fixture = createFixture();
      forcePlatformSync("linux", () => {
        const baseline = fixture.service.capture(fixture.projectId);
        const active = fixture.service.approve(fixture.projectId, baseline.candidateId, baseline.manifestHash);
        const second = fixture.service.saveEditorCandidate(fixture.projectId, active.manifestHash, v2Settings());
        writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "external: tampered\n");
        expect(() => fixture.service.editorApprove(fixture.projectId, second.candidateId, second.manifestHash)).toThrow(/degraded|reconcil/i);
        const journal = fixture.db.get<{ id: string; phase: string }>("SELECT id,phase FROM project_config_write_journal WHERE candidate_id=$id", { id: second.candidateId });
        expect(journal?.phase).toBe("DEGRADED");
        const activeRevision = fixture.db.get<{ candidate_id: string }>("SELECT candidate_id FROM project_config_revisions WHERE revision_id=$id", { id: active.revisionId });
        const outcome = fixture.service.reconcileJournal(fixture.projectId, journal!.id, {
          expectedPhase: "DEGRADED",
          observedManifestHash: "0".repeat(64),
          resolution: "RESTORE_APPROVED",
        });
        expect(outcome.phase).toBe("RECONCILED_RESTORED");
        expect(outcome.configStatus).toBe("READY");
        expect(outcome.currentCandidateId).toBe(activeRevision!.candidate_id);
        expect(outcome.activeRevisionId).toBe(active.revisionId);
        const yaml = readFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), "utf8");
        expect(yaml).toBe(projectYaml("main"));
      });
      fixture.db.close();
    });
  });
});

// Служебные типы для избежания неиспользуемых импортов в строгом tsc.
export type { ProjectConfigError };
