/**
 * Agent runtime types for the runtime service.
 */

import type { ToolId } from "../execution/run-capability.js";
import type { ProjectConfig } from "../execution/project-actions.js";

export interface RunOutcome {
  success: boolean;
  exitCode: number;
  output: string;
  validatedSubmission?: boolean;
  diagnostics?: {
    runId: string;
    sessionId: string | null;
    stderr: string;
    exitCode: number;
    artifactReferences: string[];
  };
}

export interface ResumeRunOptions {
  sessionId: string;
  attempt: number;
}

export interface StartRunOptions {
  runId?: string;
  role: string;
  model: string;
  taskId: string;
  epicId: string | null;
  triggerReason: string;
  contextVersion: string;
  outputSchemaVersion: string;
  capability?: { workspace: string; allowedTools?: ToolId[]; projectConfig?: ProjectConfig };
  prompt?: string;
}
