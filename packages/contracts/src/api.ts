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

/** Уровни и политики, уже поддерживаемые Usage & Budget Engine. */
export type UsageBudgetScope = "global" | "project" | "epic" | "task";
export type UsageBudgetPolicy = "soft" | "hard";

/** Сохранённая конфигурация лимита без вычисления решения о запуске. */
export interface UsageBudgetLimitProjection {
  scope: UsageBudgetScope;
  scopeId: string;
  limitCost: number;
  softLimitCost: number;
  policy: UsageBudgetPolicy;
  spentCost: number;
  reservedCost: number;
}

/** Иерархический контекст и применимые к нему конфигурации лимитов. */
export interface UsageBudgetContextProjection {
  scope: UsageBudgetScope;
  scopeId: string;
  projectId: string | null;
  epicId: string | null;
  taskId: string | null;
  applicableLimits: UsageBudgetLimitProjection[];
  effectiveLimit: UsageBudgetLimitProjection | null;
}

/** Активная запись резервирования, доступная для read-only Usage UI. */
export interface ActiveUsageBudgetReservationProjection {
  id: string;
  projectId: string;
  epicId: string | null;
  taskId: string | null;
  estimateCost: number;
  status: "RESERVED";
  role: string;
  model: string;
  triggerReason: string;
  reworkCategory: string | null;
  createdAt: string;
}

/** Авторитетная read-only проекция страницы Usage, включая budget state. */
export interface UsagePageProjection {
  global: UsageMetricBucketProjection;
  project: UsageMetricBucketProjection;
  epic: UsageMetricBucketProjection;
  task: UsageMetricBucketProjection;
  budget: {
    configurations: UsageBudgetLimitProjection[];
    contexts: UsageBudgetContextProjection[];
    activeReservations: ActiveUsageBudgetReservationProjection[];
  };
}

/** Агрегированные метрики; `aggregation` описывает только состав включённых записей. */
export interface UsageMetricBucketProjection extends UsageSummary {
  tokens: number;
  aggregation: "all_records" | "records_with_project_id" | "records_with_epic_id" | "records_with_task_id";
}

/** Причина ожидания, пригодная для отображения и диагностики. */
export interface WaitReason { code: string; message: string; details?: Record<string, string | number>; }
export const SCHEDULER_PROJECTION_CONTRACT_VERSION = 1 as const;
export type SchedulerProjectionStatus = "RUNNABLE" | "WAIT" | "BLOCK";
export type ProjectionBlockReason =
  | { code: "BLOCKED"; message: string }
  | { code: "BLOCKED_BY_WORKFLOW"; message: string }
  | { code: "BLOCKED_BY_PROJECT_STATE"; message: string }
  | { code: "PROJECT_NOT_ACTIVE"; message: string }
  | { code: "ONBOARDING_NOT_ACTIVE"; message: "Онбординг проекта не активирован" }
  | { code: "PROJECT_CONFIG_DEGRADED"; message: "Конфигурация проекта повреждена или требует восстановления" };
export type SchedulerEligibilityProjection =
  | { status: "RUNNABLE"; reason: null }
  | { status: "WAIT"; reason: WaitReason }
  | { status: "BLOCK"; reason: ProjectionBlockReason };
