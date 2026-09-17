-- v12 was released with scheduler_capacity_reservations.  This migration may
-- run immediately after that immutable schema, so establish the destination
-- tables first.  The following migration transfers and removes the sources.
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
