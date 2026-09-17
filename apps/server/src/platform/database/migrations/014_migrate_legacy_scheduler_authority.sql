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

-- Do not let the inner joins below turn malformed legacy rows into silent
-- data loss.  A CHECK violation aborts this migration transaction, leaving
-- both source tables available for repair and retry.
CREATE TABLE scheduler_014_completeness_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1 FROM resource_locks l
  LEFT JOIN tasks t ON t.id = l.task_id
  WHERE t.id IS NULL
);

-- A destination row is not evidence that a legacy row was migrated.  Refuse
-- to discard a legacy reservation whose durable fields disagree with the
-- existing destination row.  SQLite IS comparisons intentionally preserve
-- NULL-vs-value conflicts for optional cost/approval/run fields.
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM scheduler_capacity_reservations c
  JOIN scheduler_reservations r ON r.subject_id = c.task_id
  WHERE r.id IS NOT ('legacy-capacity:' || c.task_id)
     OR r.kind <> 'TASK'
     OR r.project_id IS NOT c.project_id
     OR r.owner_id IS NOT c.owner_id
     OR r.reserved_at IS NOT c.reserved_at
     OR r.estimate_cost IS NOT c.estimate_cost
     OR r.status IS NOT c.status
     OR r.actual_cost IS NOT c.actual_cost
     OR r.approval_id IS NOT c.approval_id
     OR r.run_id IS NOT c.run_id
     OR r.role IS NOT 'developer'
     OR r.model IS NOT 'default'
);

-- A lock without a corresponding legacy capacity row must never be attached
-- to an unrelated pre-existing task reservation.  Such an attachment would
-- make the final completeness check pass while losing lock authority data.
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM resource_locks l
  JOIN scheduler_reservations r ON r.subject_id = l.task_id
  WHERE NOT EXISTS (
    SELECT 1 FROM scheduler_capacity_reservations c WHERE c.task_id = l.task_id
  )
);

-- Existing lock mappings are acceptable only when they are byte-for-byte
-- equivalent in the fields owned by the legacy source row.
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM resource_locks l
  JOIN scheduler_resource_locks sl ON sl.resource_key = l.id
  WHERE sl.project_id IS NOT (SELECT t.project_id FROM tasks t WHERE t.id = l.task_id)
     OR sl.owner_id IS NOT l.owner_id
     OR sl.locked_at IS NOT l.locked_at
     OR sl.reservation_id IS NOT (
       CASE WHEN EXISTS (
         SELECT 1 FROM scheduler_capacity_reservations c WHERE c.task_id = l.task_id
       ) THEN 'legacy-capacity:' || l.task_id ELSE 'legacy-lock:' || l.task_id END
     )
     OR NOT EXISTS (SELECT 1 FROM scheduler_reservations r WHERE r.id = sl.reservation_id)
);
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1 FROM scheduler_capacity_reservations c
  LEFT JOIN tasks t ON t.id = c.task_id
  WHERE t.id IS NULL
);

-- When capacity is absent, locks get one synthetic reservation per task.  A
-- task-subject reservation is always ambiguous here: it is not the legacy
-- lock destination and must not be reused or allowed to shadow it.
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM resource_locks l
  JOIN tasks t ON t.id = l.task_id
  JOIN scheduler_reservations r ON r.subject_id = l.task_id
  WHERE NOT EXISTS (
          SELECT 1 FROM scheduler_capacity_reservations c WHERE c.task_id = l.task_id
        )
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
WHERE NOT EXISTS (SELECT 1 FROM scheduler_capacity_reservations c WHERE c.task_id = l.task_id)
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
JOIN scheduler_reservations r ON r.id = CASE WHEN EXISTS (
  SELECT 1 FROM scheduler_capacity_reservations c WHERE c.task_id = l.task_id
) THEN 'legacy-capacity:' || l.task_id ELSE 'legacy-lock:' || l.task_id END
WHERE NOT EXISTS (
  SELECT 1 FROM scheduler_resource_locks existing WHERE existing.resource_key = l.id
);

-- Verify every source row has a concrete, referentially usable destination
-- before either source table is removed.
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM resource_locks l
  LEFT JOIN scheduler_resource_locks sl ON sl.resource_key = l.id
  LEFT JOIN scheduler_reservations r ON r.id = sl.reservation_id
  WHERE sl.resource_key IS NULL OR r.id IS NULL
);
INSERT INTO scheduler_014_completeness_guard(valid)
SELECT 0
WHERE EXISTS (
  SELECT 1
  FROM scheduler_capacity_reservations c
  LEFT JOIN scheduler_reservations r ON r.subject_id = c.task_id
  WHERE r.id IS NULL
);

DROP TABLE scheduler_014_completeness_guard;

DROP TABLE IF EXISTS resource_locks;
DROP TABLE IF EXISTS scheduler_capacity_reservations;
