-- Durable Epic orchestration state.  The row is the recovery checkpoint; no
-- in-process coordinator state is required to resume an Epic.
CREATE TABLE IF NOT EXISTS epic_orchestrations (
  epic_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  stage TEXT NOT NULL,
  sequence_json TEXT NOT NULL DEFAULT '[]',
  architecture_review_authorized INTEGER NOT NULL DEFAULT 0,
  final_approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (epic_id) REFERENCES epics(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES planning_plans(id) ON DELETE RESTRICT
);
