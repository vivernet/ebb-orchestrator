import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { RuntimeEventHandlers } from "../../../src/modules/runtime/run-event-handlers.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../../src/modules/workflow/templates.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { FindingsService } from "../../../src/modules/work/findings-service.js";
import { DefectsService } from "../../../src/modules/work/defects-service.js";
import type { RunOutcome } from "../../../src/modules/runtime/run-types.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

describe("Reviewer and QA quality output projection", () => {
  let db: Database | undefined;
  let tempDirectory: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  });

  async function setup() {
    tempDirectory = await mkdtemp(join(tmpdir(), "ebb-quality-projection-"));
    db = createSqliteDatabase(join(tempDirectory, "test.db"));
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    const now = new Date().toISOString();
    const contract = JSON.stringify({ version: 1, goal: "test", context: "", requirements: [], acceptanceCriteria: ["criterion one"], dependencies: [], nonGoals: [], definitionOfDone: [] });
    db.transaction((tx) => {
      tx.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'test','Test','ACTIVE',$now,$now)", { id: projectId, now });
      for (const [id, displayId] of [[taskId, "TASK-1"], [otherTaskId, "TASK-2"]] as const) {
        tx.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($id,$projectId,NULL,$displayId,'Test task',$status,$contract,1,$now,$now)", {
          id, projectId, displayId, status: id === taskId ? "REVIEW" : "REVIEW", contract, now,
        });
      }
    });
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const handlers = new RuntimeEventHandlers(db, new WorkflowEngine(db, registry), new SchedulerService(db));
    return { db, projectId, taskId, otherTaskId, handlers };
  }

  function insertCompletedRun(database: Database, taskId: string, role: "reviewer" | "qa", output: unknown, contextRecordIds: readonly string[] = []): string {
    const runId = randomUUID();
    database.run("INSERT INTO agent_runs(id,role,runtime,model,task_id,status,output) VALUES($id,$role,'test','test',$taskId,'COMPLETED',$output)", {
      id: runId, role, taskId, output: JSON.stringify(output),
    });
    if (contextRecordIds.length > 0) {
      database.run(`INSERT INTO context_manifests(
        id,run_id,subject_type,task_id,epic_id,request_id,role,contract_request_digest,
        items_json,prompt_hash,context_hash,context_builder_version,initial_token_size,created_at
      ) VALUES($id,$runId,'TASK',$taskId,NULL,NULL,$role,NULL,$itemsJson,$promptHash,$contextHash,'test',NULL,$now)`, {
        id: randomUUID(), runId, taskId, role, itemsJson: JSON.stringify(contextRecordIds.map((id) => ({ id, version: null, digest: null }))),
        promptHash: "a".repeat(64), contextHash: "b".repeat(64), now: new Date().toISOString(),
      });
    }
    return runId;
  }

  function complete(handlers: RuntimeEventHandlers, runId: string, output: unknown): void {
    const result = JSON.stringify(output);
    const outcome: RunOutcome = {
      success: true,
      exitCode: 0,
      output: result,
      validatedSubmission: true,
      diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    };
    handlers.handleRuntimeCompletion(runId, outcome);
  }

  it("creates stable Reviewer findings as part of the accepted completion projection", async () => {
    const f = await setup();
    const output = { version: "1.0.0", outcome: "CHANGES_REQUESTED", findings: [{ type: "MAJOR", description: "Handle missing input", file: "src/input.ts", line: 12 }] };
    const runId = insertCompletedRun(f.db, f.taskId, "reviewer", output);

    complete(f.handlers, runId, output);

    expect(f.db.get<{ display_id: string; source_run_id: string; severity: string; blocking: number; title: string; status: string }>(
      "SELECT display_id,source_run_id,severity,blocking,title,status FROM findings WHERE task_id=$taskId", { taskId: f.taskId },
    )).toMatchObject({ display_id: "FINDING-1", source_run_id: runId, severity: "HIGH", blocking: 0, title: "Handle missing input", status: "OPEN" });
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$taskId", { taskId: f.taskId })?.status).toBe("FAILED");
  });

  it("updates only explicitly referenced Reviewer findings owned by the Task", async () => {
    const f = await setup();
    const findings = new FindingsService(f.db);
    const target = findings.createFinding(f.projectId, f.taskId, {
      sourceRunId: "seed-review", severity: "HIGH", blocking: false,
      title: "Existing", description: "Existing detail", guidelineRef: null, evidenceSignature: "seed",
    });
    const foreign = findings.createFinding(f.projectId, f.otherTaskId, {
      sourceRunId: "seed-review", severity: "HIGH", blocking: false,
      title: "Foreign", description: "Foreign detail", guidelineRef: null, evidenceSignature: "foreign",
    });
    const output = { version: "1.0.0", outcome: "PASS", finding_updates: [{ id: target.displayId, status: "RESOLVED" }] };
    const runId = insertCompletedRun(f.db, f.taskId, "reviewer", output, [target.id]);

    complete(f.handlers, runId, output);

    expect(f.db.get<{ status: string; source_run_id: string }>("SELECT status,source_run_id FROM findings WHERE id=$id", { id: target.id })).toEqual({ status: "RESOLVED", source_run_id: runId });
    expect(f.db.get<{ status: string }>("SELECT status FROM findings WHERE id=$id", { id: foreign.id })?.status).toBe("OPEN");
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM findings WHERE task_id=$taskId", { taskId: f.taskId })?.count).toBe(1);
  });

  it("rejects a same-Task Reviewer ID omitted from the current Run context", async () => {
    const f = await setup();
    const target = new FindingsService(f.db).createFinding(f.projectId, f.taskId, {
      sourceRunId: "seed-review", severity: "HIGH", blocking: false,
      title: "Existing", description: "Existing detail", guidelineRef: null, evidenceSignature: "seed",
    });
    const output = { version: "1.0.0", outcome: "PASS", finding_updates: [{ id: target.displayId, status: "RESOLVED" }] };
    const runId = insertCompletedRun(f.db, f.taskId, "reviewer", output);

    expect(() => complete(f.handlers, runId, output)).toThrow("REVIEW_FINDING_REFERENCE_NOT_IN_CONTEXT");
    expect(f.db.get<{ status: string }>("SELECT status FROM findings WHERE id=$id", { id: target.id })?.status).toBe("OPEN");
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM run_completion_projections WHERE run_id=$runId", { runId })?.count).toBe(0);
  });

  it("rolls back earlier quality updates when a later Reviewer reference is not owned by the Task", async () => {
    const f = await setup();
    const findings = new FindingsService(f.db);
    const target = findings.createFinding(f.projectId, f.taskId, {
      sourceRunId: "seed-review", severity: "HIGH", blocking: false,
      title: "Owned", description: "Owned detail", guidelineRef: null, evidenceSignature: "owned",
    });
    const foreign = findings.createFinding(f.projectId, f.otherTaskId, {
      sourceRunId: "seed-review", severity: "HIGH", blocking: false,
      title: "Foreign", description: "Foreign detail", guidelineRef: null, evidenceSignature: "foreign",
    });
    const output = { version: "1.0.0", outcome: "PASS", finding_updates: [
      { id: target.displayId, status: "RESOLVED" }, { id: foreign.displayId, status: "STILL_PRESENT" },
    ] };
    const runId = insertCompletedRun(f.db, f.taskId, "reviewer", output, [target.id]);

    expect(() => complete(f.handlers, runId, output)).toThrow(/NOT_OWNED/);
    expect(f.db.get<{ status: string }>("SELECT status FROM findings WHERE id=$id", { id: target.id })?.status).toBe("OPEN");
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$taskId", { taskId: f.taskId })?.status).toBe("REVIEW");
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM run_completion_projections WHERE run_id=$runId", { runId })?.count).toBe(0);
  });

  it("creates one QA defect per Task and acceptance criterion, without implicit updates", async () => {
    const f = await setup();
    f.db.run("UPDATE tasks SET status='QA' WHERE id=$taskId", { taskId: f.taskId });
    const output = { version: "1.0.0", outcome: "FAIL", failedCriteria: [{ id: "AC-1", required: true, description: "Untrusted model description" }] };
    const runId = insertCompletedRun(f.db, f.taskId, "qa", output);

    complete(f.handlers, runId, output);

    const defects = new DefectsService(f.db);
    const created = defects.getDefectsByTaskId(f.db, f.taskId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ displayId: "DEFECT-1", sourceRunId: runId, acceptanceCriterionRef: "AC-1", title: "AC-1", description: "Untrusted model description", severity: "BLOCKING", blocking: true, status: "OPEN" });

    f.db.run("UPDATE defects SET status='RESOLVED' WHERE id=$id", { id: created[0]!.id });
    f.db.run("UPDATE tasks SET status='QA' WHERE id=$taskId", { taskId: f.taskId });
    const repeatedRunId = insertCompletedRun(f.db, f.taskId, "qa", output);
    complete(f.handlers, repeatedRunId, output);
    expect(defects.getDefectsByTaskId(f.db, f.taskId)).toHaveLength(1);
    expect(defects.getDefectsByTaskId(f.db, f.taskId)[0]?.status).toBe("RESOLVED");
  });

  it("applies explicit QA defect updates atomically and rejects another Task's ID", async () => {
    const f = await setup();
    const defects = new DefectsService(f.db);
    const target = defects.createDefect(f.projectId, f.taskId, {
      sourceRunId: "seed-qa", severity: "BLOCKING", blocking: true, title: "AC-1", description: "criterion one",
      acceptanceCriterionRef: "AC-1", evidenceSignature: "seed",
    });
    const foreign = defects.createDefect(f.projectId, f.otherTaskId, {
      sourceRunId: "seed-qa", severity: "BLOCKING", blocking: true, title: "AC-1", description: "criterion one",
      acceptanceCriterionRef: "AC-1", evidenceSignature: "foreign",
    });
    f.db.run("UPDATE tasks SET status='QA' WHERE id=$taskId", { taskId: f.taskId });
    const output = { version: "1.0.0", outcome: "PASS", defect_updates: [
      { id: target.displayId, status: "RESOLVED" }, { id: foreign.displayId, status: "STILL_PRESENT" },
    ] };
    const runId = insertCompletedRun(f.db, f.taskId, "qa", output, [target.id]);

    expect(() => complete(f.handlers, runId, output)).toThrow(/NOT_OWNED/);
    expect(f.db.get<{ status: string }>("SELECT status FROM defects WHERE id=$id", { id: target.id })?.status).toBe("OPEN");
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$taskId", { taskId: f.taskId })?.status).toBe("QA");
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM run_completion_projections WHERE run_id=$runId", { runId })?.count).toBe(0);
  });

  it("applies an explicit QA update to an active defect included in the current Run context", async () => {
    const f = await setup();
    const defects = new DefectsService(f.db);
    const target = defects.createDefect(f.projectId, f.taskId, {
      sourceRunId: "seed-qa", severity: "BLOCKING", blocking: true, title: "AC-1", description: "criterion one",
      acceptanceCriterionRef: "AC-1", evidenceSignature: "seed",
    });
    f.db.run("UPDATE tasks SET status='QA' WHERE id=$taskId", { taskId: f.taskId });
    const output = { version: "1.0.0", outcome: "PASS", defect_updates: [{ id: target.displayId, status: "RESOLVED" }] };
    const runId = insertCompletedRun(f.db, f.taskId, "qa", output, [target.id]);

    complete(f.handlers, runId, output);

    expect(f.db.get<{ status: string; source_run_id: string }>("SELECT status,source_run_id FROM defects WHERE id=$id", { id: target.id }))
      .toEqual({ status: "RESOLVED", source_run_id: runId });
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM run_completion_projections WHERE run_id=$runId", { runId })?.count).toBe(1);
  });
});
