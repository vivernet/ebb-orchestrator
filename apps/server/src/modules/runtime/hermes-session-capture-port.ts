import type { ProcessScopeIdentity } from "../../platform/process/process-inspector.js";

/** Фиксированные причины, по которым live-сессию Hermes нельзя сохранить или использовать для resume. */
export type HermesSessionCaptureFailure =
  | "INVALID_UTF8"
  | "LINE_TOO_LARGE"
  | "INIT_EVENT_TOO_LARGE"
  | "MALFORMED_JSON"
  | "UNEXPECTED_INITIAL_EVENT"
  | "UNEXPECTED_EVENT"
  | "INVALID_SESSION_ID"
  | "DUPLICATE_INIT"
  | "MISSING_INIT"
  | "STREAM_FINISHED"
  | "OWNER_IDENTITY_MISMATCH"
  | "PROCESS_SCOPE_NOT_LIVE"
  | "CAPTURE_CALLBACK_FAILED"
  | "CAPTURE_CAS_FAILED";

/** Минимальное свидетельство одного Run-bound live Hermes stream observer. */
export type HermesSessionCapture = {
  readonly runId: string;
  readonly attempt: number | null;
  readonly sourceTag: string;
  readonly hermesHome: string;
  readonly owner: ProcessScopeIdentity;
} & (
  | { readonly status: "captured"; readonly sessionId: string }
  | { readonly status: "invalid"; readonly reason: HermesSessionCaptureFailure }
);

/** Узкий порт для awaited передачи live session evidence от Hermes adapter в RunService. */
export interface HermesSessionCapturePort {
  setHermesSessionCaptureHandler(handler: (capture: HermesSessionCapture) => Promise<void>): void;
}
