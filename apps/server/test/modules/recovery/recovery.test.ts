import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { RecoveryService } from "../../../src/modules/recovery/recovery-service.js";
import {
  evaluateRecovery,
  countAttempts,
  getRemainingAttempts,
  hasExcessiveNoProgress,
} from "../../../src/modules/recovery/recovery-policy.js";
import { createNoProgressFingerprint } from "../../../src/modules/recovery/progress-fingerprint.js";
import type { RecoveryContext } from "../../../src/modules/recovery/recovery-types.js";
import { DEFAULT_POLICY } from "../../../src/modules/recovery/recovery-types.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../../src/modules/workflow/templates.js";
import { insertRunProcessOwnerTx, prepareRunProcessOwner } from "../../../src/modules/runtime/run-process-owner.js";
import { markFakeRunNeverLaunched } from "../../helpers/fake-run-process-owner.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migration003 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/003_work_control.sql"),
  "utf-8",
);

const migration006 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/006_recovery.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
  { version: 6, name: "006_recovery", sql: migration006 },
];

/**
 * Создаёт контекст восстановления для тестов.
 */
function createContext(
  taskId: string = randomUUID(),
  roleLevel: "middle" | "senior" = "middle",
  failureType: Parameters<typeof evaluateRecovery>[0]["failureType"] = "TASK_FAILURE",
  attempts: Parameters<typeof evaluateRecovery>[0]["attempts"] = [],
  stage?: string,
  evidenceHash?: string,
): RecoveryContext {
  return {
    taskId,
    currentRoleLevel: roleLevel,
    failureType,
    attempts,
    ...(stage !== undefined && { stage }),
    ...(evidenceHash !== undefined && { evidenceHash }),
  };
}

