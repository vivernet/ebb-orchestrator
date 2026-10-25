-- Project Config write journal (plan-27 Task 4).
--
-- Аддитивная forward-only миграция: добавляет только новую таблицу journal и
-- индексы; не перестраивает и не меняет существующие таблицы Project Config
-- (project_config_candidates / project_config_revisions / project_config_state),
-- поэтому FK-enabled транзакционный путь runMigrations достаточен.
--
-- Жизненный цикл:
--   * PREPARED — approved revision создана, candidate ещё PENDING_REVIEW,
--     active_revision_id не менялся; writer ещё не касался файлов репозитория.
--   * WRITING — writer начал применять new_files (allowlisted .ebb-orchestrator/).
--   * APPLIED — target-manifest проверен, одна транзакция зафиксировала
--     APPLIED + candidate APPROVED_ACTIVE + advance active revision.
--   * DEGRADED — внешняя/необъяснимая модификация (или сбой proof): dispatch
--     заблокирован до явного reconcile.
--   * RECONCILED_EXTERNAL / RECONCILED_RESTORED — терминальные фазы после
--     явного reconcile; проверка требует все resolution-поля разом.

CREATE TABLE IF NOT EXISTS project_config_write_journal (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  expected_manifest_hash TEXT NOT NULL,
  old_files_json TEXT NOT NULL,
  new_files_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('PREPARED','WRITING','APPLIED','DEGRADED','RECONCILED_EXTERNAL','RECONCILED_RESTORED')),
  failure_code TEXT,
  resolution TEXT,
  resolved_by TEXT,
  resolved_manifest_hash TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (phase IN ('RECONCILED_EXTERNAL','RECONCILED_RESTORED') AND resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_manifest_hash IS NOT NULL AND resolved_at IS NOT NULL)
    OR (phase NOT IN ('RECONCILED_EXTERNAL','RECONCILED_RESTORED') AND resolution IS NULL AND resolved_by IS NULL AND resolved_manifest_hash IS NULL AND resolved_at IS NULL)
  ),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_id) REFERENCES project_config_candidates(candidate_id),
  FOREIGN KEY (approval_id) REFERENCES approvals(id)
);

CREATE INDEX IF NOT EXISTS idx_project_config_write_journal_project_created
  ON project_config_write_journal(project_id, created_at DESC);

-- Не более одного активного (non-terminal) журнала на проект: capture/approval
-- блокируются, пока существует PREPARED/WRITING/DEGRADED.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_config_write_journal_active_project
  ON project_config_write_journal(project_id)
  WHERE phase IN ('PREPARED','WRITING','DEGRADED');
