-- Secrets table for storing metadata only (no plaintext values)
-- Secrets are stored in OS keyring or secure storage

CREATE TABLE IF NOT EXISTS secrets (
  reference_id TEXT PRIMARY KEY NOT NULL,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service, name)
);

CREATE INDEX IF NOT EXISTS idx_secrets_service ON secrets(service);
