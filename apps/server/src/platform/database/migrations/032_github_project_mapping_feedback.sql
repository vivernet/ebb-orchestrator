CREATE TABLE IF NOT EXISTS github_project_mappings (
  repository_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS human_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  source_repository TEXT NOT NULL,
  source_issue_number INTEGER NOT NULL,
  source_comment_id INTEGER NOT NULL,
  author_login TEXT NOT NULL,
  author_type TEXT NOT NULL,
  body TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_created_at TEXT,
  source_updated_at TEXT,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UNTRIAGED','LINKED','IGNORED','RESOLVED','DELETED')),
  task_id TEXT,
  epic_id TEXT,
  triaged_at TEXT,
  deleted_at TEXT,
  UNIQUE (source_repository,source_comment_id),
  CHECK ((task_id IS NULL) OR (epic_id IS NULL)),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_feedback_project_status_received
  ON human_feedback(project_id,status,received_at DESC);
