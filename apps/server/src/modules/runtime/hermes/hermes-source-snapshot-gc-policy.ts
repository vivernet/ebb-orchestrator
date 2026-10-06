import type { Database } from "../../../platform/database/database.js";
import { isCanonicalRunProcessStopEvidence } from "../run-process-owner.js";

const TERMINAL_RUN_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Проверяет, можно ли удалить точный Hermes snapshot по durable Run/process-owner state.
 * NULL source identity никогда не сопоставляется с конкретным snapshot и поэтому блокирует GC.
 *
 * @param database Уже открытая migrated SQLite Orchestrator.
 * @param cacheKey Точный canonical source key кандидата на удаление.
 * @returns true только если все известные ссылки завершены и имеют durable STOPPED evidence.
 */
export function mayCollectHermesSourceSnapshot(database: Database, cacheKey: string): boolean {
  if (typeof cacheKey !== "string" || cacheKey.length === 0) return false;
  const rows = database.all<{
    run_id: string;
    run_status: string;
    snapshot_key: string | null;
    owner_state: string | null;
    stop_evidence: string | null;
  }>(
    `SELECT run.id AS run_id, run.status AS run_status,
            owner.hermes_source_snapshot_key AS snapshot_key,
            owner.state AS owner_state, owner.stop_evidence
       FROM agent_runs run
      LEFT JOIN run_process_owners owner ON owner.run_id=run.id
      WHERE owner.hermes_source_snapshot_key=$cacheKey`,
    { cacheKey },
  );
  for (const row of rows) {
    if (row.snapshot_key !== cacheKey || !TERMINAL_RUN_STATES.has(row.run_status) || row.owner_state !== "STOPPED" ||
        !isCanonicalRunProcessStopEvidence(row.stop_evidence)) return false;
  }
  return true;
}
