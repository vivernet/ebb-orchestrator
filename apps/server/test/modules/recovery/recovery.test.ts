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
import { evaluateRecovery, countAttempts, getRemainingAttempts } from "../../../src/modules/recovery/recovery-policy.js";
import { createNoProgressFingerprint } from "../../../src/modules/recovery/progress-fingerprint.js";
import type { RecoveryContext } from "../../../src/modules/recovery/recovery-types.js";
import { DEFAULT_POLICY } from "../../../src/modules/recovery/recovery-types.js";

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
 * Creates a recovery context for testing.
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
    // Create a project and task for FK constraint compliance
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
      // Middle tier exhausted after 2 attempts (max is 2)
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
      // Senior tier exhausted after 2 attempts (max is 2)
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

      // Verify it was persisted
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

      // Verify it was persisted (via history check since recovery scheduler is separate)
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

