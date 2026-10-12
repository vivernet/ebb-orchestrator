CREATE TABLE run_process_owners_v041 (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  source_tag TEXT NOT NULL UNIQUE,
  hermes_home TEXT NOT NULL CHECK (length(trim(hermes_home)) > 0),
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
  capture_state TEXT NOT NULL DEFAULT 'UNBOUND'
    CHECK (capture_state IN ('UNBOUND', 'BOUND', 'INVALID')),
  hermes_source_snapshot_key TEXT,
  CHECK (source_tag = 'ebb-run:' || run_id),
  CHECK (
    state <> 'PREPARED' OR
    (systemd_invocation_id IS NULL AND supervisor_pid IS NULL AND supervisor_start_identity IS NULL AND
     pid IS NULL AND platform IS NULL AND process_start_identity IS NULL AND
     executable_identity IS NULL AND stop_evidence IS NULL)
  )
);

INSERT INTO run_process_owners_v041 (
  run_id, source_tag, hermes_home, containment_kind, containment_id, launch_nonce,
  systemd_invocation_id, supervisor_pid, supervisor_start_identity, pid, platform,
  process_start_identity, executable_identity, state, stop_evidence, updated_at,
  systemd_control_group, capture_state, hermes_source_snapshot_key
)
SELECT
  run_id, source_tag, hermes_home, containment_kind, containment_id, launch_nonce,
  systemd_invocation_id, supervisor_pid, supervisor_start_identity, pid, platform,
  process_start_identity, executable_identity, state, stop_evidence, updated_at,
  systemd_control_group, capture_state, hermes_source_snapshot_key
FROM run_process_owners;

DROP TABLE run_process_owners;
ALTER TABLE run_process_owners_v041 RENAME TO run_process_owners;
