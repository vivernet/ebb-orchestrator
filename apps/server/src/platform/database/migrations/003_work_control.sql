-- Dependencies, Proposals, Decisions, and Approvals tables

CREATE TABLE IF NOT EXISTS dependencies (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'BLOCKING' CHECK (type IN ('BLOCKING')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_dependencies_task_id ON dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on ON dependencies(depends_on_task_id);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN (
      'NEW_TASK', 'NEW_DEPENDENCY', 'REMOVE_DEPENDENCY', 'SCOPE_CHANGE',
      'REQUIREMENT_CHANGE', 'ACCEPTANCE_CRITERIA_CHANGE', 'GUIDELINE_CHANGE',
      'ARCHITECTURE_CHANGE', 'ROLE_CHANGE', 'WORKFLOW_CHANGE', 'PLAN_CHANGE'
    )
  ),
  subject_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('TASK', 'EPIC', 'PROJECT')),
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACCEPTED', 'REJECTED', 'WITHDRAWN')),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_subject ON proposals(subject_id, subject_type);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('TASK', 'EPIC', 'PROJECT', 'GLOBAL')),
  scope_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'FINAL', 'SUPERSEDED')),
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_scope ON decisions(scope, scope_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (
    type IN ('FINAL_MERGE', 'SCOPE_CHANGE', 'ARCHITECTURE_CHANGE', 'ROLE_CHANGE', 'WORKFLOW_CHANGE')
  ),
  subject_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('TASK', 'EPIC', 'PROJECT')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by TEXT NOT NULL,
  resolved_by TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_subject ON approvals(subject_id, subject_type);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
