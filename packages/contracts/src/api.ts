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

/** Версия публичного HTTP-контракта локальной аутентификации. */
export const AUTH_CONTRACT_VERSION = 1 as const;
/** Версия публичного HTTP-контракта onboarding. */
export const ONBOARDING_CONTRACT_VERSION = 1 as const;
/** Idle TTL сессии; абсолютный срок жизни задаётся отдельно. */
export const AUTH_IDLE_TTL_SECONDS = 1800 as const;
/** Неизменяемый абсолютный TTL сессии и срок cookie. */
export const AUTH_ABSOLUTE_TTL_SECONDS = 86400 as const;
/** Размер opaque session/CSRF токена до base64url-кодирования. */
export const AUTH_TOKEN_BYTES = 32 as const;
/** Точные директивы cookie, которые должен использовать HTTP-адаптер. */
export const AUTH_COOKIE_CONTRACT = {
  name: "ebb_local_session",
  path: "/api/v1",
  httpOnly: true,
  sameSite: "strict",
  secure: false,
  maxAgeSeconds: AUTH_ABSOLUTE_TTL_SECONDS,
} as const;

const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

function isValidUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondsText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number(millisecondsText ?? "0");
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second
    && date.getUTCMilliseconds() === milliseconds;
}

const utcTimestampSchema = z.string()
  .regex(UTC_TIMESTAMP_PATTERN)
  .refine(isValidUtcTimestamp, "Must be a valid RFC3339 UTC timestamp");

/** Коды ошибок auth boundary; набор является частью версии контракта. */
export const authErrorCodes = [
  "AUTH_INVALID_REQUEST",
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_ORIGIN_INVALID",
  "AUTH_UNAVAILABLE",
  "AUTH_SESSION_REQUIRED",
  "AUTH_SESSION_INVALID",
  "AUTH_CSRF_INVALID",
] as const;
export const authErrorCodeSchema = z.enum(authErrorCodes);
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

/** Request DTO входа; singleton user не имеет username. */
export const loginRequestSchema = z.object({ password: z.string() }).strict();
export type LoginRequestDto = z.infer<typeof loginRequestSchema>;
/** Успешный ответ входа с CSRF token, видимым только клиентскому коду. */
export const loginResponseSchema = z.object({
  contractVersion: z.literal(AUTH_CONTRACT_VERSION),
  csrfToken: z.string(),
  expiresAt: utcTimestampSchema,
}).strict();
export type LoginResponseDto = z.infer<typeof loginResponseSchema>;
/** Успешный ответ восстановления сесcии и ротации CSRF token. */
export const sessionResponseSchema = z.object({
  contractVersion: z.literal(AUTH_CONTRACT_VERSION),
  authenticated: z.literal(true),
  csrfToken: z.string(),
  expiresAt: utcTimestampSchema,
}).strict();
export type SessionResponseDto = z.infer<typeof sessionResponseSchema>;
/** Versioned error envelope без storage/security деталей. */
export const authErrorResponseSchema = z.object({
  contractVersion: z.literal(AUTH_CONTRACT_VERSION),
  error: z.object({ code: authErrorCodeSchema, message: z.string() }).strict(),
}).strict();
export type AuthErrorResponseDto = z.infer<typeof authErrorResponseSchema>;

