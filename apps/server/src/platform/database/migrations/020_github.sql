CREATE TABLE IF NOT EXISTS github_sync_records (
  key TEXT PRIMARY KEY NOT NULL,
  repository TEXT NOT NULL,
  marker TEXT NOT NULL,
  remote_id INTEGER,
  remote_url TEXT,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_sync_repository ON github_sync_records(repository);
