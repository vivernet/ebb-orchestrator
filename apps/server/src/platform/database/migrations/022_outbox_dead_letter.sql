ALTER TABLE outbox_events ADD COLUMN dead_lettered_at TEXT;
ALTER TABLE outbox_events ADD COLUMN dead_letter_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_dead_letter
  ON outbox_events(dead_lettered_at, available_at);
