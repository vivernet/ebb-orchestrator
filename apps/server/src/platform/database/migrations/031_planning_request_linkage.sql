-- Durable Project-scoped Coordinator request lifecycle. Existing plan_id is
-- retained so legacy structured plans remain independent of natural requests.
ALTER TABLE planning_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'RECEIVED'
  CHECK (status IN ('RECEIVED','PLANNING','NEEDS_INPUT','PLAN_PENDING_APPROVAL','REJECTED','MATERIALIZED','FAILED'));
ALTER TABLE planning_requests ADD COLUMN coordinator_run_id TEXT REFERENCES agent_runs(id);
ALTER TABLE planning_requests ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE planning_requests ADD COLUMN failure_code TEXT;

UPDATE planning_requests
   SET updated_at=created_at,
       status=CASE
         WHEN plan_id IS NULL AND classification='NEEDS_INPUT' THEN 'NEEDS_INPUT'
         WHEN plan_id IS NULL THEN 'RECEIVED'
         WHEN EXISTS (SELECT 1 FROM planning_plans p WHERE p.id=planning_requests.plan_id AND p.project_id=planning_requests.project_id AND p.status='APPROVED') THEN 'MATERIALIZED'
         WHEN EXISTS (SELECT 1 FROM planning_plans p WHERE p.id=planning_requests.plan_id AND p.project_id=planning_requests.project_id AND p.status='REJECTED') THEN 'REJECTED'
         WHEN EXISTS (SELECT 1 FROM planning_plans p WHERE p.id=planning_requests.plan_id AND p.project_id=planning_requests.project_id AND p.status='PENDING') THEN 'PLAN_PENDING_APPROVAL'
         ELSE 'FAILED'
       END,
       failure_code=CASE
         WHEN plan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM planning_plans p WHERE p.id=planning_requests.plan_id AND p.project_id=planning_requests.project_id) THEN 'PLAN_LINK_INVALID'
         ELSE NULL
       END;

CREATE UNIQUE INDEX idx_planning_requests_plan_unique ON planning_requests(plan_id) WHERE plan_id IS NOT NULL;
CREATE UNIQUE INDEX idx_planning_requests_coordinator_run_unique ON planning_requests(coordinator_run_id) WHERE coordinator_run_id IS NOT NULL;
CREATE INDEX idx_planning_requests_status ON planning_requests(project_id,status,updated_at);
