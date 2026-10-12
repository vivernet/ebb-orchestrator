-- Durable process scopes are distinct from the stable logical Run/session binding.
-- Historical attempt correlation is unknown: do not infer it from agent_runs.attempt.
CREATE TABLE run_process_owner_generations (
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  run_attempt INTEGER CHECK (run_attempt >= 1),
  source_tag TEXT NOT NULL CHECK (source_tag = 'ebb-run:' || run_id),
  hermes_home TEXT NOT NULL CHECK (length(trim(hermes_home)) > 0),
  hermes_source_snapshot_key TEXT,
  capture_state TEXT NOT NULL DEFAULT 'UNBOUND' CHECK (capture_state IN ('UNBOUND', 'BOUND', 'INVALID')),
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
  systemd_control_group TEXT,
  PRIMARY KEY (run_id, generation),
  CHECK (
    state <> 'PREPARED' OR
    (systemd_invocation_id IS NULL AND supervisor_pid IS NULL AND supervisor_start_identity IS NULL AND
     pid IS NULL AND platform IS NULL AND process_start_identity IS NULL AND
     executable_identity IS NULL AND stop_evidence IS NULL)
  )
);

INSERT INTO run_process_owner_generations (
  run_id, generation, run_attempt, source_tag, hermes_home, hermes_source_snapshot_key, capture_state,
  containment_kind, containment_id, launch_nonce,
  systemd_invocation_id, supervisor_pid, supervisor_start_identity, pid, platform,
  process_start_identity, executable_identity, state, stop_evidence, updated_at, systemd_control_group
)
SELECT
  run_id, 1, NULL, source_tag, hermes_home, hermes_source_snapshot_key, capture_state,
  containment_kind, containment_id, launch_nonce,
  systemd_invocation_id, supervisor_pid, supervisor_start_identity, pid, platform,
  process_start_identity, executable_identity, state, stop_evidence, updated_at, systemd_control_group
FROM run_process_owners;

ALTER TABLE run_process_owners ADD COLUMN current_generation INTEGER NOT NULL DEFAULT 1 CHECK (current_generation >= 1);

-- INSERT OR REPLACE may suppress DELETE triggers when recursive_triggers is OFF.
-- Check every unique conflict before SQLite can replace retained STOPPED history.
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

-- UPDATE OR REPLACE can also silently delete a different conflicting generation.
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

-- Retain stopped history while its logical Run exists; preserve the Run's CASCADE deletion.
CREATE TRIGGER run_process_owner_generations_stopped_delete_guard
BEFORE DELETE ON run_process_owner_generations
WHEN OLD.state = 'STOPPED' AND EXISTS (SELECT 1 FROM agent_runs WHERE id = OLD.run_id)
BEGIN
  SELECT RAISE(ABORT, 'STOPPED generation is immutable');
END;

-- Only new Runs with a complete application-validated source baseline receive a binding.
-- Existing Runs remain ineligible; no context/session/workspace metadata is guessed.
CREATE TABLE run_resume_bindings (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  baseline_jcs TEXT NOT NULL CHECK (
    json_valid(baseline_jcs) AND json_type(baseline_jcs) = 'object' AND
    json_type(baseline_jcs, '$.workspaceIdentity') IS NULL
  ),
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  workspace_snapshot_version INTEGER NOT NULL CHECK (workspace_snapshot_version = 1),
  workspace_snapshot_bound INTEGER NOT NULL DEFAULT 1 CHECK (workspace_snapshot_bound IN (0,1)),
  workspace_snapshot_hash TEXT,
  resume_binding_hash TEXT,
  original_session_id TEXT CHECK (original_session_id IS NULL OR
    (length(original_session_id) BETWEEN 1 AND 256 AND original_session_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  created_at TEXT NOT NULL,
  CHECK (
    (workspace_snapshot_bound = 0 AND workspace_snapshot_hash IS NULL AND resume_binding_hash IS NULL) OR
    (workspace_snapshot_bound = 1 AND workspace_snapshot_hash IS NOT NULL AND resume_binding_hash IS NOT NULL AND
     length(workspace_snapshot_hash) = 64 AND workspace_snapshot_hash NOT GLOB '*[^0-9a-f]*' AND
     length(resume_binding_hash) = 64 AND resume_binding_hash NOT GLOB '*[^0-9a-f]*')
  )
);

CREATE TRIGGER run_resume_bindings_context_immutable
BEFORE UPDATE OF schema_version,baseline_jcs,context_hash,created_at ON run_resume_bindings
WHEN NEW.schema_version IS NOT OLD.schema_version OR NEW.baseline_jcs IS NOT OLD.baseline_jcs OR
     NEW.context_hash IS NOT OLD.context_hash OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'Resume context baseline is immutable');
END;

-- Integration's initial merge changes the tree after prompt preparation. Only its first
-- PREPARED generation may bind that post-merge snapshot, before any session or dispatch.
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

CREATE TRIGGER run_resume_bindings_original_session_immutable
BEFORE UPDATE OF original_session_id ON run_resume_bindings
WHEN OLD.original_session_id IS NOT NULL AND NEW.original_session_id IS NOT OLD.original_session_id
BEGIN
  SELECT RAISE(ABORT, 'Original session is immutable');
END;

-- UPDATE OR REPLACE must not transfer an existing Run's immutable binding to another Run.
CREATE TRIGGER run_resume_bindings_run_id_immutable
BEFORE UPDATE OF run_id ON run_resume_bindings
WHEN NEW.run_id IS NOT OLD.run_id
BEGIN
  SELECT RAISE(ABORT, 'Resume binding Run identity is immutable');
END;

CREATE TRIGGER run_resume_bindings_insert_guard
BEFORE INSERT ON run_resume_bindings
WHEN EXISTS (SELECT 1 FROM run_resume_bindings WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'Resume binding is immutable');
END;
