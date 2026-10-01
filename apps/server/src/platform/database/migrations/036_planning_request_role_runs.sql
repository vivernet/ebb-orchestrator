-- Bind pre-approval PM/Architect planning Runs to one request and role.
-- The unique keys make role delivery idempotent across worker restarts.
ALTER TABLE planning_requests ADD COLUMN planning_decisions_required INTEGER NOT NULL DEFAULT 0
  CHECK (planning_decisions_required IN (0,1));

CREATE TABLE planning_request_role_runs (
  request_id TEXT NOT NULL REFERENCES planning_requests(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('product_manager','architect')),
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, role)
);

CREATE INDEX idx_planning_request_role_runs_run
  ON planning_request_role_runs(run_id);
