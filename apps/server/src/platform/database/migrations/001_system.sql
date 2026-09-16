PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS processed_events (
  consumer_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (consumer_name, event_id),
  FOREIGN KEY (event_id) REFERENCES outbox_events(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','DEAD_LETTER')),
  run_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  content_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STAGING' CHECK (status IN ('STAGING','ACTIVE','EXPIRED','MISSING')),
  project_id TEXT,
  task_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events(processed_at, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_runnable
  ON background_jobs(status, run_after, priority DESC, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_dedupe
  ON background_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING','RETRY_WAIT');
CREATE INDEX IF NOT EXISTS idx_artifacts_scope
  ON artifacts(project_id, task_id, run_id);
