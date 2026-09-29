CREATE TABLE IF NOT EXISTS github_feedback_deliveries (
  repository TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (repository, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_github_feedback_delivery_status
  ON github_feedback_deliveries(status, created_at);
