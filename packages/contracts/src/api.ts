import { z } from "zod";

export const usageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

export interface WaitReason { code: string; message: string; }
export interface ActiveAgent { runId: string; role: string; taskId: string | null; status: string; }
export interface DashboardProjection {
  activeAgents: ActiveAgent[];
  activeWork: Array<{ id: string; title: string; status: string; waitReason: WaitReason | null }>;
  approvals: number;
  usage: UsageSummary;
  projects: Array<{ id: string; name: string; displayName: string; status: string }>;
}
export interface ProjectOverviewProjection {
  project: { id: string; name: string; displayName: string; status: string };
  epics: unknown[];
  tasks: unknown[];
  usage: UsageSummary;
}
export interface EpicOverviewProjection { epic: unknown; tasks: unknown[]; usage: UsageSummary; }
export interface TaskOverviewProjection { task: unknown; runs: unknown[]; findings: unknown[]; defects: unknown[]; usage: UsageSummary; waitReason: WaitReason | null; }
export interface ExecutionQueueProjection { running: ActiveAgent[]; waiting: Array<{ taskId: string; reason: WaitReason }>; blocked: Array<{ taskId: string; reason: WaitReason }>; }

export const apiPaths = {
  dashboard: "/api/v1/dashboard",
  projects: "/api/v1/projects/:id",
  epics: "/api/v1/epics/:id",
  tasks: "/api/v1/tasks/:id",
  execution: "/api/v1/execution",
  approvals: "/api/v1/approvals",
} as const;
