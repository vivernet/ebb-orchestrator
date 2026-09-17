-- Transfer both v12 scheduler authorities only after the unified destination
-- exists.  The compatibility source is created empty on fresh installs so the
-- statements remain a single safe migration chain.
CREATE TABLE IF NOT EXISTS scheduler_capacity_reservations (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  estimate_cost REAL NOT NULL DEFAULT 0,
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'RESERVED',
  actual_cost REAL,
  approval_id TEXT
);
CREATE TABLE IF NOT EXISTS resource_locks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  owner_id TEXT NOT NULL
);

INSERT INTO scheduler_reservations (
  id, kind, subject_id, project_id, owner_id, reserved_at,
  estimate_cost, status, actual_cost, role, model, approval_id, run_id
)
SELECT
  'legacy-capacity:' || c.task_id,
  'TASK',
  c.task_id,
  c.project_id,
  c.owner_id,
  c.reserved_at,
  c.estimate_cost,
  c.status,
  c.actual_cost,
  'developer',
  'default',
  c.approval_id,
  c.run_id
FROM scheduler_capacity_reservations c
WHERE NOT EXISTS (
  SELECT 1 FROM scheduler_reservations r WHERE r.subject_id = c.task_id
);

INSERT INTO scheduler_reservations (
  id, kind, subject_id, project_id, owner_id, reserved_at,
  estimate_cost, status, role, model
)
SELECT
  'legacy-lock:' || l.task_id,
  'LOCK',
  'lock:' || l.task_id,
  t.project_id,
  MIN(l.owner_id),
  MIN(l.locked_at),
  0,
  'RESERVED',
  'lock',
  'legacy'
FROM resource_locks l
JOIN tasks t ON t.id = l.task_id
WHERE NOT EXISTS (SELECT 1 FROM scheduler_reservations r WHERE r.subject_id = l.task_id)
  AND NOT EXISTS (SELECT 1 FROM scheduler_reservations r WHERE r.subject_id = 'lock:' || l.task_id)
GROUP BY l.task_id, t.project_id;

INSERT INTO scheduler_resource_locks (
  resource_key, reservation_id, project_id, owner_id, locked_at
)
SELECT
  l.id,
  r.id,
  t.project_id,
  l.owner_id,
  l.locked_at
FROM resource_locks l
JOIN tasks t ON t.id = l.task_id
JOIN scheduler_reservations r ON r.subject_id IN (l.task_id, 'lock:' || l.task_id)
WHERE NOT EXISTS (
  SELECT 1 FROM scheduler_resource_locks existing WHERE existing.resource_key = l.id
);

DROP TABLE IF EXISTS resource_locks;
DROP TABLE IF EXISTS scheduler_capacity_reservations;
