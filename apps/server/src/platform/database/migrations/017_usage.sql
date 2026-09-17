-- Usage domain: usage records, budget configs, and budget reservations.

-- Usage records: each AI Run produces one record with token counts and cost.
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  reservation_id TEXT,
  project_id TEXT NOT NULL,
  epic_id TEXT,
  task_id TEXT,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  rework_category TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  runtime TEXT NOT NULL DEFAULT '',
  actual_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_usage_records_project ON usage_records(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_run ON usage_records(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_reservation ON usage_records(reservation_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_role_model ON usage_records(role, model);

-- Budget configs: hierarchical budget limits (global/project/epic/task).
-- Effective limit is the most restrictive of all matching scopes.
CREATE TABLE IF NOT EXISTS budget_configs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'epic', 'task')),
  scope_id TEXT NOT NULL,
  limit_cost REAL NOT NULL,
  soft_limit_cost REAL NOT NULL DEFAULT 0,
  policy TEXT NOT NULL DEFAULT 'hard' CHECK (policy IN ('soft', 'hard')),
  spent_cost REAL NOT NULL DEFAULT 0,
  reserved_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_configs_scope ON budget_configs(scope, scope_id);

-- Budget reservations: atomic reservations against budget configs.
CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  epic_id TEXT,
  task_id TEXT,
  estimate_cost REAL NOT NULL,
  actual_cost REAL,
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'RECONCILED', 'RELEASED')),
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  rework_category TEXT,
  created_at TEXT NOT NULL,
  reconciled_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_budget_reservations_status ON budget_reservations(status);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_project ON budget_reservations(project_id);
