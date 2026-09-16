/**
 * Agent runtime types for the runtime service.
 */

export interface RunOutcome {
  success: boolean;
  exitCode: number;
  output: string;
}

export interface ResumeRunOptions {
  sessionId: string;
  attempt: number;
}

export interface StartRunOptions {
  role: string;
  model: string;
  taskId: string;
  epicId: string | null;
  triggerReason: string;
  contextVersion: string;
  outputSchemaVersion: string;
}
