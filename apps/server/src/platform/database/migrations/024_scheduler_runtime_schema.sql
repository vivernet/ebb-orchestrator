-- Переносит DDL планировщика из runtime-сервисов в append-only schema history.
CREATE TABLE IF NOT EXISTS scheduler_budgets (
  project_id TEXT PRIMARY KEY,
  limit_cost REAL NOT NULL,
  spent_cost REAL NOT NULL DEFAULT 0,
  reserved_cost REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scheduler_usage_history (
  project_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  model TEXT NOT NULL DEFAULT 'default',
  cost REAL NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_reservations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  estimate_cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RESERVED',
  actual_cost REAL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  approval_id TEXT,
  run_id TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_resource_locks (
  resource_key TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  locked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO scheduler_config(id, schema_version, config_json, updated_at)
VALUES (1, 1, '{"globalMax":4,"projectMax":3,"roleCapacity":{"reviewer":4,"developer":4}}', datetime('now'));