/** Стабильные коды ошибок onboarding boundary. */
export const onboardingErrorCodes = [
  "ONBOARDING_INVALID_REPOSITORY",
  "ONBOARDING_DISCOVERY_FAILED",
  "ONBOARDING_NOT_FOUND",
  "ONBOARDING_INVALID_PROPOSAL",
  "ONBOARDING_APPROVAL_PENDING",
  "ONBOARDING_NOT_PENDING",
  "ONBOARDING_NOT_APPROVED",
  "ONBOARDING_UNAVAILABLE",
] as const;
export const onboardingErrorCodeSchema = z.enum(onboardingErrorCodes);
export type OnboardingErrorCode = z.infer<typeof onboardingErrorCodeSchema>;
const remoteSchema = z.object({ name: z.string(), url: z.string() }).strict();
export const onboardingStatusSchema = z.enum(["DRAFT", "APPROVAL_PENDING", "APPROVED", "ACTIVE"]);
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;
/** Предложение onboarding без client-selected repository path. */
export const onboardingProposalSchema = z.object({
  defaultBranch: z.string(),
  workflow: z.string(),
  roles: z.array(z.string()),
  guidelines: z.array(z.string()),
}).strict();
export type OnboardingProposal = z.infer<typeof onboardingProposalSchema>;
/** Запрос discovery принимает только путь, authority создаёт backend. */
export const onboardingDiscoverRequestSchema = z.object({ repositoryPath: z.string() }).strict();
export type OnboardingDiscoverRequestDto = z.infer<typeof onboardingDiscoverRequestSchema>;
/** Запрос явного approval proposal. */
export const onboardingApprovalRequestSchema = z.object({ proposed: onboardingProposalSchema }).strict();
export type OnboardingApprovalRequestDto = z.infer<typeof onboardingApprovalRequestSchema>;
/** Запрос approve с optional безопасной заметкой. */
export const onboardingApproveRequestSchema = z.object({ note: z.string().optional() }).strict();
export type OnboardingApproveRequestDto = z.infer<typeof onboardingApproveRequestSchema>;
/** Полная serializable projection onboarding, возвращаемая сервером. */
export const onboardingProjectionSchema = z.object({
  contractVersion: z.literal(ONBOARDING_CONTRACT_VERSION),
  projectId: z.string(),
  status: onboardingStatusSchema,
  repository: z.object({ path: z.string(), remotes: z.array(remoteSchema) }).strict(),
  detected: z.object({
    root: z.string(),
    defaultBranch: z.string(),
    remotes: z.array(remoteSchema),
    packageManager: z.string(),
    languageHints: z.array(z.string()),
    testCommands: z.array(z.string()),
    untrustedExistingConfig: z.boolean(),
  }).strict(),
  proposed: onboardingProposalSchema.nullable(),
  approval: z.object({ id: z.string(), status: z.enum(["PENDING", "APPROVED"]) }).strict().nullable(),
}).strict();
export type OnboardingProjection = z.infer<typeof onboardingProjectionSchema>;
/** Versioned error envelope onboarding. */
export const onboardingErrorResponseSchema = z.object({
  contractVersion: z.literal(ONBOARDING_CONTRACT_VERSION),
  error: z.object({ code: onboardingErrorCodeSchema, message: z.string() }).strict(),
}).strict();
export type OnboardingErrorResponseDto = z.infer<typeof onboardingErrorResponseSchema>;

/** Кодирует один untrusted identifier как безопасный URL path segment. */
function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Канонические API paths, используемые web-клиентом и backend-контрактами.
 * Шаблоны сохраняются для документации, builders — для runtime URL без ручной конкатенации.
 */
export const apiPaths = {
  sessionLogin: "/api/v1/session/login",
  session: "/api/v1/session",
  sessionLogout: "/api/v1/session/logout",
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
  runEvents: (id: string) => `/api/v1/runs/${pathSegment(id)}/events`,
  runTools: (id: string) => `/api/v1/runs/${pathSegment(id)}/tools`,
  runPermissions: (id: string) => `/api/v1/runs/${pathSegment(id)}/permissions`,
  runRecovery: (id: string) => `/api/v1/runs/${pathSegment(id)}/recovery`,
  usage: "/api/v1/usage",
  settings: "/api/v1/settings",
  onboardingDiscover: "/api/v1/onboarding/discover",
  onboarding: (id: string) => `/api/v1/onboarding/${pathSegment(id)}`,
  onboardingApproval: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/approval`,
  onboardingApprove: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/approve`,
  onboardingActivate: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/activate`,
} as const;
