-- Durable integration attempts.  The provenance columns are immutable; only
-- the lifecycle status may change.
CREATE TABLE IF NOT EXISTS integration_attempts (
  id TEXT PRIMARY KEY,
  repository_path TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  expected_target_sha TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  integration_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PREPARED','MERGING','MERGED','FAILED')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_attempts_run ON integration_attempts(integration_run_id);
CREATE TRIGGER IF NOT EXISTS integration_attempts_immutable_provenance
BEFORE UPDATE OF id, repository_path, source_branch, target_branch,
  expected_target_sha, worktree_path, integration_run_id, created_at
ON integration_attempts
BEGIN
  SELECT RAISE(ABORT, 'integration provenance is immutable');
END;
