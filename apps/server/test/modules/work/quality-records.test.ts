import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { FindingsService, type FindingStatus } from "../../../src/modules/work/findings-service.js";
import { DefectsService, type DefectStatus } from "../../../src/modules/work/defects-service.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migration008 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/008_quality.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 8, name: "008_quality", sql: migration008 },
];

function createTestDb(): Promise<{ db: Database; tmpDir: string }> {
  return new Promise(async (resolve) => {
    const tmpDir = await mkdtemp(join(tmpdir(), "orch-quality-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const db = createSqliteDatabase(dbPath);
    runMigrations(db, migrations);
    resolve({ db, tmpDir });
  });
}

describe("FindingsService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let findingsService: FindingsService;

  const projectA = { id: randomUUID() };
  const taskA = { id: randomUUID() };
  const taskB = { id: randomUUID() };

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setup() {
    const { db: database, tmpDir: dir } = await createTestDb();
    db = database;
    tmpDir = dir;
    findingsService = new FindingsService(db);

    // Seed project and tasks
    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.run(
        "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)",
        { id: projectA.id, name: "test-project", display_name: "Test Project", status: "ACTIVE", created_at: now, updated_at: now },
      );
      tx.run(
        "INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at) VALUES ($id, $projectId, $epicId, $displayId, $title, $status, $contractJson, $required, $createdAt, $updatedAt)",
        { id: taskA.id, projectId: projectA.id, epicId: null, displayId: `TASK-A-${Date.now()}`, title: "Test Task", status: "READY", contractJson: "{}", required: 1, createdAt: now, updatedAt: now },
      );
      tx.run(
        "INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at) VALUES ($id, $projectId, $epicId, $displayId, $title, $status, $contractJson, $required, $createdAt, $updatedAt)",
        { id: taskB.id, projectId: projectA.id, epicId: null, displayId: `TASK-B-${Date.now()}`, title: "Another Task", status: "READY", contractJson: "{}", required: 1, createdAt: now, updatedAt: now },
      );
    });
  }

  it("assigns stable FINDING-N IDs per project", async () => {
    await setup();
    const f1 = findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: true,
      title: "First finding",
      description: "Description",
      guidelineRef: "GL-001",
      evidenceSignature: "sig1",
    });
    const f2 = findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "NORMAL",
      blocking: false,
      title: "Second finding",
      description: "Description",
      guidelineRef: null,
      evidenceSignature: "sig2",
    });
    expect(f1.displayId).toBe("FINDING-1");
    expect(f2.displayId).toBe("FINDING-2");
  });

  it("generates independent FINDING-N IDs per project", async () => {
    await setup();
    const f1 = findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "Finding in taskA",
      description: "Description",
      guidelineRef: null,
      evidenceSignature: "sig1",
    });
    const f2 = findingsService.createFinding(projectA.id, taskB.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "Finding in taskB",
      description: "Description",
      guidelineRef: null,
      evidenceSignature: "sig2",
    });
    // IDs are sequential per project across all tasks
    expect(f1.displayId).toBe("FINDING-1");
    expect(f2.displayId).toBe("FINDING-2");
  });

  it("persists all required fields", async () => {
    await setup();
    const f = findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: "run-123",
      severity: "BLOCKING",
      blocking: true,
      title: "Test finding",
      description: "This is a test",
      guidelineRef: "GL-TEST-001",
      evidenceSignature: "evidence-hash",
    });
    expect(f.sourceRunId).toBe("run-123");
    expect(f.severity).toBe("BLOCKING");
    expect(f.blocking).toBe(true);
    expect(f.guidelineRef).toBe("GL-TEST-001");
    expect(f.evidenceSignature).toBe("evidence-hash");
    expect(f.status).toBe("OPEN");
  });

  it("updates status on re-review without creating duplicate", async () => {
    await setup();
    const f1 = findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: true,
      title: "Issue",
      description: "Description",
      guidelineRef: null,
      evidenceSignature: "original-sig",
    });
    expect(f1.status).toBe("OPEN");

    // Re-review: update to RESOLVED
    const f2 = findingsService.updateFinding(f1.id, {
      status: "RESOLVED",
      evidenceSignature: "updated-sig",
    });
    expect(f2.status).toBe("RESOLVED");
    expect(f2.displayId).toBe("FINDING-1");
    expect(f2.evidenceSignature).toBe("updated-sig");

    // Count findings - still only one
    const count = db.get<{ c: number }>("SELECT COUNT(*) as c FROM findings WHERE task_id = $taskId", { taskId: taskA.id });
    expect(count.c).toBe(1);
  });

  it("retrieves findings by task", async () => {
    await setup();
    findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "First",
      description: "Desc",
      guidelineRef: null,
      evidenceSignature: "sig1",
    });
    findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "LOW",
      blocking: false,
      title: "Second",
      description: "Desc",
      guidelineRef: null,
      evidenceSignature: "sig2",
    });
    const all = findingsService.getFindingsByTaskId(db, taskA.id);
    expect(all).toHaveLength(2);
    expect(all.map(f => f.displayId)).toEqual(["FINDING-1", "FINDING-2"]);
  });

  it("retrieves open findings by task", async () => {
    await setup();
    const f1 = findingsService.createFinding(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "Open issue",
      description: "Desc",
      guidelineRef: null,
      evidenceSignature: "sig1",
    });
    findingsService.createFinding(projectA.id, taskB.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "Other",
      description: "Desc",
      guidelineRef: null,
      evidenceSignature: "sig2",
    });
    findingsService.updateFinding(f1.id, { status: "RESOLVED" });

    const open = findingsService.getOpenFindingsByTaskId(db, taskB.id);
    expect(open).toHaveLength(1);
    expect(open[0].displayId).toBe("FINDING-2");
  });
});

