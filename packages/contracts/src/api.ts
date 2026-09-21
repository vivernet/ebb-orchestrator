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
/** Минимальный child DTO Task, подтверждённый Epic read model и UI. */
export interface EpicTaskProjection { id: string; display_id: string; title: string; status: string; }
/** Минимальный child DTO Agent Run, подтверждённый Task read model и UI. */
export interface TaskRunProjection { id: string; role: string; status: string; }
/** Состояние одного отображаемого этапа lifecycle. */
export interface LifecycleStageProjection { id: string; label: string; status: "COMPLETED" | "CURRENT" | "PENDING"; updatedAt: string | null; }
/** читает модель lifecycle с текущим этапом и историей отображаемых stages. */
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
export interface EpicOverviewProjection { epic: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; tasks: EpicTaskProjection[]; approvals: ApprovalProjection[]; blockers: Array<{ id: string; status: string; reason: string | null }>; events: EventProjection[]; usage: UsageSummary; }
/** Авторитетная read model страницы Task, включая причины ожидания. */
export interface TaskOverviewProjection { task: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; runs: TaskRunProjection[]; findings: unknown[]; defects: unknown[]; dependencies: DependencyProjection[]; approvals: ApprovalProjection[]; events: EventProjection[]; usage: UsageSummary; waitReason: WaitReason | null; }
/** Авторитетные scheduler fields, доступные Settings без выдумывания model/security policy. */
export interface SchedulerSettingsProjection { schemaVersion: number | null; globalMax: number | null; projectMax: number | null; roleCapacity: Record<string, number> | null; }
/** Read-only Settings projection с явными unavailable/null для неподтверждённых scopes. */
export interface SettingsProjection {
  effectiveHierarchy: { global: SchedulerSettingsProjection; project: null; role: null; taskEpic: null };
  securitySettings: { mostRestrictiveWins: boolean | null; localModeEnabled: boolean | null };
}
/** Снимок очереди Scheduler с активными, ожидающими и заблокированными Task. */
export interface ExecutionQueueProjection { running: ActiveAgent[]; waiting: Array<{ taskId: string; reason: WaitReason }>; blocked: Array<{ taskId: string; reason: WaitReason }>; }

/** Кодирует один untrusted identifier как безопасный URL path segment. */
function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Канонические API paths, используемые web-клиентом и backend-контрактами.
 * Шаблоны сохраняются для документации, builders — для runtime URL без ручной конкатенации.
 */
export const apiPaths = {
  session: "/api/v1/session",
  sessionBootstrap: "/api/v1/session/bootstrap",
  events: "/api/v1/events",
  dashboard: "/api/v1/dashboard",
  projectsCollection: "/api/v1/projects",
  projects: "/api/v1/projects/:id",
  project: (id: string) => `/api/v1/projects/${pathSegment(id)}`,
  projectTasks: (id: string) => `/api/v1/projects/${pathSegment(id)}/tasks`,
  projectEpics: (id: string) => `/api/v1/projects/${pathSegment(id)}/epics`,
  epics: "/api/v1/epics/:id",
  epic: (id: string) => `/api/v1/epics/${pathSegment(id)}`,
  tasks: "/api/v1/tasks/:id",
  task: (id: string) => `/api/v1/tasks/${pathSegment(id)}`,
  taskDispatch: (id: string) => `/api/v1/tasks/${pathSegment(id)}/dispatch`,
  execution: "/api/v1/execution",
  approvals: "/api/v1/approvals",
  approvalApprove: (id: string) => `/api/v1/approvals/${pathSegment(id)}/approve`,
  runs: "/api/v1/runs/:id",
  run: (id: string) => `/api/v1/runs/${pathSegment(id)}`,
  runCancel: (id: string) => `/api/v1/runs/${pathSegment(id)}/cancel`,
  usage: "/api/v1/usage",
  settings: "/api/v1/settings",
  onboardingDiscover: "/api/v1/onboarding/discover",
  onboarding: (id: string) => `/api/v1/onboarding/${pathSegment(id)}`,
  onboardingApproval: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/approval`,
  onboardingApprove: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/approve`,
  onboardingActivate: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/activate`,
} as const;
