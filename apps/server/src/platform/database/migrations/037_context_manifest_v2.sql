-- Retain every v1 row and let SQLite retarget both context_deltas FKs in place.
-- This migration must run with foreign-key enforcement enabled in one transaction.
ALTER TABLE context_manifests RENAME TO context_manifests_legacy_v1;

CREATE TABLE context_manifests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('TASK', 'EPIC', 'REQUEST')),
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  epic_id TEXT REFERENCES epics(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES planning_requests(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('coordinator', 'product_manager', 'architect', 'developer', 'reviewer', 'qa', 'integration')),
  contract_request_digest TEXT CHECK (
    contract_request_digest IS NULL OR
    (length(contract_request_digest) = 64 AND contract_request_digest NOT GLOB '*[^0-9a-f]*')
  ),
  items_json TEXT NOT NULL CHECK (json_valid(items_json) AND json_type(items_json) = 'array'),
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  context_builder_version TEXT NOT NULL CHECK (length(trim(context_builder_version)) > 0),
  initial_token_size INTEGER CHECK (initial_token_size IS NULL OR (typeof(initial_token_size) = 'integer' AND initial_token_size >= 0)),
  created_at TEXT NOT NULL,
  CHECK (
    (subject_type = 'TASK' AND task_id IS NOT NULL AND epic_id IS NULL AND request_id IS NULL) OR
    (subject_type = 'EPIC' AND task_id IS NULL AND epic_id IS NOT NULL AND request_id IS NULL) OR
    (subject_type = 'REQUEST' AND task_id IS NULL AND epic_id IS NULL AND request_id IS NOT NULL)
  )
);

CREATE TRIGGER context_manifests_subject_matches_run_insert
BEFORE INSERT ON context_manifests
BEGIN
  SELECT CASE
    WHEN NEW.subject_type = 'TASK' AND NOT EXISTS (
      SELECT 1 FROM agent_runs r WHERE r.id = NEW.run_id AND r.task_id = NEW.task_id
    ) THEN RAISE(ABORT, 'context manifest task does not match Run')
    WHEN NEW.subject_type = 'EPIC' AND NOT EXISTS (
      SELECT 1 FROM agent_runs r WHERE r.id = NEW.run_id AND r.task_id IS NULL AND r.epic_id = NEW.epic_id
    ) THEN RAISE(ABORT, 'context manifest epic does not match Run')
    WHEN NEW.subject_type = 'REQUEST' AND NOT EXISTS (
      SELECT 1 FROM agent_runs r
      WHERE r.id = NEW.run_id AND r.task_id IS NULL AND r.epic_id IS NULL
        AND (
          EXISTS (SELECT 1 FROM planning_requests p WHERE p.id = NEW.request_id AND p.coordinator_run_id = r.id)
          OR EXISTS (SELECT 1 FROM planning_request_role_runs pr WHERE pr.request_id = NEW.request_id AND pr.run_id = r.id)
        )
    ) THEN RAISE(ABORT, 'context manifest request does not match Run')
  END;
END;

CREATE TRIGGER context_manifests_subject_matches_run_update
BEFORE UPDATE OF run_id, subject_type, task_id, epic_id, request_id ON context_manifests
BEGIN
  SELECT CASE
    WHEN NEW.subject_type = 'TASK' AND NOT EXISTS (
      SELECT 1 FROM agent_runs r WHERE r.id = NEW.run_id AND r.task_id = NEW.task_id
    ) THEN RAISE(ABORT, 'context manifest task does not match Run')
    WHEN NEW.subject_type = 'EPIC' AND NOT EXISTS (
      SELECT 1 FROM agent_runs r WHERE r.id = NEW.run_id AND r.task_id IS NULL AND r.epic_id = NEW.epic_id
    ) THEN RAISE(ABORT, 'context manifest epic does not match Run')
    WHEN NEW.subject_type = 'REQUEST' AND NOT EXISTS (
      SELECT 1 FROM agent_runs r
      WHERE r.id = NEW.run_id AND r.task_id IS NULL AND r.epic_id IS NULL
        AND (
          EXISTS (SELECT 1 FROM planning_requests p WHERE p.id = NEW.request_id AND p.coordinator_run_id = r.id)
          OR EXISTS (SELECT 1 FROM planning_request_role_runs pr WHERE pr.request_id = NEW.request_id AND pr.run_id = r.id)
        )
    ) THEN RAISE(ABORT, 'context manifest request does not match Run')
  END;
END;

CREATE TABLE run_process_owners (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  source_tag TEXT NOT NULL UNIQUE,
  hermes_home TEXT NOT NULL UNIQUE CHECK (length(trim(hermes_home)) > 0),
  containment_kind TEXT NOT NULL CHECK (containment_kind IN ('windows-job', 'systemd-user-service')),
  containment_id TEXT NOT NULL UNIQUE CHECK (length(containment_id) = 64 AND containment_id NOT GLOB '*[^0-9a-f]*'),
  launch_nonce TEXT NOT NULL UNIQUE CHECK (length(launch_nonce) = 64 AND launch_nonce NOT GLOB '*[^0-9a-f]*'),
  systemd_invocation_id TEXT,
  supervisor_pid INTEGER,
  supervisor_start_identity TEXT,
  pid INTEGER,
  platform TEXT,
  process_start_identity TEXT,
  executable_identity TEXT,
  state TEXT NOT NULL CHECK (state IN ('PREPARED', 'LAUNCHING', 'LIVE', 'STOPPING', 'STOPPED', 'UNKNOWN')),
  stop_evidence TEXT,
  updated_at TEXT NOT NULL,
  CHECK (source_tag = 'ebb-run:' || run_id),
  CHECK (
    state <> 'PREPARED' OR
    (systemd_invocation_id IS NULL AND supervisor_pid IS NULL AND supervisor_start_identity IS NULL AND
     pid IS NULL AND platform IS NULL AND process_start_identity IS NULL AND
     executable_identity IS NULL AND stop_evidence IS NULL)
  )
);
