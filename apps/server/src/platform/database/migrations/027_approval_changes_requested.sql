-- Миграция 027: разрешить фиксацию решения о запросе изменений.
-- FK отключаются migrator-ом до транзакции; дочерние строки при пересборке сохраняются.
CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN ('FINAL_MERGE', 'SCOPE_CHANGE', 'ARCHITECTURE_CHANGE', 'ROLE_CHANGE', 'WORKFLOW_CHANGE')
  ),
  subject_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('TASK', 'EPIC', 'PROJECT')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'CHANGES_REQUESTED')),
  requested_by TEXT NOT NULL,
  resolved_by TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

INSERT INTO approvals_new (
  id, type, subject_id, subject_type, status, requested_by,
  resolved_by, resolution_note, created_at, resolved_at
)
SELECT
  id, type, subject_id, subject_type, status, requested_by,
  resolved_by, resolution_note, created_at, resolved_at
FROM approvals;

DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;

CREATE INDEX idx_approvals_subject ON approvals(subject_id, subject_type);
CREATE INDEX idx_approvals_status ON approvals(status);
