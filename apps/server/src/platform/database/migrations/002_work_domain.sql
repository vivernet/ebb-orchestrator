-- Projects, Epics, and Tasks domain tables

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED','DELETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  display_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','DONE','CANCELLED')),
  contract_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_epics_project_id ON epics(project_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  epic_id TEXT,
  display_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN (
      'DRAFT', 'READY', 'DEVELOPMENT', 'REVIEW', 'QA',
      'READY_FOR_INTEGRATION', 'INTEGRATION', 'INTEGRATED_INTO_EPIC',
      'READY_FOR_MERGE', 'MERGING', 'DONE', 'RELEASED',
      'BLOCKED', 'WAITING_FOR_DEPENDENCY', 'WAITING_FOR_APPROVAL',
      'PAUSED', 'FAILED', 'CANCELLED'
    )
  ),
  contract_json TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_display ON tasks(project_id, display_id);
