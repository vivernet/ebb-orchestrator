-- Best-effort Run-level traces: canonical non-raw completion sidecar.
-- One trace per Run (run_id PK => idempotency); FK cascade => retention.
-- No runtime/model/provider labels, raw prompt, input/output, stderr,
-- credentials, endpoint URLs or headers are stored here.
CREATE TABLE run_traces (
  run_id TEXT NOT NULL PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  scenario TEXT CHECK (scenario IS NULL OR scenario IN ('task-assignment','review-request','planning-request','test-assignment','custom','runtime-request','planning-request-role','epic-phase')),
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash)=64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
  context_hash TEXT NOT NULL CHECK (length(context_hash)=64 AND context_hash NOT GLOB '*[^0-9a-f]*'),
  usage_json TEXT CHECK (usage_json IS NULL OR length(CAST(usage_json AS BLOB))<=512),
  created_at TEXT NOT NULL,
  version TEXT NOT NULL CHECK (version='1.0')
);
