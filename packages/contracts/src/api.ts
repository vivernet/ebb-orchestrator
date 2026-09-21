import { z } from "zod";

/** Схема агрегированных token/cost metrics для API и usage projections. */
export const usageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});

/** Сводка использования runtime, включая стоимость в единицах каталога. */
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/** Причина ожидания, пригодная для отображения и диагностики. */
export interface WaitReason { code: string; message: string; details?: Record<string, string | number>; }
/** Краткое представление активного агентского запуска. */
export interface ActiveAgent { runId: string; role: string; taskId: string | null; status: string; }
/** Снимок данных dashboard, собранный из авторитетных read models. */
export interface DashboardProjection {
  activeAgents: ActiveAgent[];
  activeWork: Array<{ id: string; title: string; status: string; waitReason: WaitReason | null }>;
  approvals: number;
  usage: UsageSummary;
  projects: Array<{ id: string; name: string; displayName: string; status: string }>;
}
/** Состояние Git и optional GitHub-связи проекта. */
export interface GitProjection {
  repositoryPath: string | null;
  branch: string | null;
  defaultBranch: string | null;
  github: { status: string; url: string | null } | null;
  worktreePath: string | null;
}
/** Ссылка на approval в read model проекта или работы. */
export interface ApprovalProjection { id: string; type: string; status: string; createdAt: string; }
/** Событие из audit/read model, отображаемое без права изменить состояние. */
export interface EventProjection { id: string; type: string; createdAt: string; payload: unknown; }
/** Связь зависимости Task и её текущий статус. */
export interface DependencyProjection { id: string; taskId: string; dependsOnTaskId: string; type: string; status: string | null; }
/** Состояние одного отображаемого этапа lifecycle. */
export interface LifecycleStageProjection { id: string; label: string; status: "COMPLETED" | "CURRENT" | "PENDING"; updatedAt: string | null; }
/** Read model lifecycle с текущим этапом и историей отображаемых stages. */
export interface LifecycleProjection { status: string; stage: string | null; updatedAt: string | null; stages?: LifecycleStageProjection[]; }
/** Авторитетная read model страницы проекта. */
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
/** Авторитетная read model страницы Epic. */
export interface EpicOverviewProjection { epic: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; tasks: unknown[]; approvals: ApprovalProjection[]; blockers: Array<{ id: string; status: string; reason: string | null }>; events: EventProjection[]; usage: UsageSummary; }
/** Авторитетная read model страницы Task, включая причины ожидания. */
export interface TaskOverviewProjection { task: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; runs: unknown[]; findings: unknown[]; defects: unknown[]; dependencies: DependencyProjection[]; approvals: ApprovalProjection[]; events: EventProjection[]; usage: UsageSummary; waitReason: WaitReason | null; }
/** Снимок очереди Scheduler с активными, ожидающими и заблокированными Task. */
export interface ExecutionQueueProjection { running: ActiveAgent[]; waiting: Array<{ taskId: string; reason: WaitReason }>; blocked: Array<{ taskId: string; reason: WaitReason }>; }

/** Канонические API paths, используемые web-клиентом и backend-контрактами. */
export const apiPaths = {
  dashboard: "/api/v1/dashboard",
  projects: "/api/v1/projects/:id",
  epics: "/api/v1/epics/:id",
  tasks: "/api/v1/tasks/:id",
  execution: "/api/v1/execution",
  approvals: "/api/v1/approvals",
} as const;
