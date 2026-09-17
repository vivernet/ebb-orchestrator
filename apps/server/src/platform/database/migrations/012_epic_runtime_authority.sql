-- Durable orchestration evidence and scheduler reservations.  These records
-- are deliberately separate from process state: a restart must be able to
-- decide whether work may be continued without trusting an in-memory result.
CREATE TABLE IF NOT EXISTS orchestration_phase_runs (
  id TEXT PRIMARY KEY,
  epic_id TEXT,
  task_id TEXT,
  phase TEXT NOT NULL,
  role TEXT NOT NULL,
  agent_run_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  validated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (epic_id, task_id, phase)
);
CREATE INDEX IF NOT EXISTS idx_phase_runs_task ON orchestration_phase_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_phase_runs_epic ON orchestration_phase_runs(epic_id);

CREATE TABLE IF NOT EXISTS scheduler_capacity_reservations (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_capacity_reservations_project ON scheduler_capacity_reservations(project_id);

CREATE TABLE IF NOT EXISTS scheduler_budgets (
  project_id TEXT PRIMARY KEY,
  limit_cost REAL NOT NULL,
  spent_cost REAL NOT NULL DEFAULT 0,
  reserved_cost REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Final merge provenance is part of the operation, not a free-standing journal
-- row.  ALTERs are intentionally also performed by services for old databases.
ALTER TABLE git_operations ADD COLUMN approval_id TEXT;
ALTER TABLE git_operations ADD COLUMN source_sha TEXT;
ALTER TABLE git_operations ADD COLUMN expected_target_sha TEXT;
ALTER TABLE git_operations ADD COLUMN resulting_target_sha TEXT;
CREATE INDEX IF NOT EXISTS idx_git_operations_epic_approval ON git_operations(approval_id, target_ref, status);