/** Краткое представление активного агентского запуска. */
export interface ActiveAgent { runId: string; role: string; taskId: string | null; status: string; }
/** Снимок данных dashboard, собранный из авторитетных read models. */
export interface DashboardProjection {
  activeAgents: ActiveAgent[];
  activeWork: Array<{ id: string; title: string; status: string; eligibility: SchedulerEligibilityProjection }>;
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
export interface LifecycleProjection { status: string; stage: string | null; updatedAt: string | null; stages?: LifecycleStageProjection[]; recoveryFailureCode?: "EPIC_RECOVERY_FAILED" | null; }
/** Авторитетная read model страницы проекта. */
export interface ProjectOverviewProjection {
  project: { id: string; name: string; displayName: string; status: string } | null;
  git: GitProjection;
  epics: Array<{ id: string; display_id: string; title: string; status: string }>;
  tasks: Array<{ id: string; epic_id: string | null; display_id: string; title: string; status: string; required: number; eligibility: SchedulerEligibilityProjection }>;
  approvals: ApprovalProjection[];
  blockers: Array<{ id: string; status: string; reason: string | null }>;
  events: EventProjection[];
  usage: UsageSummary;
}
/** Авторитетная read model страницы Epic. */
export interface EpicOverviewProjection { epic: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; tasks: EpicTaskProjection[]; approvals: ApprovalProjection[]; blockers: Array<{ id: string; status: string; reason: string | null }>; events: EventProjection[]; usage: UsageSummary; }
/** Авторитетная read model страницы Task, включая причины ожидания. */
export interface TaskOverviewProjection { task: unknown; contract: unknown; lifecycle: LifecycleProjection; git: GitProjection; runs: TaskRunProjection[]; findings: unknown[]; defects: unknown[]; dependencies: DependencyProjection[]; approvals: ApprovalProjection[]; events: EventProjection[]; usage: UsageSummary; scheduler: SchedulerEligibilityProjection; }
/** Авторитетные scheduler fields, доступные Settings без выдумывания model/security policy. */
export interface SchedulerSettingsProjection { schemaVersion: number | null; globalMax: number | null; projectMax: number | null; roleCapacity: Record<string, number> | null; }
/** Одна запись выбора модели: имя модели, провайдер и признак настроенного ключа (без значения). */
export interface ModelOptionProjection { model: string; provider: string; keyConfigured: boolean; }
/** Безопасная проекция durable выбора провайдера Run: только стабильные ID,
 * никогда endpoint URL, токен, аккаунт или секрет (plan-24 Task 5). */
export interface ProviderSelectionProjection {
  providerId: string;
  modelId: string;
  authMethodId: string;
  configRevision: number;
}
/** Read-only Settings projection с явными unavailable/null для неподтверждённых scopes. */
export interface SettingsProjection {
  effectiveHierarchy: { global: SchedulerSettingsProjection; project: null; role: null; taskEpic: null };
  securitySettings: { mostRestrictiveWins: boolean | null; localModeEnabled: boolean | null };
  providerSelection: { defaultModel: string; models: ModelOptionProjection[] };
}
/** Read-only статус установленного Hermes; без секретов и endpoint URL провайдеров. */
export interface HermesStatusProjection {
  hermesVersion: string | null;
  defaultProvider: string;
  defaultModel: string;
  keyConfigured: boolean;
  modelSelection: ModelOptionProjection[];
}
/** Снимок очереди Scheduler с активными, ожидающими и заблокированными Task. */
export interface ExecutionQueueProjection { running: ActiveAgent[]; waiting: Array<{ taskId: string; reason: WaitReason }>; blocked: Array<{ taskId: string; reason: ProjectionBlockReason }>; }

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
  hermesStatus: "/api/v1/hermes/status",
  onboardingDiscover: "/api/v1/onboarding/discover",
  onboarding: (id: string) => `/api/v1/onboarding/${pathSegment(id)}`,
  onboardingApproval: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/approval`,
  onboardingApprove: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/approve`,
  onboardingActivate: (id: string) => `/api/v1/onboarding/${pathSegment(id)}/activate`,
} as const;

/**
 * Способы аутентификации провайдеров (plan-24, Task 1).
 * Совпадает с `ProviderAuthMethod` серверного каталога провайдеров.
 */
export type ProviderAuthMethod =
  | "api-key"
  | "credential-fields"
  | "subscription-token"
  | "oauth-device-code"
  | "oauth-pkce"
  | "cloud-identity"
  | "local-endpoint";

/** Категория провайдера по основной модельной линии (plan-24, Task 1). */
export type ProviderCategory =
  | "chat"
  | "image"
  | "video"
  | "embedding"
  | "platform"
  | "gateway"
  | "local";

