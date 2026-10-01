ALTER TABLE epic_orchestrations ADD COLUMN recovery_failure_code TEXT
  CHECK (recovery_failure_code IS NULL OR recovery_failure_code = 'EPIC_RECOVERY_FAILED');
ALTER TABLE epic_orchestrations ADD COLUMN recovery_failed_at TEXT;
