-- Recovery: tables for tracking recovery attempts and scheduler requests

-- Recovery attempts tracking
CREATE TABLE IF NOT EXISTS recovery_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role_level TEXT NOT NULL,
  failure_type TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  fingerprint TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_task_id ON recovery_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_role_level ON recovery_attempts(role_level);
CREATE INDEX IF NOT EXISTS idx_recovery_attempts_failure_type ON recovery_attempts(failure_type);

-- Recovery scheduler requests (never calls runtime directly)
CREATE TABLE IF NOT EXISTS recovery_scheduler_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role_level TEXT NOT NULL,
  failure_type TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_scheduler_requests_task_id ON recovery_scheduler_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_recovery_scheduler_requests_resolved ON recovery_scheduler_requests(resolved_at);

-- Recovery state (for blocking/flagging tasks)
CREATE TABLE IF NOT EXISTS recovery_state (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS idx_recovery_state_status ON recovery_state(status);
