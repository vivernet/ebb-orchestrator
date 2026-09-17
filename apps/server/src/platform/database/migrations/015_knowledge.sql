-- Knowledge domain: Guidelines and Decisions indexed from repository Markdown.
CREATE TABLE IF NOT EXISTS knowledge_guidelines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  display_id TEXT NOT NULL,
  category TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  priority TEXT NOT NULL CHECK (priority IN ('REQUIRED', 'RECOMMENDED', 'PREFERENCE')),
  status TEXT NOT NULL CHECK (status IN (
    'PROPOSED', 'UNDER_REVIEW', 'ACTIVE', 'SUPERSEDED', 'DEPRECATED', 'REJECTED', 'PENDING_EXTERNAL_CHANGE'
  )),
  scope TEXT NOT NULL,
  applicable_roles TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  superseded_by TEXT,
  content TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  display_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'ACCEPTED', 'SUPERSEDED', 'OBSOLETE', 'REJECTED')),
  scope TEXT NOT NULL CHECK (scope IN ('PROJECT', 'AREA', 'EPIC', 'TASK')),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  related_guideline TEXT,
  content TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_guidelines_project ON knowledge_guidelines(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_guidelines_status ON knowledge_guidelines(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_guidelines_display ON knowledge_guidelines(display_id, project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_decisions_project ON knowledge_decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_decisions_status ON knowledge_decisions(status);
