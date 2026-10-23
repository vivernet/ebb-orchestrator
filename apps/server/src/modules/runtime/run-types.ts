/**
 * Agent runtime типы для Объект runtime сервис.
 */

import type { ToolId } from "../execution/run-capability.js";
import type { ProjectConfig } from "../execution/project-actions.js";
import type { PrepareRunContextInput } from "./run-context-assembler.js";
import type { ProviderErrorClassification } from "./provider-errors.js";

export interface RunOutcome {
  success: boolean;
  exitCode: number;
  output: string;
  validatedSubmission?: boolean;
  diagnostics?: {
    runId: string;
    sessionId: string | null;
    stderr: string;
    stderrCategory?: "EMPTY" | "AUTH" | "RATE_LIMIT" | "NETWORK" | "TIMEOUT" | "MCP" | "PROCESS_ERROR" | "OTHER";
    exitCode: number;
    artifactReferences: string[];
    submitResultToolUses?: number;
    submitResultCalls?: number;
    submitResultErrors?: number;
    toolCounts?: RuntimeToolEventCounts;
    /** Классификация ошибки провайдера, распознанной в stderr (без текста ошибки). */
    providerError?: ProviderErrorClassification;
  };
}

/** Короткий диагностический summary только для разрешённых agent-facing tools. */
export const RUNTIME_TOOL_ERROR_CATEGORIES = [
  "INVALID_ARGUMENTS",
  "PERMISSION_DENIED",
  "NOT_AVAILABLE",
  "PROCESS_FAILURE",
  "OTHER",
] as const;
export type RuntimeToolErrorCategory = typeof RUNTIME_TOOL_ERROR_CATEGORIES[number];
export type RuntimeToolEventCounts = Readonly<Record<RuntimeDiagnosticToolId, Readonly<{
  uses: number;
  results: number;
  successes: number;
  errors: number;
  errorCategories: Readonly<Record<RuntimeToolErrorCategory, number>>;
}>>>;
export type RuntimeDiagnosticToolId =
  | "workspace.read"
  | "workspace.patch"
  | "workspace.search"
  | "project.test"
  | "git.add"
  | "git.commit"
  | "git.head"
  | "submit_result";

export interface ResumeRunOptions {
  attempt: number;
}

/** Явный Run override провайдера (plan-24 Task 5): опционален; без него
 * применяются дефолты роли/глобальные из настроек провайдеров. */
export interface StartRunProviderSelection {
  readonly providerId: string;
  readonly modelId?: string;
  readonly authMethodId?: string;
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
  /** Явная привязка провайдера; разрешение и фиксация — в транзакции Run. */
  providerSelection?: StartRunProviderSelection;
}

export type StartRunOptions = BaseStartRunOptions & (
  | { taskId: string; role: string; requestId?: never; projectId?: never }
  | { taskId: null; role: 'coordinator'; requestId: string; projectId: string; epicId: null; triggerReason: 'planning-request' }
  | { taskId: null; role: 'product_manager' | 'architect'; requestId: string; projectId: string; epicId: null; triggerReason: 'planning-request-role' }
  | { taskId: null; role: string; epicId: string; requestId?: never; projectId?: never }
);
