-- Extend only durable process-owner containment checks. Both owner tables are rebuilt
-- transactionally so all existing rows and generation/current-owner projections survive.
DROP TRIGGER run_process_owner_generations_stopped_insert_guard;
DROP TRIGGER run_process_owners_current_generation_insert_guard;
DROP TRIGGER run_process_owners_current_generation_update_guard;
DROP TRIGGER run_process_owner_generations_current_delete_guard;
DROP TRIGGER run_process_owner_generations_current_identity_guard;
DROP TRIGGER run_process_owner_generations_current_conflict_guard;
DROP TRIGGER run_process_owner_generations_update_conflict_guard;
DROP TRIGGER run_process_owner_generations_stopped_immutable;
DROP TRIGGER run_process_owner_generations_stopped_delete_guard;
DROP TRIGGER run_resume_bindings_workspace_bind_once;

CREATE TABLE run_process_owners_v047 (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  source_tag TEXT NOT NULL UNIQUE,
  hermes_home TEXT NOT NULL CHECK (length(trim(hermes_home)) > 0),
  containment_kind TEXT NOT NULL CHECK (containment_kind IN ('windows-job', 'systemd-user-service', 'darwin-process-group')),
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
  systemd_control_group TEXT,
  capture_state TEXT NOT NULL DEFAULT 'UNBOUND'
    CHECK (capture_state IN ('UNBOUND', 'BOUND', 'INVALID')),
  hermes_source_snapshot_key TEXT, current_generation INTEGER NOT NULL DEFAULT 1 CHECK (current_generation >= 1),
  CHECK (source_tag = 'ebb-run:' || run_id),
  CHECK (
    state <> 'PREPARED' OR
    (systemd_invocation_id IS NULL AND supervisor_pid IS NULL AND supervisor_start_identity IS NULL AND
     pid IS NULL AND platform IS NULL AND process_start_identity IS NULL AND
     executable_identity IS NULL AND stop_evidence IS NULL)
  )
);

INSERT INTO run_process_owners_v047 (
  run_id, source_tag, hermes_home, containment_kind, containment_id, launch_nonce,
  systemd_invocation_id, supervisor_pid, supervisor_start_identity, pid, platform,
  process_start_identity, executable_identity, state, stop_evidence, updated_at,
  systemd_control_group, capture_state, hermes_source_snapshot_key, current_generation
)
SELECT
  run_id, source_tag, hermes_home, containment_kind, containment_id, launch_nonce,
  systemd_invocation_id, supervisor_pid, supervisor_start_identity, pid, platform,
  process_start_identity, executable_identity, state, stop_evidence, updated_at,
  systemd_control_group, capture_state, hermes_source_snapshot_key, current_generation
FROM run_process_owners;

CREATE TABLE run_process_owner_generations_v047 (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  run_attempt INTEGER CHECK (run_attempt >= 1),
  source_tag TEXT NOT NULL CHECK (source_tag = 'ebb-run:' || run_id),
  hermes_home TEXT NOT NULL CHECK (length(trim(hermes_home)) > 0),
  hermes_source_snapshot_key TEXT,
  capture_state TEXT NOT NULL DEFAULT 'UNBOUND' CHECK (capture_state IN ('UNBOUND', 'BOUND', 'INVALID')),
  containment_kind TEXT NOT NULL CHECK (containment_kind IN ('windows-job', 'systemd-user-service', 'darwin-process-group')),
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
  systemd_control_group TEXT,
  PRIMARY KEY (run_id, generation),
  CHECK (
    state <> 'PREPARED' OR
    (systemd_invocation_id IS NULL AND supervisor_pid IS NULL AND supervisor_start_identity IS NULL AND
     pid IS NULL AND platform IS NULL AND process_start_identity IS NULL AND
     executable_identity IS NULL AND stop_evidence IS NULL)
  )
);

INSERT INTO run_process_owner_generations_v047 (
  run_id, generation, run_attempt, source_tag, hermes_home, hermes_source_snapshot_key, capture_state,
  containment_kind, containment_id, launch_nonce, systemd_invocation_id, supervisor_pid,
  supervisor_start_identity, pid, platform, process_start_identity, executable_identity,
  state, stop_evidence, updated_at, systemd_control_group
)
SELECT
  run_id, generation, run_attempt, source_tag, hermes_home, hermes_source_snapshot_key, capture_state,
  containment_kind, containment_id, launch_nonce, systemd_invocation_id, supervisor_pid,
  supervisor_start_identity, pid, platform, process_start_identity, executable_identity,
  state, stop_evidence, updated_at, systemd_control_group
FROM run_process_owner_generations;

DROP TABLE run_process_owners;
ALTER TABLE run_process_owners_v047 RENAME TO run_process_owners;
DROP TABLE run_process_owner_generations;
ALTER TABLE run_process_owner_generations_v047 RENAME TO run_process_owner_generations;

-- Recreate every guard from migration 042 with its original body and timing.
CREATE TRIGGER run_process_owner_generations_stopped_insert_guard
BEFORE INSERT ON run_process_owner_generations
WHEN EXISTS (
  SELECT 1 FROM run_process_owner_generations
  WHERE state = 'STOPPED' AND (
    (run_id = NEW.run_id AND generation = NEW.generation) OR
    containment_id = NEW.containment_id OR launch_nonce = NEW.launch_nonce
  )
)
BEGIN
  SELECT RAISE(ABORT, 'STOPPED generation is immutable');
END;