describe("DefectsService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let defectsService: DefectsService;

  const projectA = { id: randomUUID() };
  const taskA = { id: randomUUID() };
  const taskB = { id: randomUUID() };

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setup() {
    const { db: database, tmpDir: dir } = await createTestDb();
    db = database;
    tmpDir = dir;
    defectsService = new DefectsService(db);

    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.run(
        "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)",
        { id: projectA.id, name: "test-project", display_name: "Test Project", status: "ACTIVE", created_at: now, updated_at: now },
      );
      tx.run(
        "INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at) VALUES ($id, $projectId, $epicId, $displayId, $title, $status, $contractJson, $required, $createdAt, $updatedAt)",
        { id: taskA.id, projectId: projectA.id, epicId: null, displayId: `TASK-A-${Date.now()}`, title: "Test Task", status: "READY", contractJson: "{}", required: 1, createdAt: now, updatedAt: now },
      );
      tx.run(
        "INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at) VALUES ($id, $projectId, $epicId, $displayId, $title, $status, $contractJson, $required, $createdAt, $updatedAt)",
        { id: taskB.id, projectId: projectA.id, epicId: null, displayId: `TASK-B-${Date.now()}`, title: "Another Task", status: "READY", contractJson: "{}", required: 1, createdAt: now, updatedAt: now },
      );
    });
  }

  it("assigns stable DEFECT-N IDs per project", async () => {
    await setup();
    const d1 = defectsService.createDefect(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "BLOCKING",
      blocking: true,
      title: "First defect",
      description: "Description",
      acceptanceCriterionRef: "AC-1",
      evidenceSignature: "sig1",
    });
    const d2 = defectsService.createDefect(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "Second defect",
      description: "Description",
      acceptanceCriterionRef: null,
      evidenceSignature: "sig2",
    });
    expect(d1.displayId).toBe("DEFECT-1");
    expect(d2.displayId).toBe("DEFECT-2");
  });

  it("persists all required fields", async () => {
    await setup();
    const d = defectsService.createDefect(projectA.id, taskA.id, {
      sourceRunId: "run-456",
      severity: "BLOCKING",
      blocking: true,
      title: "Critical defect",
      description: "Must be fixed",
      acceptanceCriterionRef: "AC-ACCEPTANCE",
      evidenceSignature: "test-failure-hash",
    });
    expect(d.sourceRunId).toBe("run-456");
    expect(d.severity).toBe("BLOCKING");
    expect(d.blocking).toBe(true);
    expect(d.acceptanceCriterionRef).toBe("AC-ACCEPTANCE");
    expect(d.evidenceSignature).toBe("test-failure-hash");
    expect(d.status).toBe("OPEN");
  });

  it("updates status on re-test without creating duplicate", async () => {
    await setup();
    const d1 = defectsService.createDefect(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "Failing test",
      description: "Test description",
      acceptanceCriterionRef: "AC-1",
      evidenceSignature: "original-sig",
    });
    expect(d1.status).toBe("OPEN");

    // Re-test: update to RESOLVED
    const d2 = defectsService.updateDefect(d1.id, {
      status: "RESOLVED",
      evidenceSignature: "new-test-sig",
    });
    expect(d2.status).toBe("RESOLVED");
    expect(d2.displayId).toBe("DEFECT-1");
    expect(d2.evidenceSignature).toBe("new-test-sig");

    // Count defects - still only one
    const count = db.get<{ c: number }>("SELECT COUNT(*) as c FROM defects WHERE task_id = $taskId", { taskId: taskA.id });
    expect(count.c).toBe(1);
  });

  it("retrieves defects by task", async () => {
    await setup();
    defectsService.createDefect(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "First",
      description: "Desc",
      acceptanceCriterionRef: null,
      evidenceSignature: "sig1",
    });
    defectsService.createDefect(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "LOW",
      blocking: false,
      title: "Second",
      description: "Desc",
      acceptanceCriterionRef: null,
      evidenceSignature: "sig2",
    });
    const all = defectsService.getDefectsByTaskId(db, taskA.id);
    expect(all).toHaveLength(2);
    expect(all.map(d => d.displayId)).toEqual(["DEFECT-1", "DEFECT-2"]);
  });

  it("retrieves open defects by task", async () => {
    await setup();
    const d1 = defectsService.createDefect(projectA.id, taskA.id, {
      sourceRunId: randomUUID(),
      severity: "HIGH",
      blocking: false,
      title: "Open issue",
      description: "Desc",
      acceptanceCriterionRef: null,
      evidenceSignature: "sig1",
    });
    defectsService.updateDefect(d1.id, { status: "RESOLVED" });

    const open = defectsService.getOpenDefectsByTaskId(db, taskA.id);
    expect(open).toHaveLength(0);
  });
});
