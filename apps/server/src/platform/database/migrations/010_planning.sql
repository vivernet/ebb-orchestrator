-- Coordinator planning candidates and approval state.
CREATE TABLE IF NOT EXISTS planning_requests (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request TEXT NOT NULL,
  requested_by TEXT NOT NULL, classification TEXT, plan_id TEXT,
  created_at TEXT NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS planning_plans (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, plan_json TEXT NOT NULL,
  epic_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approval_required INTEGER NOT NULL, temporary_id_map_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_planning_requests_project ON planning_requests(project_id);
CREATE INDEX IF NOT EXISTS idx_planning_plans_status ON planning_plans(status);
