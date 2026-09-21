import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";

const baseMigrationNames = [
  "001_system.sql",
  "002_work_domain.sql",
  "003_work_control.sql",
  "005_scheduler.sql",
];

const baseMigrations: Migration[] = baseMigrationNames.map((name) => ({
  version: Number(name.slice(0, 3)),
  name: name.slice(0, -4),
  sql: readFileSync(
    join(import.meta.dirname, `../../../src/platform/database/migrations/${name}`),
    "utf8",
  ),
}));

const legacyMigration012: Migration = {
  version: 12,
  name: "012_epic_runtime_authority",
  // Это неизменяемый SQL, применённый в развернутых базах v12. Мы намеренно
  // сохраняем его здесь, чтобы тест обновления не скрывал историческую форму.
  sql: `CREATE TABLE IF NOT EXISTS orchestration_phase_runs (
    id TEXT PRIMARY KEY, epic_id TEXT, task_id TEXT, phase TEXT NOT NULL,
    role TEXT NOT NULL, agent_run_id TEXT NOT NULL UNIQUE,
    result_json TEXT NOT NULL DEFAULT '{}', evidence_json TEXT NOT NULL DEFAULT '{}',
    validated INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'INTENT',
    request_json TEXT, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL,
    UNIQUE (epic_id, task_id, phase)
  );
  CREATE INDEX IF NOT EXISTS idx_phase_runs_task ON orchestration_phase_runs(task_id);
  CREATE INDEX IF NOT EXISTS idx_phase_runs_epic ON orchestration_phase_runs(epic_id);
  CREATE TABLE IF NOT EXISTS scheduler_capacity_reservations (
    task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    reserved_at TEXT NOT NULL, estimate_cost REAL NOT NULL DEFAULT 0, run_id TEXT,
    status TEXT NOT NULL DEFAULT 'RESERVED', actual_cost REAL, approval_id TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_capacity_reservations_project ON scheduler_capacity_reservations(project_id);
  CREATE TABLE IF NOT EXISTS scheduler_budgets (
    project_id TEXT PRIMARY KEY, limit_cost REAL NOT NULL, spent_cost REAL NOT NULL DEFAULT 0,
    reserved_cost REAL NOT NULL DEFAULT 0, FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  ALTER TABLE git_operations ADD COLUMN approval_id TEXT;
  ALTER TABLE git_operations ADD COLUMN source_sha TEXT;
  ALTER TABLE git_operations ADD COLUMN expected_target_sha TEXT;
  ALTER TABLE git_operations ADD COLUMN resulting_target_sha TEXT;
  CREATE INDEX IF NOT EXISTS idx_git_operations_epic_approval ON git_operations(approval_id, target_ref, status);`,
};

const forwardMigrations: Migration[] = [13, 14].map((version) => {
  const name = version === 13 ? "013_remove_legacy_scheduler_locks" : "014_migrate_legacy_scheduler_authority";
  return {
    version,
    name,
    sql: readFileSync(join(import.meta.dirname, `../../../src/platform/database/migrations/${name}.sql`), "utf8"),
  };
});

function createV12Prerequisites(db: Database): void {
  // Обновление scheduler зависит только от столбцов git-операций, добавленных
  // в v12; оставляем этот тест сфокусированным на цепочке миграций scheduler.
  db.exec("CREATE TABLE git_operations (id TEXT PRIMARY KEY, target_ref TEXT, status TEXT)");
}

