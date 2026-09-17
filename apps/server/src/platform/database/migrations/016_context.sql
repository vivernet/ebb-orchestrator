-- Context domain: Context manifests and deltas for tracking what each Run saw.
CREATE TABLE IF NOT EXISTS context_manifests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('developer', 'reviewer', 'qa', 'integration', 'architect')),
  task_contract_version TEXT NOT NULL,
  guideline_ids TEXT NOT NULL DEFAULT '[]',
  decision_ids TEXT NOT NULL DEFAULT '[]',
  finding_ids TEXT NOT NULL DEFAULT '[]',
  defect_ids TEXT NOT NULL DEFAULT '[]',
  context_builder_version TEXT NOT NULL DEFAULT '1.0.0',
  initial_token_size INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS context_deltas (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  previous_manifest_id TEXT,
  added_ids TEXT NOT NULL DEFAULT '[]',
  updated_ids TEXT NOT NULL DEFAULT '[]',
  removed_ids TEXT NOT NULL DEFAULT '[]',
  resume_safe INTEGER NOT NULL DEFAULT 1,
  resume_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (manifest_id) REFERENCES context_manifests(id) ON DELETE CASCADE,
  FOREIGN KEY (previous_manifest_id) REFERENCES context_manifests(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_context_manifests_run ON context_manifests(run_id);
CREATE INDEX IF NOT EXISTS idx_context_manifests_task ON context_manifests(task_id);
CREATE INDEX IF NOT EXISTS idx_context_manifests_role ON context_manifests(role);
CREATE INDEX IF NOT EXISTS idx_context_deltas_manifest ON context_deltas(manifest_id);