CREATE TRIGGER run_process_owners_current_generation_insert_guard
BEFORE INSERT ON run_process_owners
WHEN EXISTS (SELECT 1 FROM agent_runs WHERE id = NEW.run_id) AND NOT EXISTS (
  SELECT 1 FROM run_process_owner_generations
  WHERE run_id = NEW.run_id AND generation = NEW.current_generation
)
BEGIN
  SELECT RAISE(ABORT, 'Current generation does not exist');
END;

CREATE TRIGGER run_process_owners_current_generation_update_guard
BEFORE UPDATE OF run_id, current_generation ON run_process_owners
WHEN EXISTS (SELECT 1 FROM agent_runs WHERE id = NEW.run_id) AND NOT EXISTS (
  SELECT 1 FROM run_process_owner_generations
  WHERE run_id = NEW.run_id AND generation = NEW.current_generation
)
BEGIN
  SELECT RAISE(ABORT, 'Current generation does not exist');
END;

CREATE TRIGGER run_process_owner_generations_current_delete_guard
BEFORE DELETE ON run_process_owner_generations
WHEN OLD.state <> 'STOPPED' AND EXISTS (
  SELECT 1 FROM run_process_owners JOIN agent_runs ON agent_runs.id = run_process_owners.run_id
  WHERE run_process_owners.run_id = OLD.run_id AND current_generation = OLD.generation
)
BEGIN
  SELECT RAISE(ABORT, 'Current generation is referenced');
END;

CREATE TRIGGER run_process_owner_generations_current_identity_guard
BEFORE UPDATE OF run_id, generation ON run_process_owner_generations
WHEN (NEW.run_id IS NOT OLD.run_id OR NEW.generation IS NOT OLD.generation) AND EXISTS (
  SELECT 1 FROM run_process_owners WHERE run_id = OLD.run_id AND current_generation = OLD.generation
)
BEGIN
  SELECT RAISE(ABORT, 'Current generation is referenced');
END;

CREATE TRIGGER run_process_owner_generations_current_conflict_guard
BEFORE INSERT ON run_process_owner_generations
WHEN EXISTS (
  SELECT 1 FROM run_process_owner_generations AS existing
  JOIN run_process_owners AS owner ON owner.run_id = existing.run_id AND owner.current_generation = existing.generation
  WHERE existing.state <> 'STOPPED' AND
    (existing.run_id <> NEW.run_id OR existing.generation <> NEW.generation) AND
    (existing.containment_id = NEW.containment_id OR existing.launch_nonce = NEW.launch_nonce)
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE conflict would orphan current generation');
END;

CREATE TRIGGER run_process_owner_generations_update_conflict_guard
BEFORE UPDATE OF run_id, generation, containment_id, launch_nonce ON run_process_owner_generations
WHEN EXISTS (
  SELECT 1 FROM run_process_owner_generations AS existing
  WHERE (existing.run_id <> OLD.run_id OR existing.generation <> OLD.generation) AND (
    (existing.run_id = NEW.run_id AND existing.generation = NEW.generation) OR
    existing.containment_id = NEW.containment_id OR existing.launch_nonce = NEW.launch_nonce
  ) AND (
    existing.state = 'STOPPED' OR EXISTS (
      SELECT 1 FROM run_process_owners AS owner
      WHERE owner.run_id = existing.run_id AND owner.current_generation = existing.generation
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Generation identity conflict');
END;

CREATE TRIGGER run_process_owner_generations_stopped_immutable
BEFORE UPDATE ON run_process_owner_generations
WHEN OLD.state = 'STOPPED'
BEGIN
  SELECT RAISE(ABORT, 'STOPPED generation is immutable');
END;

CREATE TRIGGER run_process_owner_generations_stopped_delete_guard
BEFORE DELETE ON run_process_owner_generations
WHEN OLD.state = 'STOPPED' AND EXISTS (SELECT 1 FROM agent_runs WHERE id = OLD.run_id)
BEGIN
  SELECT RAISE(ABORT, 'STOPPED generation is immutable');
END;

-- This external guard queries both owner tables while enforcing the one-time integration bind.
-- Recreate the unchanged guard after both table names are available again.
CREATE TRIGGER run_resume_bindings_workspace_bind_once
BEFORE UPDATE OF workspace_snapshot_bound,workspace_snapshot_hash,resume_binding_hash,workspace_snapshot_version ON run_resume_bindings
WHEN OLD.workspace_snapshot_bound <> 0 OR NEW.workspace_snapshot_bound <> 1 OR
     NEW.workspace_snapshot_version IS NOT OLD.workspace_snapshot_version OR
     OLD.original_session_id IS NOT NULL OR NEW.original_session_id IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM agent_runs r JOIN run_process_owners o ON o.run_id=r.id
       JOIN run_process_owner_generations g ON g.run_id=o.run_id AND g.generation=o.current_generation
       WHERE r.id=OLD.run_id AND lower(r.role)='integration' AND r.status='STARTED' AND
         r.session_id IS NULL AND r.attempt IS NULL AND r.output IS NULL AND r.ended_at IS NULL AND
         o.current_generation=1 AND o.state='PREPARED' AND o.capture_state='UNBOUND' AND
         g.state='PREPARED' AND g.capture_state='UNBOUND' AND g.run_attempt IS NULL AND
         g.containment_id=o.containment_id AND g.launch_nonce=o.launch_nonce
     )
BEGIN
  SELECT RAISE(ABORT, 'Initial workspace snapshot binding is immutable or no longer prepared');
END;