describe("scheduler lock compatibility migration", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("upgrades the original v12 scheduler authority without schema failures or data loss", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));

    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const secondTaskId = randomUUID();
    const lockedAt = "2026-09-17T12:00:00.000Z";
  // Некоторые развернутые legacy-базы принимали по одной строке на ключ ресурса
  // задачи, хотя позднее исходная bootstrap-схема документировала ограничение
  // уникальности на уровне task. Воспроизводим здесь такое сохранённое состояние.
    db.exec("DROP TABLE resource_locks");
    db.exec(`CREATE TABLE resource_locks (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, locked_at TEXT NOT NULL,
      owner_id TEXT NOT NULL
    )`);
    db.run(
      "INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'p','p',$at,$at)",
      { id: projectId, at: lockedAt },
    );
    db.run(
      "INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-1','task','{}',$at,$at)",
      { id: taskId, project: projectId, at: lockedAt },
    );
    db.run(
      "INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-2','task','{}',$at,$at)",
      { id: secondTaskId, project: projectId, at: lockedAt },
    );
    db.run(
      "INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('global',$task,$at,'task-owner')",
      { task: taskId, at: lockedAt },
    );
    db.run(
      "INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('repository:alpha',$task,$at,'task-owner')",
      { task: taskId, at: lockedAt },
    );
    db.run(
      `INSERT INTO scheduler_capacity_reservations(task_id,project_id,owner_id,reserved_at,estimate_cost,run_id,status,actual_cost,approval_id)
       VALUES($task,$project,'task-owner',$at,3.5,'run-1','RESERVED',NULL,'approval-1')`,
      { task: taskId, project: projectId, at: lockedAt },
    );

    expect(runMigrations(db, forwardMigrations).applied).toBe(2);
    expect(
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_locks'"),
    ).toBeUndefined();
    expect(
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_capacity_reservations'"),
    ).toBeUndefined();
    expect(
      db.get<{ kind: string; subject_id: string; project_id: string; estimate_cost: number; run_id: string | null }>(
        "SELECT kind,subject_id,project_id,estimate_cost,run_id FROM scheduler_reservations WHERE subject_id=$subject",
        { subject: taskId },
      ),
    ).toEqual({ kind: "TASK", subject_id: taskId, project_id: projectId, estimate_cost: 3.5, run_id: "run-1" });
    expect(
      db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND (subject_id=$task OR subject_id='lock:' || $task)",
        { task: taskId },
      ),
    ).toEqual({ count: 1 });
    expect(
      db.get<{ reservation_id: string; owner_id: string }>(
        "SELECT reservation_id,owner_id FROM scheduler_resource_locks WHERE resource_key=$key",
        { key: "global" },
      ),
    ).toEqual({ reservation_id: expect.any(String), owner_id: "task-owner" });
    expect(
      db.get<{ reservation_id: string; owner_id: string }>(
        "SELECT reservation_id,owner_id FROM scheduler_resource_locks WHERE resource_key=$key",
        { key: "repository:alpha" },
      ),
    ).toEqual({ reservation_id: expect.any(String), owner_id: "task-owner" });

    db.run("UPDATE tasks SET status='READY' WHERE id=$id", { id: secondTaskId });
    const scheduler = new SchedulerService(db);
    const workflow = { transitionInTransaction: () => undefined } as never;
    expect(() => scheduler.dispatchTask(secondTaskId, workflow, () => undefined)).toThrow(/WAITING_FOR_RESOURCE_LOCK/);

    db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, cost REAL, task_id TEXT, started_at TEXT)");
    db.run("INSERT INTO agent_runs(id,status,cost,task_id,started_at) VALUES('run-1','COMPLETED',0,$task,$at)", { task: taskId, at: lockedAt });
    db.run("UPDATE tasks SET status='DONE' WHERE id=$id", { id: taskId });
    db.run("UPDATE scheduler_resource_locks SET owner_id='unexpected-owner' WHERE resource_key='global'");
    expect(scheduler.reconcile().blockedReservationIds).toContain(`legacy-capacity:${taskId}`);
    expect(db.get("SELECT resource_key FROM scheduler_resource_locks WHERE resource_key='global'")).toBeDefined();
    db.run("UPDATE scheduler_resource_locks SET owner_id='task-owner' WHERE resource_key='global'");
    expect(scheduler.reconcile().releasedReservationIds).toContain(`legacy-capacity:${taskId}`);
    expect(db.get("SELECT resource_key FROM scheduler_resource_locks WHERE resource_key='global'")).toBeUndefined();
  });

  it("groups multiple locks into one synthetic reservation when capacity was absent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-no-capacity-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));

    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    db.exec("DROP TABLE resource_locks");
    db.exec(`CREATE TABLE resource_locks (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, locked_at TEXT NOT NULL,
      owner_id TEXT NOT NULL
    )`);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const lockedAt = "2026-09-17T12:00:00.000Z";
    db.run(
      "INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'p','p',$at,$at)",
      { id: projectId, at: lockedAt },
    );
    db.run(
      "INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-1','task','{}',$at,$at)",
      { id: taskId, project: projectId, at: lockedAt },
    );
    db.run(
      "INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('global',$task,$at,'legacy-owner')",
      { task: taskId, at: lockedAt },
    );
    db.run(
      "INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('repository:alpha',$task,$at,'different-owner')",
      { task: taskId, at: lockedAt },
    );

    expect(runMigrations(db, forwardMigrations).applied).toBe(2);
    expect(db.all("SELECT id FROM scheduler_reservations WHERE subject_id LIKE 'lock:%'")).toHaveLength(1);
    expect(
      db.all<{ resource_key: string; reservation_id: string; owner_id: string }>(
        "SELECT resource_key,reservation_id,owner_id FROM scheduler_resource_locks ORDER BY resource_key",
      ),
    ).toEqual([
      { resource_key: "global", reservation_id: "legacy-lock:" + taskId, owner_id: "legacy-owner" },
      { resource_key: "repository:alpha", reservation_id: "legacy-lock:" + taskId, owner_id: "different-owner" },
    ]);
    const scheduler = new SchedulerService(db);
    db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, cost REAL, task_id TEXT, started_at TEXT)");
    db.run("UPDATE tasks SET status='DONE' WHERE id=$id", { id: taskId });
    expect(scheduler.reconcile().blockedReservationIds).toContain("legacy-lock:" + taskId);
    db.run("UPDATE scheduler_resource_locks SET owner_id='different-owner'");
    expect(scheduler.reconcile().releasedReservationIds).toContain("legacy-lock:" + taskId);
  });

  it("aborts when a no-capacity lock collides with a task-subject reservation", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-task-collision-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const at = "2026-09-17T12:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'p','p',$at,$at)", { id: projectId, at });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-1','task','{}',$at,$at)", { id: taskId, project: projectId, at });
    db.run("INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('global',$task,$at,'legacy-owner')", { task: taskId, at });
    runMigrations(db, [forwardMigrations[0]!]);
    db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,role,model) VALUES('unrelated','TASK',$task,$project,'other-owner',$at,'developer','default')", { task: taskId, project: projectId, at });

    expect(() => runMigrations(db!, [forwardMigrations[1]!])).toThrow(/CHECK constraint failed/);
    expect(db.get("SELECT id FROM resource_locks WHERE id='global'")).toBeDefined();
    expect(db.get("SELECT version FROM schema_migrations WHERE version=14")).toBeUndefined();
  });

  it("rejects unsafe no-capacity collision without partial synthetic state", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-no-capacity-collision-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);

    const projectId = randomUUID();
    const taskId = randomUUID();
    const at = "2026-09-17T12:00:00.000Z";

    db.run(
      "INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'p','p',$at,$at)",
      { id: projectId, at },
    );
    db.run(
      "INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-1','task','{}',$at,$at)",
      { id: taskId, project: projectId, at },
    );

  // Legacy-блокировка ресурса: global → task-1, owner-A.
    db.run(
      "INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('global',$task,$at,'owner-A')",
      { task: taskId, at },
    );

  // Применяем миграцию 013 (создаёт пустые целевые таблицы).
    runMigrations(db, [forwardMigrations[0]!]);

  // Добавляем НЕСВЯЗАННОЕ существующее резервирование, где subject_id = task_id.
  // Это НЕ ожидаемое legacy-резервирование блокировки (id = 'legacy-lock:<task_id>',
  // subject_id = 'lock:<task_id>'). Миграция должна отклонить его, а не использовать повторно.
    db.run(
      "INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,role,model)" +
        " VALUES('unrelated','TASK',$task,$project,'other-owner',$at,'developer','default')",
      { task: taskId, project: projectId, at },
    );

  // Миграция 014 должна прерваться из-за нарушения CHECK-ограничения completeness guard.
    expect(() => runMigrations(db!, [forwardMigrations[1]!])).toThrow(/CHECK constraint failed/);

  // 1. Исходная таблица resource_locks всё ещё существует.
    expect(
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_locks'"),
    ).toBeDefined();

  // 2. Строка legacy-блокировки 'global' всё ещё существует в resource_locks.
    expect(db.get<{ id: string }>("SELECT id FROM resource_locks WHERE id='global'")).toEqual({
      id: "global",
    });

  // 3. К НЕСВЯЗАННОМУ резервированию не прикреплён scheduler_resource_lock.
    expect(
      db.get("SELECT resource_key FROM scheduler_resource_locks WHERE resource_key='global'"),
    ).toBeUndefined();

  // 4. Частичное синтетическое резервирование НЕ создано (нет строки 'legacy-lock:').
    expect(
      db.get("SELECT id FROM scheduler_reservations WHERE id LIKE 'legacy-lock:%'"),
    ).toBeUndefined();

  // 5. Несвязанное резервирование не изменилось.
    expect(
      db.get<{ id: string }>(
        "SELECT id FROM scheduler_reservations WHERE id='unrelated' AND subject_id=$task",
        { task: taskId },
      ),
    ).toEqual({ id: "unrelated" });

  // 6. Исходные таблицы НЕ удалены.
    expect(
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_locks'"),
    ).toBeDefined();
    expect(
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_capacity_reservations'",
      ),
    ).toBeDefined();

  // 7. Миграция не записана.
    expect(db.get("SELECT version FROM schema_migrations WHERE version=14")).toBeUndefined();

  // 8. Таблица completeness guard очищена (изменения откатились).
    expect(
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_014_completeness_guard'",
      ),
    ).toBeUndefined();
  });

  it("aborts without dropping orphaned legacy locks", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-orphan-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));

    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    db.exec("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('orphan','missing-task','2026-09-17T12:00:00.000Z','owner')",
    );

    expect(() => runMigrations(db!, forwardMigrations)).toThrow(/CHECK constraint failed/);
    expect(db.get("SELECT id FROM resource_locks WHERE id='orphan'")).toBeDefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_014_completeness_guard'")).toBeUndefined();
    expect(db.get("SELECT version FROM schema_migrations WHERE version=14")).toBeUndefined();
  });

  it("aborts without dropping orphaned legacy capacity reservations", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-capacity-orphan-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));

    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    db.exec("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO scheduler_capacity_reservations(task_id,project_id,owner_id,reserved_at) VALUES('missing-task','missing-project','owner','2026-09-17T12:00:00.000Z')",
    );

    expect(() => runMigrations(db!, forwardMigrations)).toThrow(/CHECK constraint failed/);
    expect(db.get("SELECT task_id FROM scheduler_capacity_reservations WHERE task_id='missing-task'")).toBeDefined();
    expect(db.get("SELECT version FROM schema_migrations WHERE version=14")).toBeUndefined();
  });

  it("aborts instead of discarding conflicting destination capacity data", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-capacity-conflict-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const at = "2026-09-17T12:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'p','p',$at,$at)", { id: projectId, at });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-1','task','{}',$at,$at)", { id: taskId, project: projectId, at });
    db.run("INSERT INTO scheduler_capacity_reservations(task_id,project_id,owner_id,reserved_at,estimate_cost,run_id,status,actual_cost,approval_id) VALUES($task,$project,'legacy-owner',$at,7,'legacy-run','RESERVED',NULL,'legacy-approval')", { task: taskId, project: projectId, at });
    runMigrations(db, [forwardMigrations[0]!]);
    db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,approval_id,run_id) VALUES('existing','TASK',$task,$project,'different-owner',$at,7,'RESERVED','developer','default','legacy-approval','legacy-run')", { task: taskId, project: projectId, at });

    expect(() => runMigrations(db!, [forwardMigrations[1]!])).toThrow(/CHECK constraint failed/);
    expect(db.get("SELECT task_id FROM scheduler_capacity_reservations WHERE task_id=$task", { task: taskId })).toBeDefined();
    expect(db.get("SELECT version FROM schema_migrations WHERE version=14")).toBeUndefined();
  });

  it("aborts instead of discarding conflicting destination lock data", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-lock-conflict-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const at = "2026-09-17T12:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'p','p',$at,$at)", { id: projectId, at });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-1','task','{}',$at,$at)", { id: taskId, project: projectId, at });
    db.run("INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('global',$task,$at,'legacy-owner')", { task: taskId, at });
    runMigrations(db, [forwardMigrations[0]!]);
    db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model) VALUES('existing','LOCK',$subject,$project,'legacy-owner',$at,0,'RESERVED','lock','legacy')", { subject: `lock:${taskId}`, project: projectId, at });
    db.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('global','existing',$project,'different-owner',$at)", { project: projectId, at });

    expect(() => runMigrations(db!, [forwardMigrations[1]!])).toThrow(/CHECK constraint failed/);
    expect(db.get("SELECT id FROM resource_locks WHERE id='global'")).toBeDefined();
    expect(db.get("SELECT version FROM schema_migrations WHERE version=14")).toBeUndefined();
  });

  it("aborts when a lock mapping points to an unrelated reservation with matching visible fields", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-migration-lock-association-conflict-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    runMigrations(db, [legacyMigration012]);
    const projectId = randomUUID();
    const taskId = randomUUID();
    const at = "2026-09-17T12:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'p','p',$at,$at)", { id: projectId, at });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES($id,$project,'TASK-1','task','{}',$at,$at)", { id: taskId, project: projectId, at });
    db.run("INSERT INTO resource_locks(id,task_id,locked_at,owner_id) VALUES('global',$task,$at,'legacy-owner')", { task: taskId, at });
    runMigrations(db, [forwardMigrations[0]!]);
    db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model) VALUES('unrelated','LOCK',$subject,$project,'legacy-owner',$at,0,'RESERVED','lock','legacy')", { subject: `lock:${taskId}`, project: projectId, at });
    db.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('global','unrelated',$project,'legacy-owner',$at)", { project: projectId, at });

    expect(() => runMigrations(db!, [forwardMigrations[1]!])).toThrow(/CHECK constraint failed/);
    expect(db.get("SELECT id FROM resource_locks WHERE id='global'")).toBeDefined();
    expect(db.get("SELECT version FROM schema_migrations WHERE version=14")).toBeUndefined();
  });

  it("passes the fresh migration chain", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-fresh-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));

    runMigrations(db, baseMigrations);
    createV12Prerequisites(db);
    const migration012 = readFileSync(join(import.meta.dirname, "../../../src/platform/database/migrations/012_epic_runtime_authority.sql"), "utf8");
    expect(runMigrations(db, [{ version: 12, name: "012_epic_runtime_authority", sql: migration012 }, ...forwardMigrations]).applied).toBe(3);

    expect(
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='resource_locks'"),
    ).toBeUndefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_reservations'"))
      .toBeDefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_resource_locks'"))
      .toBeDefined();
  });
});
