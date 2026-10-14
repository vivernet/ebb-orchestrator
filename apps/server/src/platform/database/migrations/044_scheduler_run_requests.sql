-- Durable intent for user-originated Task dispatches. Epic phase runs retain
-- their existing orchestration_phase_runs lifecycle.
CREATE TABLE scheduler_run_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  origin_type TEXT NOT NULL CHECK (origin_type IN ('TASK_API', 'TASK_RECOVERY')),
  origin_id TEXT NOT NULL CHECK (length(trim(origin_id)) > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DISPATCHED', 'FAILED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_id TEXT,
  failure_code TEXT,
  CHECK ((status = 'DISPATCHED' AND run_id IS NOT NULL AND failure_code IS NULL)
      OR (status = 'FAILED' AND failure_code IS NOT NULL)
      OR (status = 'PENDING' AND run_id IS NULL AND failure_code IS NULL)),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_scheduler_run_requests_idempotency
  ON scheduler_run_requests(idempotency_key);

CREATE UNIQUE INDEX idx_scheduler_run_requests_pending_task
  ON scheduler_run_requests(task_id) WHERE status = 'PENDING';

CREATE INDEX idx_scheduler_run_requests_queue
  ON scheduler_run_requests(status, created_at, id);
