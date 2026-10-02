ALTER TABLE run_process_owners
  ADD COLUMN capture_state TEXT NOT NULL DEFAULT 'UNBOUND'
  CHECK (capture_state IN ('UNBOUND', 'BOUND', 'INVALID'));
