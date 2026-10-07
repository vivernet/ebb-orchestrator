import type { Database } from "../../../platform/database/database.js";
import { isAuthoritativeRunProcessStopEvidence } from "../run-process-owner.js";

const TERMINAL_RUN_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Проверяет, можно ли удалить точный Hermes snapshot по durable Run/process-owner state.
 * Исторический owner с NULL source key блокирует GC, пока его Run не завершён
 * и owner не получил каноническое durable STOPPED evidence.
 *
 * @param database Уже открытая migrated SQLite Orchestrator.
 * @param cacheKey Точный canonical source key кандидата на удаление.
 * @returns true только если все известные ссылки завершены и имеют durable STOPPED evidence.
 */
export function mayCollectHermesSourceSnapshot(database: Database, cacheKey: string): boolean {
  if (typeof cacheKey !== "string" || cacheKey.length === 0) return false;
  const orphanOwner = database.get<{ present: number }>(
    `SELECT 1 AS present FROM run_process_owners owner
      LEFT JOIN agent_runs run ON run.id=owner.run_id
     WHERE run.id IS NULL LIMIT 1`,
  );
  if (orphanOwner) return false;
  const legacyOwners = database.all<{
    run_status: string;
    owner_state: string;
    stop_evidence: string | null;
    containment_kind: string;
  }>(
    `SELECT run.status AS run_status, owner.state AS owner_state, owner.stop_evidence, owner.containment_kind
       FROM run_process_owners owner
       JOIN agent_runs run ON run.id=owner.run_id
      WHERE owner.hermes_source_snapshot_key IS NULL`,
  );
  for (const owner of legacyOwners) {
    if (!TERMINAL_RUN_STATES.has(owner.run_status) || owner.owner_state !== "STOPPED" ||
        !isAuthoritativeRunProcessStopEvidence(owner.stop_evidence, owner.containment_kind)) return false;
  }
  const rows = database.all<{
    run_id: string;
    run_status: string;
    snapshot_key: string | null;
    owner_state: string | null;
    stop_evidence: string | null;
    containment_kind: string;
  }>(
    `SELECT run.id AS run_id, run.status AS run_status,
            owner.hermes_source_snapshot_key AS snapshot_key,
            owner.state AS owner_state, owner.stop_evidence, owner.containment_kind
       FROM agent_runs run
      LEFT JOIN run_process_owners owner ON owner.run_id=run.id
      WHERE owner.hermes_source_snapshot_key=$cacheKey`,
    { cacheKey },
  );
  for (const row of rows) {
    if (row.snapshot_key !== cacheKey || !TERMINAL_RUN_STATES.has(row.run_status) || row.owner_state !== "STOPPED" ||
        !isAuthoritativeRunProcessStopEvidence(row.stop_evidence, row.containment_kind)) return false;
  }
  return true;
}

/**
 * Проверяет наличие любой durable Run-ссылки на точный Hermes snapshot key.
 * Ошибка запроса распространяется вызывающему коду, который обязан сохранить snapshot.
 *
 * @param database Уже открытая migrated SQLite Orchestrator.
 * @param cacheKey Точный canonical source key.
 * @returns true, если хотя бы один process owner ссылается на этот ключ.
 */
export function hasHermesSourceSnapshotReferences(database: Database, cacheKey: string): boolean {
  if (typeof cacheKey !== "string" || cacheKey.length === 0) return false;
  return database.get<{ present: number }>(
    `SELECT 1 AS present FROM run_process_owners WHERE hermes_source_snapshot_key=$cacheKey LIMIT 1`,
    { cacheKey },
  ) !== undefined;
}
