-- Event acknowledgement is delivery-specific. This marker survives a lost ack
-- and arbitrates the deterministic Workflow projection of one persisted outcome.
CREATE TABLE run_completion_projections (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
  projected_at TEXT NOT NULL
);
