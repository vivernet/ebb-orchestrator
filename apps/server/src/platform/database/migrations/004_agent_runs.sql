-- Agent runs table

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  task_id TEXT,
  epic_id TEXT,
  status TEXT NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED','IN_PROGRESS','COMPLETING','COMPLETED','FAILED','CANCELLED')),
  capability_ref TEXT UNIQUE,
  session_id TEXT,
  attempt INTEGER,
  trigger_reason TEXT,
  context_version TEXT,
  output_schema_version TEXT,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  output TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task_id ON agent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_epic_id ON agent_runs(epic_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
