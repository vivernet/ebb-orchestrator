import type { Database } from "../../src/platform/database/database.js";
import { transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";

/** Закрывает только подготовленный Run тестового runtime, который не запускает OS process. */
export function markFakeRunNeverLaunched(database: Database, runId: string): void {
  const owner = database.get<{ run_id: string; source_tag: string; state: string }>(
    "SELECT run_id,source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId },
  );
  if (owner?.run_id !== runId || owner.source_tag !== `ebb-run:${runId}` || owner.state !== "PREPARED") {
    throw new Error(`Fake runtime cannot prove never-launched scope for ${runId}`);
  }
  database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
    runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
  }));
}
