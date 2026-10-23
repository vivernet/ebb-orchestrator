/**
 * Канонический best-effort trace успешно завершённого Run.
 *
 * Sidecar без raw payload: хранит только идентификатор Run, enum-сценарий,
 * канонические hashes prompt/контекста и ограниченный агрегированный usage.
 * Никакие runtime/model/provider labels, raw prompt, input/output, stderr,
 * credentials, endpoint URL или headers не сохраняются и не экспортируются.
 */

import { z } from "zod";
import { digestRunPromptBytesV1 } from "../../context/context-provenance.js";
import type { ModelUsage } from "../usage-counter.js";

/** Версия хранимого trace-пакета; единственная поддерживаемая версия. */
export const TRACE_VERSION = "1.0";

/** Все сценарии, разрешённые в `run_traces.scenario`. */
export const TRACE_SCENARIOS = [
  "task-assignment",
  "review-request",
  "planning-request",
  "test-assignment",
  "custom",
  "runtime-request",
  "planning-request-role",
  "epic-phase",
] as const;

/** Сценарий запуска, допустимый в trace. */
export type TraceScenario = typeof TRACE_SCENARIOS[number];

/** Фиксированный список фаз Epic, дающих сценарий `epic-phase`. */
export const EPIC_TRACE_PHASES = [
  "plan",
  "pm",
  "architect",
  "epic_review",
  "architecture_review",
  "epic_qa",
  "integration",
  "child_task",
  "child_task_reconcile",
  "review",
  "review_rework",
  "review_recheck",
  "qa",
] as const;

/** Стабильные безопасные диагностические коды trace; только они логируются. */
export const TRACE_DIAGNOSTIC_CODES = {
  SCENARIO_UNMAPPED: "TRACE_SCENARIO_UNMAPPED",
  PAYLOAD_INVALID: "TRACE_PAYLOAD_INVALID",
  CONFLICT: "TRACE_CONFLICT",
  STORE_FAILED: "TRACE_STORE_FAILED",
} as const;

/** Диагностический код пропуска trace из-за неизвестного non-null trigger. */
export const TRACE_SCENARIO_UNMAPPED = TRACE_DIAGNOSTIC_CODES.SCENARIO_UNMAPPED;

/**
 * Полный payload trace одного Run. Сериализованный `usage` ограничен
 * 512 UTF-8 байтами до SQL; `null` означает неизвестный usage (SQL NULL).
 */
export interface TracingPayload {
  readonly runId: string;
  readonly scenario: TraceScenario | null;
  readonly promptHash: string;
  readonly contextHash: string;
  readonly usage: ModelUsage | null;
  readonly createdAt: string;
  readonly version: typeof TRACE_VERSION;
}

const canonicalUuidV4 = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "run_id must be a canonical lowercase UUID v4",
);

const lowercaseSha256 = z.string().regex(
  /^[a-f0-9]{64}$/,
  "hash must be a lowercase 64-char SHA-256 hex string",
);

const isoMillisUtc = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  "created_at must be an ISO-8601 UTC timestamp with milliseconds",
);

/** Строгий usage без nested/unknown полей; runtime/model/provider labels отклоняются. */
const modelUsageSchema = z.object({
  inputTokens: z.number().int().safe().nonnegative(),
  cachedInputTokens: z.number().int().safe().nonnegative(),
  outputTokens: z.number().int().safe().nonnegative(),
  cost: z.number().finite().nonnegative().nullable(),
}).strict();

/** Возвращает сериализованный usage для SQL или null; >512 UTF-8 байт отклоняется. */
export function serializeUsageForStorage(usage: ModelUsage | null): string | null {
  if (usage === null) return null;
  const json = JSON.stringify(usage);
  if (new TextEncoder().encode(json).byteLength > 512) {
    throw new TypeError("RUN_TRACE_USAGE_TOO_LARGE");
  }
  return json;
}

function isUsageWithinStorageLimit(usage: ModelUsage | null): boolean {
  try {
    serializeUsageForStorage(usage);
    return true;
  } catch {
    return false;
  }
}

/**
 * Строгая allowlist-схема trace payload: без unknown/nested полей.
 * Разрешены только run_id, scenario, prompt_hash, context_hash, usage,
 * created_at и version.
 */
export const TracingPayloadSchema = z.object({
  runId: canonicalUuidV4,
  scenario: z.enum(TRACE_SCENARIOS).nullable(),
  promptHash: lowercaseSha256,
  contextHash: lowercaseSha256,
  usage: modelUsageSchema.nullable().refine(isUsageWithinStorageLimit, {
    message: "serialized usage must not exceed 512 UTF-8 bytes",
  }),
  createdAt: isoMillisUtc,
  version: z.literal(TRACE_VERSION),
}).strict();

/** Итог маппинга persisted trigger_reason в сценарий trace. */
export type TraceScenarioResolution =
  | { ok: true; scenario: TraceScenario | null }
  | { ok: false; diagnostic: typeof TRACE_SCENARIO_UNMAPPED };

/**
 * Маппит persisted `trigger_reason` (string | null) в TraceScenario:
 * 5 значений RunTrigger, runtime-request и planning-request-role — одноимённо;
 * `null` — SQL NULL; `epic-${phase}` для фиксированного списка фаз — `epic-phase`;
 * неизвестный non-null trigger пропускает trace и даёт только стабильный
 * диагностический код TRACE_SCENARIO_UNMAPPED. Raw trigger не возвращается.
 */
export function resolveTraceScenario(triggerReason: string | null): TraceScenarioResolution {
  if (triggerReason === null) return { ok: true, scenario: null };
  if (triggerReason !== "epic-phase" && (TRACE_SCENARIOS as readonly string[]).includes(triggerReason)) {
    return { ok: true, scenario: triggerReason as TraceScenario };
  }
  if (triggerReason.startsWith("epic-")) {
    const phase = triggerReason.slice("epic-".length);
    if ((EPIC_TRACE_PHASES as readonly string[]).includes(phase)) {
      return { ok: true, scenario: "epic-phase" };
    }
  }
  return { ok: false, diagnostic: TRACE_SCENARIO_UNMAPPED };
}

/**
 * Вычисляет полный 64-char lowercase SHA-256 от точных UTF-8 bytes
 * финального prompt, делегируя текущему каноническому digest.
 */
export function computePromptHash(finalPromptBytes: Uint8Array): string {
  return digestRunPromptBytesV1(finalPromptBytes);
}
