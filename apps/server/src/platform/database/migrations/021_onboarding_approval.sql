-- Durable onboarding proposal/approval metadata.
-- Values are deterministic configuration facts only; secrets must never be stored here.
CREATE TABLE IF NOT EXISTS approval_metadata (
  approval_id TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS onboarding_configs (
  project_id TEXT PRIMARY KEY,
  repository_path TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  proposed_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACTIVE')),
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (approval_id) REFERENCES approvals(id)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_configs_status ON onboarding_configs(status);
