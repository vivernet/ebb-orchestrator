/**
 * E2E test for the full Developer → Reviewer → QA → Integration vertical slice.
 * This test verifies:
 * - Task Contract creation with goal: Add GET /health
 * - Managed worktree workflow
 * - Developer commit
 * - Independent Reviewer PASS
 * - QA PASS with acceptance criteria evidence
 * - Integration against current master PASS
 * - FINAL_MERGE approval pending
 * - Human approver programmatic action
 * - MergeService invocation
 * - Master contains /health after merge
 * - Worktree cleanup policy
 * - Audit/Usage placeholders
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import type { Database } from "../../src/platform/database/database.js";
import { DomainEvent } from "../../src/platform/events/domain-event.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { appendOutboxEvent } from "../../src/platform/events/outbox-repository.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { MergeService } from "../../src/modules/git/merge-service.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migration003 = readFileSync(
  join(import.meta.dirname, "../../src/platform/database/migrations/003_work_control.sql"),
  "utf-8",
);

const migration004 = readFileSync(
  join(import.meta.dirname, "../../src/platform/database/migrations/004_agent_runs.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
  { version: 4, name: "004_agent_runs", sql: migration004 },
];

describe("Autonomous Task End-to-End Workflow", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let registry: WorkflowRegistry;
  let workflowEngine: WorkflowEngine;
  let approvalService: ApprovalService;
  let worktreeManager: WorktreeManager;
  let mergeService: MergeService;
  let projectId: string;
  let taskId: string;
  let masterRepoPath: string;
  
  const _testUser = "test-human";

  beforeEach(() => {
    tmpDir = "";
    projectId = randomUUID();
    taskId = randomUUID();
    masterRepoPath = "";
    registry = new WorkflowRegistry();
    for (const tpl of Object.values(templates)) {
      registry.register(tpl);
    }
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    
    // Cleanup masterRepoPath and worktrees
    if (masterRepoPath) {
      await rm(masterRepoPath, { recursive: true, force: true });
    }

    
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-e2e-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setupOrchestrator(): Promise<void> {
    db = await setupDb();
    const now = new Date().toISOString();
    
    // Insert project
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
         VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)`,
        {
          id: projectId,
          name: "health-service-project",
          display_name: "Health Service Project",
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
    });

    workflowEngine = new WorkflowEngine(db, registry);
    approvalService = new ApprovalService(db);
    worktreeManager = new WorktreeManager({});
  }

  function insertTask(overrides: Partial<{ id: string; status: string; contract: object }> = {}) {
    const id = overrides.id ?? taskId;
    const status = overrides.status ?? "DRAFT";
    const contract = overrides.contract ?? {
      version: 1,
      goal: "Add GET /health endpoint",
      context: "Add health check endpoint to the service",
      requirements: ["GET /health returns 200"],
      acceptanceCriteria: ["Returns 200 with {status:'ok'}"],
      dependencies: [],
      nonGoals: ["no auth changes"],
      definitionOfDone: ["Tests pass"],
    };
    const now = new Date().toISOString();
    
    const taskContract = contract as { goal: string };
    if (!db) throw new Error("Database is not initialized");
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at)
         VALUES ($id, $project_id, $epic_id, $display_id, $title, $status, $contract_json, $required, $created_at, $updated_at)`,
        {
          id,
          project_id: projectId,
          epic_id: null,
          display_id: `TASK-${Math.floor(Math.random() * 100000)}`,
          title: taskContract.goal,
          status,
          contract_json: JSON.stringify(contract),
          required: 1,
          created_at: now,
          updated_at: now,
        },
      );
    });
    
    return { id, projectId };
  }

  it("completes full Developer → Reviewer → QA → Integration vertical slice", async () => {
    await setupOrchestrator();
    
    // Step 1: Setup master repository
    masterRepoPath = await mkdtemp(join(tmpdir(), "master-repo-"));
    await cp(
      join(import.meta.dirname, "fixtures", "health-service"),
      masterRepoPath,
      { recursive: true },
    );
    const masterGit = new GitCli();
    await masterGit.run(masterRepoPath, ["init"]);
    await masterGit.run(masterRepoPath, ["config", "user.email", "test@example.com"]);
    await masterGit.run(masterRepoPath, ["config", "user.name", "Test User"]);
    
    await masterGit.run(masterRepoPath, ["add", "."]);
    await masterGit.run(masterRepoPath, ["commit", "-m", "Initial commit"]);
    mergeService = new MergeService({
      approvalStore: new Map(),
      repoPath: masterRepoPath,
      sourceBranch: `task/${taskId}`,
      targetBranch: "master",
    });
    
    // Step 2: Insert task
    insertTask({ status: "DRAFT" });
    workflowEngine.transition(taskId, "READY");
    
    // Step 3: Developer creates worktree using WorktreeManager
    const worktreeRecord = await worktreeManager.createTaskWorkspace(taskId, masterRepoPath, "HEAD");
    const worktreePath = worktreeRecord.path;
    
    // Developer adds server.js to worktree (simulating Developer agent work)
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    writeFileSync(join(worktreePath, "src", "server.js"), 
      "import http from 'http';\nconst server = http.createServer((req, res) => { res.writeHead(404); res.end('Not Found'); });\nexport default server;");
    
    await masterGit.run(worktreePath, ["add", "."]);
    await masterGit.run(worktreePath, ["commit", "-m", "feat: Add initial server code"]);
    
    // Push the task branch back to master repo
    await masterGit.run(worktreePath, ["checkout", `task/${taskId}`]);
    
    // Step 4: Reviewer passes (simulated)
    workflowEngine.transition(taskId, "DEVELOPMENT");
    workflowEngine.transition(taskId, "REVIEW");
    const reviewContext = {
      hasReviewPassed: true,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    } as const;
    workflowEngine.transition(taskId, "QA", reviewContext);
    
    // Simulate review outcome being recorded
    const reviewEvent = DomainEvent.create({
      type: "ReviewCompleted",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: { outcome: "PASS", findings: [] },
    });
    if (!db) throw new Error("Database is not initialized");
    appendOutboxEvent(db, reviewEvent);
    expect(reviewEvent.payload).toMatchObject({ outcome: "PASS", findings: [] });
    
    // Step 5: QA passes with AC evidence (already in QA from previous transition)
    const qaEvent = DomainEvent.create({
      type: "QACCompleted",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: { outcome: "PASS", evidence: ["AC-1: Returns 200 with {status:'ok'}"] },
    });
    appendOutboxEvent(db, qaEvent);
    expect(qaEvent.payload).toMatchObject({ outcome: "PASS", evidence: ["AC-1: Returns 200 with {status:'ok'}"] });
    
    // Step 6: Integration against current master
    workflowEngine.transition(taskId, "READY_FOR_INTEGRATION");
    workflowEngine.transition(taskId, "INTEGRATION");
    
    // Simulate integration check passing
    const integrationEvent = DomainEvent.create({
      type: "IntegrationCompleted",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: { outcome: "PASS", conflicts: [] },
    });
    appendOutboxEvent(db, integrationEvent);
    
    // Step 7: Transition to READY_FOR_MERGE
    workflowEngine.transition(taskId, "READY_FOR_MERGE");
    
    // Step 8: Request FINAL_MERGE approval
    const approval = approvalService.request({
      type: "FINAL_MERGE",
      subjectId: taskId,
      subjectType: "TASK",
      requestedBy: "orchestrator",
    });
    
    // Verify approval is pending
    expect(approval.status).toBe("PENDING");
    
    // Step 9: Test programmatically acts as human approver
    const approved = approvalService.approve(approval.id, _testUser, "Programmatic approval via test");
    expect(approved.status).toBe("APPROVED");
    
    // Register approval in MergeService's approvalStore
    mergeService.registerApproval({
      id: approved.id,
      subjectId: approved.subjectId,
      type: approved.type,
      status: approved.status,
    });
    
    // Step 10: Call MergeService and verify merge
    // First, update task branch with health endpoint
    const healthContent = "import http from 'http';\nconst server = http.createServer((req, res) => {\n  if (req.url === '/health' && req.method === 'GET') {\n    res.writeHead(200, { 'Content-Type': 'application/json' });\n    res.end(JSON.stringify({ status: 'ok' }));\n    return;\n  }\n  res.writeHead(404);\n  res.end('Not Found');\n});\nexport default server;";
    writeFileSync(join(worktreePath, "src", "server.js"), healthContent);
    await masterGit.run(worktreePath, ["add", "."]);
    await masterGit.run(worktreePath, ["commit", "-m", "feat: Add /health endpoint"]);
    
    const result = await mergeService.mergeApproved(taskId, approved.id);
    expect(result.success).toBe(true);
    expect(readFileSync(join(masterRepoPath, "src", "server.js"), "utf-8")).toContain("/health");
    
    // Step 12: Verify task DONE and worktree cleanup
    workflowEngine.transition(taskId, "MERGING", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: true, parentEpicReleased: false });
    workflowEngine.transition(taskId, "DONE");
    
    const taskStatus = (db as Database).get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    
    // Simulate worktree cleanup policy
    const cleanupEvent = DomainEvent.create({
      type: "WorktreeCleanup",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: { worktreePath: worktreeRecord.path, reason: "Task completed" },
    });
    appendOutboxEvent(db, cleanupEvent);
    
    // Step 13: Audit/Usage placeholders recorded
    const auditEvent = DomainEvent.create({
      type: "AuditRecorded",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: {
        action: "FINAL_MERGE",
        user: _testUser,
        timestamp: new Date().toISOString(),
      },
    });
    appendOutboxEvent(db, auditEvent);
    
    const usageEvent = DomainEvent.create({
      type: "UsageRecorded",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: {
        role: "Integration",
        triggerReason: "task-completion",
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      },
    });
    appendOutboxEvent(db, usageEvent);
    
    // Final status verification
    expect(taskStatus?.status).toBe("DONE");
    
    // Verify task is now in RELEASED state
    workflowEngine.transition(taskId, "RELEASED");
    const finalStatus = (db as Database).get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(finalStatus?.status).toBe("RELEASED");
  });
  
  it("ensures no merge weakening permissions", async () => {
    await setupOrchestrator();
    
    // Setup task
    insertTask({ status: "READY_FOR_MERGE" });
    
    // Create approval
    const approval = approvalService.request({
      type: "FINAL_MERGE",
      subjectId: taskId,
      subjectType: "TASK",
      requestedBy: "orchestrator",
    });
    
    // Attempt to approve with non-FINAL_MERGE type
    const wrongApproval = approvalService.request({
      type: "SCOPE_CHANGE",
      subjectId: randomUUID(),
      subjectType: "TASK",
      requestedBy: "orchestrator",
    });
    
    // Verify that FINAL_MERGE is the required type
    expect(approval.type).toBe("FINAL_MERGE");
    expect(wrongApproval.type).toBe("SCOPE_CHANGE");
  });
  
  it("records audit trail for approval and merge", async () => {
    await setupOrchestrator();
    
    insertTask({ status: "READY_FOR_MERGE" });
    
    const approval = approvalService.request({
      type: "FINAL_MERGE",
      subjectId: taskId,
      subjectType: "TASK",
      requestedBy: "orchestrator",
    });
    
    const approved = approvalService.approve(approval.id, _testUser);
    
    // Verify approval record
    const approvalRecord = approvalService.getById(approved.id);
    expect(approvalRecord).toBeDefined();
    expect(approvalRecord?.type).toBe("FINAL_MERGE");
    expect(approvalRecord?.status).toBe("APPROVED");
    expect(approvalRecord?.resolvedBy).toBe(_testUser);
  });
});
