CREATE TABLE IF NOT EXISTS project_config_candidates (
  candidate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_head TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  source_files_json TEXT NOT NULL,
  normalized_payload_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW','APPROVED_ACTIVE','STALE','SUPERSEDED')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_config_candidates_project_created
  ON project_config_candidates(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_config_revisions (
  revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  normalized_payload_json TEXT NOT NULL,
  source_head TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  source_files_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  approval_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_id) REFERENCES project_config_candidates(candidate_id),
  FOREIGN KEY (approval_id) REFERENCES approvals(id)
);

CREATE TABLE IF NOT EXISTS project_config_state (
  project_id TEXT PRIMARY KEY,
  current_candidate_id TEXT,
  active_revision_id TEXT,
  config_status TEXT NOT NULL DEFAULT 'READY' CHECK (config_status IN ('READY','DEGRADED')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (current_candidate_id) REFERENCES project_config_candidates(candidate_id),
  FOREIGN KEY (active_revision_id) REFERENCES project_config_revisions(revision_id)
);

CREATE INDEX IF NOT EXISTS idx_project_config_revisions_project_created
  ON project_config_revisions(project_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_project_config_candidate_snapshot_immutable
BEFORE UPDATE OF project_id,source_head,manifest_json,manifest_hash,source_files_json,normalized_payload_json,schema_version,created_at
ON project_config_candidates
BEGIN
  SELECT RAISE(ABORT, 'Project Config candidate snapshot is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_project_config_revision_immutable
BEFORE UPDATE ON project_config_revisions
BEGIN
  SELECT RAISE(ABORT, 'Project Config revisions are immutable');
END;
