/**
 * SQLite-хранилище best-effort Run traces.
 *
 * `run_id` является idempotency key: повторная запись идентичного payload —
 * no-op/success; другой payload того же Run — стабильный conflict без update.
 * Trace пишется в отдельной transaction после durable AgentRunCompleted и
 * не является completion authority.
 */

import { isDeepStrictEqual } from "node:util";
import type { Database } from "../../../platform/database/database.js";
import type { ModelUsage } from "../usage-counter.js";
import { serializeUsageForStorage, TracingPayloadSchema, type TracingPayload } from "./tracing-payload.js";

/** Итог `save`: вставка, идемпотентный no-op либо стабильный conflict. */
export type TracingSaveOutcome = "inserted" | "idempotent" | "conflict";

/** Контракт хранилища trace; `run_id` — idempotency key. */
export interface ITracingStore {
  save(payload: TracingPayload): TracingSaveOutcome;
}

/** Реализация поверх SQLite-таблицы `run_traces`. */
export class TracingStore implements ITracingStore {
  constructor(private readonly db: Database) {}

  save(payload: TracingPayload): TracingSaveOutcome {
    const parsed = TracingPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error("TRACE_PAYLOAD_INVALID");
    const data = parsed.data;
    const usageJson = serializeUsageForStorage(data.usage);
    return this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO run_traces(run_id,scenario,prompt_hash,context_hash,usage_json,created_at,version)
         VALUES($runId,$scenario,$promptHash,$contextHash,$usageJson,$createdAt,$version)
         ON CONFLICT(run_id) DO NOTHING`,
        {
          runId: data.runId,
          scenario: data.scenario,
          promptHash: data.promptHash,
          contextHash: data.contextHash,
          usageJson,
          createdAt: data.createdAt,
          version: data.version,
        },
      );
      const changes = tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
      if (changes === 1) return "inserted" as const;

      const existing = tx.get<{
        scenario: string | null;
        prompt_hash: string;
        context_hash: string;
        usage_json: string | null;
        created_at: string;
        version: string;
      }>(
        "SELECT scenario,prompt_hash,context_hash,usage_json,created_at,version FROM run_traces WHERE run_id=$runId",
        { runId: data.runId },
      );
      if (!existing) throw new Error("RUN_TRACE_STORE_INCONSISTENT");
      if (existing.scenario === data.scenario && existing.prompt_hash === data.promptHash &&
          existing.context_hash === data.contextHash && existing.created_at === data.createdAt &&
          existing.version === data.version && sameUsage(existing.usage_json, data.usage)) {
        return "idempotent" as const;
      }
      return "conflict" as const;
    });
  }
}

function sameUsage(stored: string | null, usage: ModelUsage | null): boolean {
  if (stored === null) return usage === null;
  if (usage === null) return false;
  try {
    return isDeepStrictEqual(JSON.parse(stored), usage);
  } catch {
    return false;
  }
}
