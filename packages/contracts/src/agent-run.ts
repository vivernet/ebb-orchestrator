/**
 * AgentRun model - records execution metadata and results.
 */

export type RunStatus =
  | "STARTED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type RunTrigger =
  | "task-assignment"
  | "review-request"
  | "planning-request"
  | "test-assignment"
  | "custom";

export interface AgentRun {
  id: string;
  role: string;
  runtime: string;
  model: string;
  taskId: string | null;
  epicId: string | null;
  status: RunStatus;
  sessionId: string | null;
  attempt: number | null;
  triggerReason: RunTrigger | null;
  contextVersion: string | null;
  outputSchemaVersion: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  exitCode: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}
