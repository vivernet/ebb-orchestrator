import { z } from "zod";

export const usageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

export interface WaitReason { code: string; message: string; details?: Record<string, string | number>; }
export interface ActiveAgent { runId: string; role: string; taskId: string | null; status: string; }
export interface DashboardProjection {
  activeAgents: ActiveAgent[];
  activeWork: Array<{ id: string; title: string; status: string; waitReason: WaitReason | null }>;
  approvals: number;
  usage: UsageSummary;
  projects: Array<{ id: string; name: string; displayName: string; status: string }>;
}
export interface GitProjection {
  repositoryPath: string | null;
  branch: string | null;
  defaultBranch: string | null;
  github: { status: string; url: string | null } | null;
  worktreePath: string | null;
}
export interface ApprovalProjection { id: string; type: string; status: string; createdAt: string; }
export interface EventProjection { id: string; type: string; createdAt: string; payload: unknown; }
export interface DependencyProjection { id: string; taskId: string; dependsOnTaskId: string; type: string; status: string | null; }
export interface LifecycleStageProjection { id: string; label: string; status: "COMPLETED" | "CURRENT" | "PENDING"; updatedAt: string | null; }
export interface LifecycleProjection { status: string; stage: string | null; updatedAt: string | null; stages?: LifecycleStageProjection[]; }
export interface ProjectOverviewProjection {
  project: { id: string; name: string; displayName: string; status: string } | null;
  git: GitProjection;
  epics: Array<{ id: string; display_id: string; title: string; status: string }>;
  tasks: Array<{ id: string; epic_id: string | null; display_id: string; title: string; status: string; required: number }>;
  approvals: ApprovalProjection[];
  blockers: Array<{ id: string; status: string; reason: string | null }>;
  events: EventProjection[];
  usage: UsageSummary;
}
export interface EpicOverviewProjection { epic: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; tasks: unknown[]; approvals: ApprovalProjection[]; blockers: Array<{ id: string; status: string; reason: string | null }>; events: EventProjection[]; usage: UsageSummary; }
export interface TaskOverviewProjection { task: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; runs: unknown[]; findings: unknown[]; defects: unknown[]; dependencies: DependencyProjection[]; approvals: ApprovalProjection[]; events: EventProjection[]; usage: UsageSummary; waitReason: WaitReason | null; }
export interface ExecutionQueueProjection { running: ActiveAgent[]; waiting: Array<{ taskId: string; reason: WaitReason }>; blocked: Array<{ taskId: string; reason: WaitReason }>; }

export const apiPaths = {
  dashboard: "/api/v1/dashboard",
  projects: "/api/v1/projects/:id",
  epics: "/api/v1/epics/:id",
  tasks: "/api/v1/tasks/:id",
  execution: "/api/v1/execution",
  approvals: "/api/v1/approvals",
} as const;