/** Возможности провайдера (plan-24, Task 1). */
export type ProviderCapability =
  | "chat"
  | "streaming"
  | "toolCalling"
  | "structuredOutput"
  | "vision"
  | "audio"
  | "imageGeneration"
  | "videoGeneration"
  | "embeddings"
  | "reranking";

/** Версия публичной проекции каталога провайдеров. */
export const PROVIDER_CATALOG_PROJECTION_VERSION = 1 as const;

/**
 * Безопасная display-проекция провайдера для Web/API: только идентичность и
 * несекретные метаданные. Без credential/config-схем, значений и endpoint URL.
 */
export interface ProviderCatalogEntryProjection {
  readonly id: string;
  readonly displayName: string;
  readonly category: ProviderCategory;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly capabilities: readonly ProviderCapability[];
}

/**
 * Статичная проекция каталога (86 записей, закреплённый источник LobeHub
 * d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1). Содержит только display-метаданные;
 * значения секретов и endpoints отсутствуют.
 */
export const PROVIDER_CATALOG_PROJECTION: readonly ProviderCatalogEntryProjection[] = [
  { id: "ai21", displayName: "Ai21Labs", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "ai302", displayName: "302.AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming"] },
  { id: "ai360", displayName: "360 AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "aihubmix", displayName: "AIHubMix", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "structuredOutput", "toolCalling", "videoGeneration", "vision"] },
  { id: "akashchat", displayName: "AkashChat", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "antgroup", displayName: "AntGroup", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "anthropic", displayName: "Anthropic", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "azure", displayName: "Azure OpenAI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "vision"] },
  { id: "azureai", displayName: "Azure AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "baichuan", displayName: "Baichuan", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "bailiancodingplan", displayName: "Aliyun Bailian Coding Plan", category: "chat", authMethods: ["subscription-token"], capabilities: ["chat", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "bedrock", displayName: "Bedrock", category: "chat", authMethods: ["credential-fields", "cloud-identity"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "bfl", displayName: "Black Forest Labs", category: "image", authMethods: ["api-key"], capabilities: ["imageGeneration"] },
  { id: "cerebras", displayName: "Cerebras", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "chatgpt", displayName: "ChatGPT", category: "chat", authMethods: ["oauth-device-code"], capabilities: ["chat", "streaming"] },
  { id: "cloudflare", displayName: "Cloudflare Workers AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "cohere", displayName: "Cohere", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "cometapi", displayName: "CometAPI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "comfyui", displayName: "ComfyUI", category: "local", authMethods: ["local-endpoint", "api-key"], capabilities: ["imageGeneration"] },
  { id: "deepseek", displayName: "DeepSeek", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "fal", displayName: "Fal", category: "image", authMethods: ["api-key"], capabilities: ["imageGeneration", "videoGeneration"] },
  { id: "fireworksai", displayName: "Fireworks AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "giteeai", displayName: "Gitee AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "vision"] },
  { id: "github", displayName: "GitHub", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "githubcopilot", displayName: "GitHub Copilot", category: "chat", authMethods: ["oauth-device-code"], capabilities: ["chat", "streaming", "structuredOutput", "toolCalling", "vision"] },
  { id: "glmcodingplan", displayName: "GLM Coding Plan", category: "chat", authMethods: ["subscription-token"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "google", displayName: "Google", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "groq", displayName: "Groq", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "higress", displayName: "Higress", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "huggingface", displayName: "HuggingFace", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming"] },
  { id: "hunyuan", displayName: "Hunyuan", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "infiniai", displayName: "InfiniAI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "internlm", displayName: "InternLM", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "jina", displayName: "Jina AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming"] },
  { id: "kimicodingplan", displayName: "Kimi Code", category: "chat", authMethods: ["subscription-token"], capabilities: ["chat", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "lmstudio", displayName: "LM Studio", category: "local", authMethods: ["local-endpoint"], capabilities: ["chat", "streaming"] },
  { id: "lobehub", displayName: "LobeHub", category: "platform", authMethods: ["subscription-token"], capabilities: ["chat", "streaming"] },
  { id: "longcat", displayName: "LongCat", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "meta", displayName: "Meta", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "minimax", displayName: "Minimax", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "minimaxcodingplan", displayName: "MiniMax Token Plan", category: "chat", authMethods: ["subscription-token"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "mistral", displayName: "Mistral", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "modelscope", displayName: "ModelScope", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "moonshot", displayName: "Moonshot", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "nebius", displayName: "Nebius", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "embeddings", "streaming", "toolCalling", "vision"] },
  { id: "newapi", displayName: "New API", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "structuredOutput"] },
  { id: "novita", displayName: "Novita", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "nvidia", displayName: "Nvidia", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "ollama", displayName: "Ollama", category: "local", authMethods: ["local-endpoint"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "ollamacloud", displayName: "Ollama Cloud", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "openai", displayName: "OpenAI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "structuredOutput", "toolCalling", "vision"] },
  { id: "opencodecodingplan", displayName: "OpenCode Go", category: "chat", authMethods: ["subscription-token"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "opencodezen", displayName: "OpenCode Zen", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "openrouter", displayName: "OpenRouter", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "perplexity", displayName: "Perplexity", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "vision"] },
  { id: "ppio", displayName: "PPIO", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "vision"] },
  { id: "qiniu", displayName: "Qiniu", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "qwen", displayName: "Aliyun Bailian", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "replicate", displayName: "Replicate", category: "image", authMethods: ["api-key"], capabilities: ["imageGeneration"] },
  { id: "sambanova", displayName: "SambaNova", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "search1api", displayName: "Search1API", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming"] },
  { id: "sensenova", displayName: "SenseNova", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "vision"] },
  { id: "siliconcloud", displayName: "SiliconCloud", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "spark", displayName: "Spark", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "stepfun", displayName: "Stepfun", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "straico", displayName: "Straico", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming"] },
  { id: "streamlake", displayName: "StreamLake", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "supergrok", displayName: "SuperGrok", category: "chat", authMethods: ["oauth-device-code"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "taichu", displayName: "Taichu", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "tencentcloud", displayName: "TencentCloud", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming"] },
  { id: "togetherai", displayName: "Together AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "unsloth", displayName: "Unsloth", category: "local", authMethods: ["local-endpoint"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "upstage", displayName: "Upstage", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "v0", displayName: "Vercel (v0)", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "vercelaigateway", displayName: "Vercel AI Gateway", category: "gateway", authMethods: ["api-key"], capabilities: ["chat", "embeddings", "streaming", "toolCalling", "vision"] },
  { id: "vertexai", displayName: "Vertex AI", category: "chat", authMethods: ["api-key", "cloud-identity"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "vllm", displayName: "vLLM", category: "local", authMethods: ["local-endpoint"], capabilities: ["chat", "streaming", "toolCalling"] },
  { id: "volcengine", displayName: "Volcengine", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "structuredOutput", "toolCalling", "videoGeneration", "vision"] },
  { id: "volcenginecodingplan", displayName: "Volcengine Coding Plan", category: "chat", authMethods: ["subscription-token"], capabilities: ["chat", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "wenxin", displayName: "Wenxin", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "xai", displayName: "xAI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "xiaomimimo", displayName: "Xiaomi MiMo", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "videoGeneration", "vision"] },
  { id: "xinference", displayName: "Xinference", category: "local", authMethods: ["local-endpoint"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "zenmux", displayName: "ZenMux", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "vision"] },
  { id: "zeroone", displayName: "01.AI", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "streaming", "toolCalling", "vision"] },
  { id: "zhipu", displayName: "ZhiPu", category: "chat", authMethods: ["api-key"], capabilities: ["chat", "imageGeneration", "streaming", "toolCalling", "videoGeneration", "vision"] },
];
