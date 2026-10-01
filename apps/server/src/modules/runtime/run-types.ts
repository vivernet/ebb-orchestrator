/**
 * Agent runtime типы для Объект runtime сервис.
 */

import type { ToolId } from "../execution/run-capability.js";
import type { ProjectConfig } from "../execution/project-actions.js";
import type { PrepareRunContextInput } from "./run-context-assembler.js";

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

interface BaseStartRunOptions {
  runId?: string;
  model: string;
  epicId: string | null;
  triggerReason: string;
  contextVersion: string;
  outputSchemaVersion: string;
  capability?: { workspace: string; allowedTools?: ToolId[]; projectConfig?: ProjectConfig };
  prompt?: string;
  /** Exact caller-owned inputs consumed inside the same preparation transaction. */
  contextInput?: PrepareRunContextInput;
}

export type StartRunOptions = BaseStartRunOptions & (
  | { taskId: string; role: string; requestId?: never; projectId?: never }
  | { taskId: null; role: 'coordinator'; requestId: string; projectId: string; epicId: null; triggerReason: 'planning-request' }
  | { taskId: null; role: 'product_manager' | 'architect'; requestId: string; projectId: string; epicId: null; triggerReason: 'planning-request-role' }
  | { taskId: null; role: string; epicId: string; requestId?: never; projectId?: never }
);
