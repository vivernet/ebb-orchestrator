-- Scheduler: resource locks table

CREATE TABLE IF NOT EXISTS resource_locks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_locks_task_id ON resource_locks(task_id);

-- Add wait_reason column to tasks for UI projection
ALTER TABLE tasks ADD COLUMN wait_reason TEXT;
