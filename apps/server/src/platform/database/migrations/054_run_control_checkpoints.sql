-- Управление Run: durable команды, доказанные checkpoint-и и orthogonal overlay паузы.
-- Хранятся только хэши/opaque ссылки; transcript, credentials и raw stdout никогда не пишутся.

-- Durable намерения команд: idempotency по request_id + optimistic CAS по версии состояния.
CREATE TABLE run_control_commands (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  command TEXT NOT NULL CHECK (command IN ('CHECKPOINT','PAUSE','RESUME')),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('REQUESTED','COMPLETED','FAILED')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, attempt, request_id),
  UNIQUE (request_id, run_id, attempt)
);

-- Доказанный durable checkpoint: только доказанная provenance, без transcript/credentials.
CREATE TABLE run_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  containment_ref TEXT NOT NULL,
  launch_nonce_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  workspace_snapshot_hash TEXT NOT NULL,
  event_cursor TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, attempt, request_id),
  UNIQUE (id, run_id, attempt),
  FOREIGN KEY (request_id, run_id, attempt) REFERENCES run_control_commands(request_id, run_id, attempt)
);

-- Orthogonal durable overlay паузы; agent_runs.status остаётся в своём lifecycle enum.
CREATE TABLE run_control_state (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','PAUSE_REQUESTED','PAUSED','RESUME_PENDING','CLOSED')),
  checkpoint_id TEXT,
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (checkpoint_id, run_id, attempt) REFERENCES run_checkpoints(id, run_id, attempt),
  CHECK (state NOT IN ('PAUSED','RESUME_PENDING') OR checkpoint_id IS NOT NULL)
);
