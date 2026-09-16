-- Findings and Defects tables for stable Reviewer/QA records

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  display_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('BLOCKING', 'HIGH', 'NORMAL', 'LOW')),
  blocking INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  guideline_ref TEXT,
  evidence_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'STILL_PRESENT')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (project_id, display_id)
);

CREATE INDEX IF NOT EXISTS idx_findings_task_id ON findings(task_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_project_id ON findings(project_id);

CREATE TABLE IF NOT EXISTS defects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  display_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('BLOCKING', 'HIGH', 'NORMAL', 'LOW')),
  blocking INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criterion_ref TEXT,
  evidence_signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'STILL_PRESENT')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (project_id, display_id)
);

CREATE INDEX IF NOT EXISTS idx_defects_task_id ON defects(task_id);
CREATE INDEX IF NOT EXISTS idx_defects_status ON defects(status);
CREATE INDEX IF NOT EXISTS idx_defects_project_id ON defects(project_id);