describe("RecoveryService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let service: RecoveryService;
  let taskId: string;

  beforeEach(() => {
    tmpDir = "";
    taskId = randomUUID();
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-recovery-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setup(): Promise<void> {
    db = await setupDb();
    service = new RecoveryService(db, DEFAULT_POLICY);
    // Создаём project и task для соблюдения ограничения FK.
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
         VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)`,
        {
          id: projectId,
          name: "test-project",
          display_name: "Test Project",
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
      tx.run(
        `INSERT INTO tasks (id, project_id, display_id, title, status, contract_json, required, created_at, updated_at)
         VALUES ($id, $project_id, $display_id, $title, $status, $contract_json, $required, $created_at, $updated_at)`,
        {
          id: taskId,
          project_id: projectId,
          display_id: "TEST-TASK",
          title: "Test Task",
          status: "READY",
          contract_json: JSON.stringify({
            version: 1,
            goal: "Test goal",
            context: "Test context",
            requirements: [],
            acceptanceCriteria: [],
            dependencies: [],
            nonGoals: [],
            definitionOfDone: [],
          }),
          required: 1,
          created_at: now,
          updated_at: now,
        },
      );
    });
  }

  describe("evaluateRecovery", () => {
    it("returns RESUME_SAME_SESSION for first task failure at middle tier", () => {
      const context = createContext("task1", "middle", "TASK_FAILURE");
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("RESUME_SAME_SESSION");
      expect(result.createSchedulerRequest).toBe(false);
    });

    it("escalates to senior after middle tier exhausted on task failure", () => {
    // Уровень middle исчерпан после 2 попыток (максимум — 2).
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 2,
          timestamp: new Date().toISOString(),
        },
      ];
      const context = createContext("task1", "middle", "TASK_FAILURE", attempts);
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("ESCALATE_ROLE");
      expect(result.nextRoleLevel).toBe("senior");
      expect(result.createSchedulerRequest).toBe(true);
    });

    it("returns RETRY for first task failure at senior tier", () => {
      const context = createContext("task1", "senior", "TASK_FAILURE");
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("RETRY");
      expect(result.createSchedulerRequest).toBe(true);
    });

    it("escalates to coordinator after senior tier exhausted on task failure", () => {
    // Уровень senior исчерпан после 2 попыток (максимум — 2).
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "senior" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
        },
        {
          taskId: "task1",
          roleLevel: "senior" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 2,
          timestamp: new Date().toISOString(),
        },
      ];
      const context = createContext("task1", "senior", "TASK_FAILURE", attempts);
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("COORDINATOR_DIAGNOSIS");
      expect(result.createSchedulerRequest).toBe(false);
    });

    it("never escalates role for TOOL_ERROR - always retries", () => {
      const context = createContext("task1", "middle", "TOOL_ERROR");
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("RETRY");
      expect(result.createSchedulerRequest).toBe(true);
    });

    it("escalates on no-progress after max consecutive runs", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "NO_PROGRESS" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
          fingerprint: createNoProgressFingerprint("review", new Date().toISOString()),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "NO_PROGRESS" as const,
          attemptCount: 2,
          timestamp: new Date().toISOString(),
          fingerprint: createNoProgressFingerprint("review", new Date().toISOString()),
        },
      ];
      const context = createContext("task1", "middle", "NO_PROGRESS", attempts, "review");
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("ESCALATE_ROLE");
      expect(result.nextRoleLevel).toBe("senior");
    });

    it("resets the no-progress streak after same-stage evidence in newest-first history", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "NO_PROGRESS" as const,
          attemptCount: 3,
          timestamp: "2026-01-03T00:00:00.000Z",
          fingerprint: createNoProgressFingerprint("review", "2026-01-03T00:00:00.000Z"),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "REVIEW_FINDING" as const,
          attemptCount: 2,
          timestamp: "2026-01-02T00:00:00.000Z",
          fingerprint: {
            stage: "review",
            evidenceHash: "review-evidence-2",
            recordedAt: "2026-01-02T00:00:00.000Z",
          },
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "NO_PROGRESS" as const,
          attemptCount: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          fingerprint: createNoProgressFingerprint("review", "2026-01-01T00:00:00.000Z"),
        },
      ];
      const originalOrder = [...attempts];

      const result = evaluateRecovery(createContext("task1", "middle", "NO_PROGRESS", attempts, "review"));

      expect(result.decision).toBe("BLOCK");
      expect(attempts).toEqual(originalOrder);
    });

    it("does not let unrelated-stage evidence, fingerprintless attempts, or tool errors reset no-progress streak", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "NO_PROGRESS" as const,
          attemptCount: 3,
          timestamp: "2026-01-04T00:00:00.000Z",
          fingerprint: createNoProgressFingerprint("review", "2026-01-04T00:00:00.000Z"),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TOOL_ERROR" as const,
          attemptCount: 2,
          timestamp: "2026-01-03T00:00:00.000Z",
          fingerprint: {
            stage: "review",
            evidenceHash: "tool-error-associated-evidence",
            recordedAt: "2026-01-03T00:00:00.000Z",
          },
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 1,
          timestamp: "2026-01-02T12:00:00.000Z",
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "REVIEW_FINDING" as const,
          attemptCount: 1,
          timestamp: "2026-01-02T00:00:00.000Z",
          fingerprint: {
            stage: "qa",
            evidenceHash: "qa-evidence-1",
            recordedAt: "2026-01-02T00:00:00.000Z",
          },
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "NO_PROGRESS" as const,
          attemptCount: 0,
          timestamp: "2026-01-01T00:00:00.000Z",
          fingerprint: createNoProgressFingerprint("review", "2026-01-01T00:00:00.000Z"),
        },
      ];

      expect(hasExcessiveNoProgress(attempts, "review", 2)).toBe(true);
    });

    it("uses stable input order for equal timestamps without mutating the history", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "NO_PROGRESS" as const,
          attemptCount: 2,
          timestamp: "2026-01-01T00:00:00.000Z",
          fingerprint: createNoProgressFingerprint("review", "2026-01-01T00:00:00.000Z"),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "REVIEW_FINDING" as const,
          attemptCount: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          fingerprint: {
            stage: "review",
            evidenceHash: "same-timestamp-evidence",
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ];
      const originalOrder = [...attempts];

      expect(hasExcessiveNoProgress(attempts, "review", 1)).toBe(false);
      expect(hasExcessiveNoProgress([...attempts].reverse(), "review", 1)).toBe(true);
      expect(attempts).toEqual(originalOrder);
    });

    it("detects review finding loop and escalates", () => {
      const evidenceHash = "abc123";
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "REVIEW_FINDING" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
          fingerprint: {
            stage: "review",
            evidenceHash,
            recordedAt: new Date().toISOString(),
          },
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "REVIEW_FINDING" as const,
          attemptCount: 2,
          timestamp: new Date().toISOString(),
          fingerprint: {
            stage: "review",
            evidenceHash,
            recordedAt: new Date().toISOString(),
          },
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "REVIEW_FINDING" as const,
          attemptCount: 3,
          timestamp: new Date().toISOString(),
          fingerprint: {
            stage: "review",
            evidenceHash,
            recordedAt: new Date().toISOString(),
          },
        },
      ];
      const context = createContext("task1", "middle", "REVIEW_FINDING", attempts, "review", evidenceHash);
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("ESCALATE_ROLE");
      expect(result.nextRoleLevel).toBe("senior");
    });

    it("limits integration resolution attempts then escalates to coordinator", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "INTEGRATION_FAILURE" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "INTEGRATION_FAILURE" as const,
          attemptCount: 2,
          timestamp: new Date().toISOString(),
        },
      ];
      const context = createContext("task1", "middle", "INTEGRATION_FAILURE", attempts);
      const result = evaluateRecovery(context);

      expect(result.decision).toBe("COORDINATOR_DIAGNOSIS");
      expect(result.createSchedulerRequest).toBe(false);
    });
  });

  describe("countAttempts", () => {
    it("counts attempts for specific role and failure type", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TOOL_ERROR" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
        },
      ];

      expect(countAttempts(attempts, "middle", "TASK_FAILURE")).toBe(1);
      expect(countAttempts(attempts, "middle", "TOOL_ERROR")).toBe(1);
      expect(countAttempts(attempts, "senior", "TASK_FAILURE")).toBe(0);
    });
  });

  describe("getRemainingAttempts", () => {
    it("returns remaining attempts at middle tier", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
        },
      ];

      const remaining = getRemainingAttempts(attempts, "middle", "TASK_FAILURE");
      expect(remaining).toBe(1); // max is 2, used 1
    });

    it("returns 0 when exhausted at middle tier", () => {
      const attempts = [
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 1,
          timestamp: new Date().toISOString(),
        },
        {
          taskId: "task1",
          roleLevel: "middle" as const,
          failureType: "TASK_FAILURE" as const,
          attemptCount: 2,
          timestamp: new Date().toISOString(),
        },
      ];

      const remaining = getRemainingAttempts(attempts, "middle", "TASK_FAILURE");
      expect(remaining).toBe(0);
    });
  });

  describe("recordAttempt", () => {
    it("persists recovery attempt to database", async () => {
      await setup();

      const context = createContext(taskId, "middle", "TASK_FAILURE");
      const attempt = service.recordAttempt(context);

      expect(attempt.taskId).toBe(taskId);
      expect(attempt.roleLevel).toBe("middle");
      expect(attempt.failureType).toBe("TASK_FAILURE");

    // Проверяем, что запись сохранена.
      const history = service.getHistory(taskId);
      expect(history.length).toBe(1);
      expect(history[0]!.taskId).toBe(taskId);
    });
  });

  describe("createSchedulerRequest", () => {
    it("creates scheduler request without calling runtime", async () => {
      await setup();

      const request = service.createSchedulerRequest(taskId, "middle", "TASK_FAILURE");

      expect(request.taskId).toBe(taskId);
      expect(request.roleLevel).toBe("middle");
      expect(request.failureType).toBe("TASK_FAILURE");
      expect(request.attemptCount).toBe(1);

    // Проверяем сохранение через историю, поскольку scheduler восстановления отделён.
      const existingRequests = db!.all(
        `SELECT * FROM recovery_scheduler_requests WHERE task_id = $task_id`,
        { task_id: taskId },
      ) as Array<{ id: string; task_id: string; role_level: string }>;
      expect(existingRequests.length).toBe(1);
    });
  });

  describe("blockTask", () => {
    it("blocks a task from recovery", async () => {
      await setup();

      service.blockTask(taskId, "Exceeded maximum recovery attempts");

      expect(service.isBlocked(taskId)).toBe(true);
    });
  });

  describe("deterministic behavior", () => {
    it("produces same result for same context", () => {
      const context = createContext("task1", "middle", "TASK_FAILURE");
      const result1 = evaluateRecovery(context);
      const result2 = evaluateRecovery(context);

      expect(result1.decision).toBe(result2.decision);
      expect(result1.reason).toBe(result2.reason);
    });

    it("handles multiple identical evaluations in sequence", () => {
      const context = createContext("task1", "middle", "TASK_FAILURE");
      const results = Array.from({ length: 5 }, () => evaluateRecovery(context));

      results.forEach((result) => {
        expect(result.decision).toBe("RESUME_SAME_SESSION");
      });
    });
  });
});

/**
 * RED-тесты интеграции policy-движка recovery в production-путь enqueueTaskRetry.
 * Проверяют эскалацию Middle→Senior, финальные состояния без повторного retry
 * и durable запись каждого решения в recovery_attempts.
 */
describe("RecoveryService.enqueueTaskRetry — production policy integration", () => {
  let db: Database | undefined;
  let tmpDir: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  interface Fixture {
    db: Database;
    service: RecoveryService;
    scheduler: SchedulerService;
    workflow: WorkflowEngine;
    projectId: string;
    now: string;
  }

  async function setup(): Promise<Fixture> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-recovery-prod-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    db = database;
    runMigrations(database, loadTestMigrations());
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const workflowEngine = new WorkflowEngine(database, registry);
    const schedulerService = new SchedulerService(database, () => new Date("2026-10-14T00:00:00.000Z"));
    const recoveryService = new RecoveryService(database, DEFAULT_POLICY);
    const projectId = randomUUID();
    const now = "2026-10-14T00:00:00.000Z";
    database.run(
      `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
       VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)`,
      { id: projectId, name: "test-project", display_name: "Test Project", status: "ACTIVE", created_at: now, updated_at: now },
    );
    return { db: database, service: recoveryService, scheduler: schedulerService, workflow: workflowEngine, projectId, now };
  }

  async function createTask(f: Fixture, status = "DEVELOPMENT"): Promise<string> {
    const taskId = randomUUID();
    f.db.run(
      `INSERT INTO tasks (id, project_id, display_id, title, status, contract_json, required, created_at, updated_at)
       VALUES ($id, $project_id, $display_id, $title, $status, $contract_json, $required, $created_at, $updated_at)`,
      {
        id: taskId,
        project_id: f.projectId,
        display_id: "TEST-TASK",
        title: "Test Task",
        status,
        contract_json: JSON.stringify({
          version: 1,
          goal: "Test goal",
          context: "Test context",
          requirements: [],
          acceptanceCriteria: [],
          dependencies: [],
          nonGoals: [],
          definitionOfDone: [],
        }),
        required: 1,
        created_at: f.now,
        updated_at: f.now,
      },
    );
    return taskId;
  }

  /** Создаёт failed-source Run с подтверждённым STOPPED owner и DISPATCHED запросом. */
  function createFailedSourceRun(f: Fixture, taskId: string, role: string): { runId: string; requestId: string } {
    const runId = randomUUID();
    f.db.run(
      `INSERT INTO agent_runs (id, role, runtime, model, task_id, epic_id, status, started_at, ended_at)
       VALUES ($id, $role, 'hermes', 'default', $taskId, NULL, 'FAILED', $now, $now)`,
      { id: runId, role, taskId, now: f.now },
    );
    const owner = prepareRunProcessOwner(runId, `home:${runId}`, "windows-job");
    f.db.transaction((tx) => insertRunProcessOwnerTx(tx, owner));
    markFakeRunNeverLaunched(f.db, runId);
    const requestId = randomUUID();
    f.db.run(
      `INSERT INTO scheduler_run_requests (id, task_id, idempotency_key, role, model, origin_type, origin_id, status, created_at, updated_at, run_id)
       VALUES ($id, $taskId, $key, $role, 'default', 'TASK_API', $originId, 'DISPATCHED', $now, $now, $runId)`,
      { id: requestId, taskId, key: `task-api:${runId}`, role, originId: runId, now: f.now, runId },
    );
    return { runId, requestId };
  }

  function seedAttempts(f: Fixture, taskId: string, roleLevel: "middle" | "senior", count: number): void {
    for (let i = 1; i <= count; i++) {
      f.db.run(
        `INSERT INTO recovery_attempts (id, task_id, role_level, failure_type, attempt_count, recorded_at)
         VALUES ($id, $taskId, $roleLevel, 'TASK_FAILURE', $attemptCount, $recordedAt)`,
        { id: randomUUID(), taskId, roleLevel, attemptCount: i, recordedAt: f.now },
      );
    }
  }

  it("RED: после исчерпания middle-попыток developer эскалируется в senior_dev", async () => {
    const f = await setup();
    const taskId = await createTask(f);
    seedAttempts(f, taskId, "middle", DEFAULT_POLICY.middleAttempts);
    const { runId } = createFailedSourceRun(f, taskId, "developer");

    const request = f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow);

    expect(request?.role).toBe("senior_dev");
    expect(request?.originType).toBe("TASK_RECOVERY");
    expect(request?.idempotencyKey).toBe(`task-recovery:${runId}`);
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("READY");
    const history = f.service.getHistory(taskId);
    expect(history).toHaveLength(DEFAULT_POLICY.middleAttempts + 1);
    expect(history[0]!.attemptCount).toBe(DEFAULT_POLICY.middleAttempts + 1);
  });

  it("сохраняет ту же роль и тот же keyempotency key при первом сбое developer", async () => {
    const f = await setup();
    const taskId = await createTask(f);
    const { runId } = createFailedSourceRun(f, taskId, "developer");

    const request = f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow);

    expect(request?.role).toBe("developer");
    expect(request?.idempotencyKey).toBe(`task-recovery:${runId}`);
    expect(f.service.getHistory(taskId)).toHaveLength(1);
  });

  it("RED: после исчерпания senior-попыток coordinator-диагностика без нового request и перевод задачи в FAILED", async () => {
    const f = await setup();
    const taskId = await createTask(f);
    seedAttempts(f, taskId, "senior", DEFAULT_POLICY.seniorAttempts);
    const { runId } = createFailedSourceRun(f, taskId, "senior_dev");

    const request = f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow);

    expect(request).toBeUndefined();
    expect(f.db.get("SELECT id FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY' AND origin_id=$id", { id: runId })).toBeUndefined();
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("FAILED");
    expect(f.service.getHistory(taskId)).toHaveLength(DEFAULT_POLICY.seniorAttempts + 1);
  });

  it("RED: повторная обработка финального решения не дублирует записи истории", async () => {
    const f = await setup();
    const taskId = await createTask(f);
    seedAttempts(f, taskId, "senior", DEFAULT_POLICY.seniorAttempts);
    const { runId } = createFailedSourceRun(f, taskId, "senior_dev");

    expect(f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow)).toBeUndefined();
    expect(f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow)).toBeUndefined();

    expect(f.service.getHistory(taskId)).toHaveLength(DEFAULT_POLICY.seniorAttempts + 1);
  });

  it("RED: эскалация стадии без senior-варианта роли не создаёт новый request, но фиксирует решение", async () => {
    const f = await setup();
    const taskId = await createTask(f, "REVIEW");
    seedAttempts(f, taskId, "middle", DEFAULT_POLICY.middleAttempts);
    const { runId } = createFailedSourceRun(f, taskId, "reviewer");

    const request = f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow);

    expect(request).toBeUndefined();
    expect(f.db.get("SELECT id FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY' AND origin_id=$id", { id: runId })).toBeUndefined();
    expect(f.service.getHistory(taskId)).toHaveLength(DEFAULT_POLICY.middleAttempts + 1);
  });

  it("повторный enqueue после эскалации возвращает прежний request без дублирования записей", async () => {
    const f = await setup();
    const taskId = await createTask(f);
    seedAttempts(f, taskId, "middle", DEFAULT_POLICY.middleAttempts);
    const { runId } = createFailedSourceRun(f, taskId, "developer");

    const first = f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow);
    const second = f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow);

    expect(first?.id).toBe(second?.id);
    expect(f.service.getHistory(taskId)).toHaveLength(DEFAULT_POLICY.middleAttempts + 1);
  });

  it("Epic-owned задача по-прежнему отклоняется recovery", async () => {
    const f = await setup();
    const taskId = await createTask(f);
    const epicId = randomUUID();
    f.db.run(
      "INSERT INTO epics(id,project_id,display_id,title,contract_json,status,created_at,updated_at) VALUES($id,$projectId,$id,'Epic',$contract,'OPEN',$now,$now)",
      { id: epicId, projectId: f.projectId, contract: JSON.stringify({ version: 1, goal: "Epic goal" }), now: f.now },
    );
    f.db.run("UPDATE tasks SET epic_id=$epicId WHERE id=$id", { id: taskId, epicId });
    const { runId } = createFailedSourceRun(f, taskId, "developer");

    expect(f.service.enqueueTaskRetry(runId, f.scheduler, f.workflow)).toBeUndefined();
    expect(f.db.get("SELECT id FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY'")).toBeUndefined();
  });
});
