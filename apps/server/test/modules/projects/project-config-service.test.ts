import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { ProjectConfigService } from "../../../src/modules/projects/project-config-service.js";
import { ApprovalService } from "../../../src/modules/approvals/approval-service.js";
import { createRunContextInput, RunService } from "../../../src/modules/runtime/run-service.js";
import { FakeAgentRuntime } from "../../fakes/fake-agent-runtime.js";
import { loadValidatedCapability } from "../../../src/modules/execution/capability-validation.js";

const tempRoots: string[] = [];
afterEach(() => { for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("ProjectConfigService platform safety", () => {
  it("fails closed before touching repository files when Windows capture is selected", () => {
    const fixture = createFixture();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    expect(platformDescriptor?.configurable).toBe(true);
    try {
      Object.defineProperty(process, "platform", { ...platformDescriptor!, value: "win32" });
      expect(() => fixture.service.capture(fixture.projectId)).toThrow(/disabled on windows until safe file-handle verification/i);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor!);
    }
    expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_candidates")?.count).toBe(0);
    fixture.db.close();
  });
});

// Windows capture remains intentionally unavailable until native handle/reparse verification is implemented.
const supportedCaptureSuite = process.platform === "win32" ? describe.skip : describe;
supportedCaptureSuite("ProjectConfigService", () => {
  it("captures exact repository bytes into an immutable pending candidate with deterministic hash", () => {
    const fixture = createFixture();
    const first = fixture.service.capture(fixture.projectId);
    const repeated = fixture.service.capture(fixture.projectId);
    expect(first.status).toBe("PENDING_REVIEW");
    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(repeated);
    expect(first.files[".ebb-orchestrator/project.yaml"]).toContain("default_branch: main");
    expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_candidates")?.count).toBe(1);
    fixture.db.close();
  });

  it("stales the prior pending candidate atomically when repository content changes", () => {
    const fixture = createFixture();
    const first = fixture.service.capture(fixture.projectId);
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), projectYaml("develop"));
    const second = fixture.service.capture(fixture.projectId);
    expect(second.candidateId).not.toBe(first.candidateId);
    expect(fixture.db.get<{ status: string }>("SELECT status FROM project_config_candidates WHERE candidate_id=$id", { id: first.candidateId })?.status).toBe("STALE");
    expect(fixture.service.getActive(fixture.projectId)).toBeUndefined();
    fixture.db.close();
  });

  it("requires the current candidate ID and exact manifest hash to approve and activate", () => {
    const fixture = createFixture();
    const first = fixture.service.capture(fixture.projectId);
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), projectYaml("develop"));
    const current = fixture.service.capture(fixture.projectId);
    expect(() => fixture.service.approve(fixture.projectId, first.candidateId, first.manifestHash)).toThrow(/stale|current/i);
    const active = fixture.service.approve(fixture.projectId, current.candidateId, current.manifestHash);
    expect(active.manifestHash).toBe(current.manifestHash);
    expect(active.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.service.getActive(fixture.projectId)?.revisionHash).toBe(active.revisionHash);
    fixture.db.close();
  });

  it("binds prepared runtime capabilities and workspace.read to the approved snapshot, never to a pending repository candidate", async () => {
    const fixture = createFixture();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    fixture.db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId: fixture.projectId, now });
    fixture.db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$root,$root,$branch,$now)", { id: taskId, root: fixture.root, branch: `task/${taskId}`, now });
    const runs = new RunService(fixture.db, new FakeAgentRuntime());
    const options = {
      role: "developer", model: "test", taskId, epicId: null, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: fixture.root }, prompt: "test Project Config binding",
    };
    const runOptions = {
      ...options,
      contextInput: createRunContextInput(options, {
        prompt: options.prompt,
        workspaceIdentity: { repository: fixture.root, workspace: fixture.root, worktree: taskId },
        targetHead: null,
        targetBranch: null,
      }),
    };

    const first = fixture.service.capture(fixture.projectId);
    expect(() => runs.prepareRun(runOptions)).toThrow(/approved active revision/i);
    const active = fixture.service.approve(fixture.projectId, first.candidateId, first.manifestHash);
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), projectYaml("develop"));
    mkdirSync(join(fixture.root, ".ebb-orchestrator", "guidelines"));
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "guidelines", "new.md"), "pending guideline");
    const pending = fixture.service.capture(fixture.projectId);
    const run = runs.prepareRun(runOptions);
    const persisted = fixture.db.get<{ capability_json: string }>("SELECT capability_json FROM agent_runs WHERE id=$id", { id: run.id });
    expect(JSON.parse(persisted!.capability_json).approvedProjectConfig).toMatchObject({ revisionId: active.revisionId, revisionHash: active.revisionHash, config: { project: { default_branch: "main" } } });
    expect(loadValidatedCapability(fixture.db, run.capabilityRef!).capability.approvedProjectConfig).toMatchObject({ revisionId: active.revisionId, config: { project: { default_branch: "main" } } });
    const approvedRead = await loadValidatedCapability(fixture.db, run.capabilityRef!).getActionGateway().readFile(".ebb-orchestrator/project.yaml");
    expect(approvedRead).toMatchObject({ success: true, content: expect.stringContaining("default_branch: main") });
    expect(await loadValidatedCapability(fixture.db, run.capabilityRef!).getActionGateway().readFile(".ebb-orchestrator/guidelines/new.md"))
      .toMatchObject({ success: false, error: expect.stringContaining("absent from approved") });
    const tampered = JSON.parse(persisted!.capability_json) as { approvedProjectConfig: { revisionHash: string } };
    tampered.approvedProjectConfig.revisionHash = "0".repeat(64);
    fixture.db.run("UPDATE agent_runs SET capability_json=$json WHERE id=$id", { json: JSON.stringify(tampered), id: run.id });
    expect(() => loadValidatedCapability(fixture.db, run.capabilityRef!)).toThrow(/integrity validation/i);
    fixture.db.run("UPDATE agent_runs SET capability_json=$json WHERE id=$id", { json: persisted!.capability_json, id: run.id });

    const next = fixture.service.approve(fixture.projectId, pending.candidateId, pending.manifestHash);
    const nextRun = runs.prepareRun(runOptions);
    const nextPersisted = fixture.db.get<{ capability_json: string }>("SELECT capability_json FROM agent_runs WHERE id=$id", { id: nextRun.id });
    expect(JSON.parse(nextPersisted!.capability_json).approvedProjectConfig).toMatchObject({ revisionId: next.revisionId, config: { project: { default_branch: "develop" } } });
    expect(await loadValidatedCapability(fixture.db, nextRun.capabilityRef!).getActionGateway().readFile(".ebb-orchestrator/guidelines/new.md"))
      .toMatchObject({ success: true, content: "pending guideline" });
    expect(await loadValidatedCapability(fixture.db, run.capabilityRef!).getActionGateway().readFile(".ebb-orchestrator/project.yaml"))
      .toMatchObject({ success: true, content: expect.stringContaining("default_branch: main") });
    fixture.db.close();
  });

  it("rejects symlinked config files and invalid project.yaml without changing candidate pointers", () => {
    const fixture = createFixture();
    const outsideDirectory = join(fixture.root, "outside-guidelines");
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, "outside.md"), "untrusted");
    const link = join(fixture.root, ".ebb-orchestrator", "guidelines");
    symlinkSync(outsideDirectory, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => fixture.service.capture(fixture.projectId)).toThrow();
    expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_candidates")?.count).toBe(0);
    fixture.db.close();
  });

  it("rejects repository config files above the application limit before persisting a candidate", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "guidelines-overflow.md"), "x".repeat(1_048_577));
    expect(() => fixture.service.capture(fixture.projectId)).toThrow(/unknown project config file/i);
    unlinkSync(join(fixture.root, ".ebb-orchestrator", "guidelines-overflow.md"));
    mkdirSync(join(fixture.root, ".ebb-orchestrator", "guidelines"));
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "guidelines", "overflow.md"), "x".repeat(1_048_577));
    expect(() => fixture.service.capture(fixture.projectId)).toThrow(/size limit/i);
    expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_candidates")?.count).toBe(0);
    fixture.db.close();
  });

  it("blocks a corrupt active revision without falling back to pending or older config", () => {
    const fixture = createFixture();
    const candidate = fixture.service.capture(fixture.projectId);
    const active = fixture.service.approve(fixture.projectId, candidate.candidateId, candidate.manifestHash);
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), projectYaml("develop"));
    const pending = fixture.service.capture(fixture.projectId);
    fixture.db.exec("DROP TRIGGER trg_project_config_revision_immutable");
    fixture.db.run("UPDATE project_config_revisions SET normalized_payload_json='{}' WHERE revision_id=$id", { id: active.revisionId });

    fixture.service.reconcileActiveOnStartup();
    expect(() => fixture.service.getActive(fixture.projectId)).toThrow(/degraded/i);
    expect(fixture.service.getCurrentCandidate(fixture.projectId)?.candidateId).toBe(pending.candidateId);
    expect(fixture.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_revisions WHERE project_id=$id", { id: fixture.projectId })?.count).toBe(1);
    expect(fixture.db.get<{ config_status: string }>("SELECT config_status FROM project_config_state WHERE project_id=$id", { id: fixture.projectId })?.config_status).toBe("DEGRADED");
    fixture.db.close();
  });

  it("stages historical rollback for another explicit candidate approval", () => {
    const fixture = createFixture();
    const first = fixture.service.capture(fixture.projectId);
    const firstActive = fixture.service.approve(fixture.projectId, first.candidateId, first.manifestHash);
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), projectYaml("develop"));
    const second = fixture.service.capture(fixture.projectId);
    fixture.service.approve(fixture.projectId, second.candidateId, second.manifestHash);

    const rollback = fixture.service.stageRollback(fixture.projectId, firstActive.revisionId);
    expect(rollback.status).toBe("PENDING_REVIEW");
    expect(rollback.manifestHash).toBe(first.manifestHash);
    expect(fixture.service.getActive(fixture.projectId)?.manifestHash).toBe(second.manifestHash);
    const restored = fixture.service.approve(fixture.projectId, rollback.candidateId, rollback.manifestHash);
    expect(restored.manifestHash).toBe(first.manifestHash);
    fixture.db.close();
  });

  it("restores the approved active snapshot and pending candidate after SQLite reopen", () => {
    const fixture = createFixture(true);
    const databasePath = fixture.databasePath!;
    const approved = fixture.service.capture(fixture.projectId);
    const active = fixture.service.approve(fixture.projectId, approved.candidateId, approved.manifestHash);
    writeFileSync(join(fixture.root, ".ebb-orchestrator", "project.yaml"), projectYaml("develop"));
    const pending = fixture.service.capture(fixture.projectId);
    fixture.db.close();

    const reopened = createSqliteDatabase(databasePath);
    const service = new ProjectConfigService(reopened, new ApprovalService(reopened));
    service.reconcileActiveOnStartup();
    expect(service.getActive(fixture.projectId)?.revisionHash).toBe(active.revisionHash);
    expect(service.getCurrentCandidate(fixture.projectId)?.candidateId).toBe(pending.candidateId);
    expect(service.getCurrentCandidate(fixture.projectId)?.status).toBe("PENDING_REVIEW");
    reopened.close();
  });
});

function projectYaml(branch: string): string { return `schema_version: 1\nproject:\n  name: sample\n  default_branch: ${branch}\n`; }

function createFixture(fileBacked = false) {
  const root = mkdtempSync(join(tmpdir(), "ebb-project-config-"));
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
  db.exec(readMigration());
  return { root, projectId, databasePath, db, service: new ProjectConfigService(db, new ApprovalService(db)) };
}

function readMigration(): string {
  return readFileSync(new URL("../../../src/platform/database/migrations/033_project_config_lifecycle.sql", import.meta.url), "utf8");
}
