ALTER TABLE epic_orchestrations ADD COLUMN execution_token TEXT;
ALTER TABLE epic_orchestrations ADD COLUMN execution_started_at TEXT;

CREATE INDEX idx_epic_orchestrations_execution_claim
  ON epic_orchestrations(execution_token) WHERE execution_token IS NOT NULL;
