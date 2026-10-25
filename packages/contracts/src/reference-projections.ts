/**
 * Контракты экранных проекций plan-27 (Task 1).
 *
 * Строгие, ограниченные схемы для typed screen projections и команд:
 * неизвестные поля отвергаются, даты — UTC ISO инстанты, бюджетные scopes
 * ограничены `global|project|epic|task`, статусы паузы/checkpoint —
 * discriminated unions. Run-специфичные usage-поля сохраняют null-vs-zero
 * через `availabilityFromNullable` (никакого `?? 0` fallback).
 */

import { z } from "zod";
import { utcTimestampSchema, usageSummarySchema } from "./api.js";

/** Opaque hex-хэш манифеста (ровно 64 шестнадцатеричных символа). */
const hex64 = /^[a-f0-9]{64}$/i;

/**
 * Эвристика «секретной формы» значения для trust-boundary схем:
 * не считает секретами обычные слова, только устойчивые паттерны ключей/токенов.
 */
export function looksLikeSecret(text: string): boolean {
  return [
    /\b(?:sk|rk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[^\s"',}]+/iu,
  ].some((pattern) => pattern.test(text));
}

/** Стабильные коды причин недоступности поля проекции. */
export const availabilityReasons = [
  "NOT_RECORDED",
  "NO_SANITIZED_PERSISTED_SOURCE",
  "NO_DURABLE_CHECK_EXECUTION_SOURCE",
  "NO_APPROVED_POLICY",
] as const;
export const availabilityReasonSchema = z.enum(availabilityReasons);

const availableValueSchema = z.object({ availability: z.literal("available"), value: z.number() }).strict();
const unavailableValueSchema = z.object({ availability: z.literal("unavailable"), reason: availabilityReasonSchema }).strict();
const availabilityValueSchema = z.discriminatedUnion("availability", [availableValueSchema, unavailableValueSchema]);
export type AvailabilityValue = z.infer<typeof availabilityValueSchema>;

/** Run-usage поле: null -> unavailable, число (включая 0) -> available. */
export const runUsageFieldSchema = z.discriminatedUnion("availability", [
  z.object({ availability: z.literal("available"), value: z.number() }).strict(),
  z.object({ availability: z.literal("unavailable"), reason: z.literal("NOT_RECORDED") }).strict(),
]);
export type RunUsageField = z.infer<typeof runUsageFieldSchema>;

/** Отображение nullable-числа в контрактный usage shape без `?? 0` fallback. */
export function availabilityFromNullable(value: number | null): RunUsageField {
  if (value === null) return { availability: "unavailable", reason: "NOT_RECORDED" };
  return { availability: "available", value };
}

/** Usage-часть Run detail: каждое поле индивидуально сохраняет null-vs-zero. */
export const runUsageProjectionSchema = z.object({
  inputTokens: runUsageFieldSchema,
  cachedInputTokens: runUsageFieldSchema,
  outputTokens: runUsageFieldSchema,
  effectiveCost: runUsageFieldSchema,
}).strict();
export type RunUsageProjection = z.infer<typeof runUsageProjectionSchema>;

/** Статусы Run (должны совпадать с `RunStatus` в agent-run.ts). */
export const runStatusSchema = z.enum(["STARTED", "IN_PROGRESS", "COMPLETING", "COMPLETED", "FAILED", "CANCELLED"]);

const waitReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
}).strict();

const projectionBlockReasonSchema = z.union([
  z.object({ code: z.literal("BLOCKED"), message: z.string() }).strict(),
  z.object({ code: z.literal("BLOCKED_BY_WORKFLOW"), message: z.string() }).strict(),
  z.object({ code: z.literal("BLOCKED_BY_PROJECT_STATE"), message: z.string() }).strict(),
  z.object({ code: z.literal("PROJECT_NOT_ACTIVE"), message: z.string() }).strict(),
  z.object({ code: z.literal("ONBOARDING_NOT_ACTIVE"), message: z.string() }).strict(),
  z.object({ code: z.literal("PROJECT_CONFIG_DEGRADED"), message: z.string() }).strict(),
]);

const activeAgentSchema = z.object({
  runId: z.string(),
  role: z.string(),
  taskId: z.string().nullable(),
  status: z.string(),
}).strict();

/** Удерживаемая resource lock (capacity-проекция очереди выполнения). */
export const resourceLockProjectionSchema = z.object({
  id: z.string(),
  resource: z.string(),
  runId: z.string(),
  kind: z.string(),
  heldAt: utcTimestampSchema,
}).strict();

/** Событие scheduler-очереди из durable outbox (без payload-секретов). */
export const schedulerEventProjectionSchema = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: utcTimestampSchema,
}).strict();

/** Durable состояние паузы диспетчеризации. */
export const dispatchStateProjectionSchema = z.object({
  paused: z.boolean(),
  updatedAt: utcTimestampSchema.nullable(),
}).strict();

/** Полная проекция очереди выполнения: capacity, locks, события и dispatch state. */
export const executionQueueProjectionSchema = z.object({
  running: z.array(activeAgentSchema),
  waiting: z.array(z.object({ taskId: z.string(), reason: waitReasonSchema }).strict()),
  blocked: z.array(z.object({ taskId: z.string(), reason: projectionBlockReasonSchema }).strict()),
  capacity: z.object({ configured: z.number().int().nonnegative(), used: z.number().int().nonnegative() }).strict(),
  locks: z.array(resourceLockProjectionSchema),
  recentEvents: z.array(schedulerEventProjectionSchema),
  dispatchState: dispatchStateProjectionSchema,
}).strict();

const budgetLimitSchema = z.object({
  scope: z.enum(["global", "project", "epic", "task"]),
  scopeId: z.string(),
  limitCost: z.number().nonnegative(),
  softLimitCost: z.number().nonnegative(),
  policy: z.enum(["soft", "hard"]),
  spentCost: z.number().nonnegative(),
  reservedCost: z.number().nonnegative(),
}).strict();

const budgetContextSchema = z.object({
  scope: z.enum(["global", "project", "epic", "task"]),
  scopeId: z.string(),
  projectId: z.string().nullable(),
  epicId: z.string().nullable(),
  taskId: z.string().nullable(),
  applicableLimits: z.array(budgetLimitSchema),
  effectiveLimit: budgetLimitSchema.nullable(),
}).strict();

const activeReservationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  epicId: z.string().nullable(),
  taskId: z.string().nullable(),
  estimateCost: z.number().nonnegative(),
  status: z.literal("RESERVED"),
  role: z.string(),
  model: z.string(),
  triggerReason: z.string(),
  reworkCategory: z.string().nullable(),
  createdAt: utcTimestampSchema,
}).strict();

/** Возможные granularity окна usage. */
export const usageGranularitySchema = z.enum(["day", "hour", "month"]);

/** Query `GET /api/v1/usage`: строгое UTC-окно с корректным порядком границ. */
export const usageWindowQuerySchema = z.object({
  from: utcTimestampSchema,
  to: utcTimestampSchema,
  granularity: usageGranularitySchema,
}).strict().refine((window) => window.from <= window.to, {
  message: "from must not be after to",
  path: ["from"],
});

const usageBreakdownEntrySchema = z.object({
  key: z.string(),
  spend: z.number().nonnegative(),
  tokens: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
  runCount: z.number().int().nonnegative(),
}).strict();

const usageBreakdownsSchema = z.object({
  byRole: z.array(usageBreakdownEntrySchema),
  byReason: z.array(usageBreakdownEntrySchema),
  byModel: z.array(usageBreakdownEntrySchema),
}).strict();

const usageModelComparisonEntrySchema = z.object({
  role: z.string(),
  model: z.string(),
  averageCostPerRun: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
}).strict();

/** Периодизированная проекция страницы Usage & Budget (`GET /usage`). */
export const usageWindowProjectionSchema = z.object({
  window: usageWindowQuerySchema,
  summary: usageSummarySchema,
  dailySeries: z.array(z.object({ date: z.string(), usage: usageSummarySchema }).strict()),
  breakdowns: usageBreakdownsSchema,
  modelComparison: z.array(usageModelComparisonEntrySchema),
  budgets: z.object({
    configurations: z.array(budgetLimitSchema),
    contexts: z.array(budgetContextSchema),
    activeReservations: z.array(activeReservationSchema),
  }).strict(),
  efficiency: z.object({
    cacheShare: availabilityValueSchema,
    averageInitialContextTokens: availabilityValueSchema,
    averageOutputTokens: availabilityValueSchema,
    aiRunsPerTask: availabilityValueSchema,
    reworkCyclesPerTask: availabilityValueSchema,
    deterministicCheckCount: availabilityValueSchema,
    deterministicCheckCost: availabilityValueSchema,
  }).strict(),
  anomaly: availabilityValueSchema,
  taskRecoveryShare: availabilityValueSchema,
}).strict();
export type UsageWindowProjection = z.infer<typeof usageWindowProjectionSchema>;

/** Фильтр списка согласований (wire-lowercase). */
export const approvalInboxFilterSchema = z.enum(["pending", "resolved"]);
export const approvalItemStatusSchema = z.enum(["PENDING", "RESOLVED"]);
export const approvalPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const approvalInboxItemProjectionSchema = z.object({
  id: z.string(),
  category: z.string(),
  status: approvalItemStatusSchema,
  priority: approvalPrioritySchema,
  projectId: z.string().nullable(),
  title: z.string(),
  createdAt: utcTimestampSchema,
  resolvedAt: utcTimestampSchema.nullable(),
}).strict();
export type ApprovalInboxItemProjection = z.infer<typeof approvalInboxItemProjectionSchema>;

export const approvalInboxSummaryProjectionSchema = z.object({
  totalPending: z.number().int().nonnegative(),
  totalResolved: z.number().int().nonnegative(),
  oldestPendingCreatedAt: utcTimestampSchema.nullable(),
}).strict();

/** Проекция inbox согласований (pending/resolved + счётчики). */
export const approvalInboxProjectionSchema = z.object({
  filter: approvalInboxFilterSchema,
  summary: approvalInboxSummaryProjectionSchema,
  items: z.array(approvalInboxItemProjectionSchema),
}).strict();
export type ApprovalInboxProjection = z.infer<typeof approvalInboxProjectionSchema>;

export const approvalPlanDiffProjectionSchema = z.object({
  before: z.object({ title: z.string(), scope: z.string() }).strict(),
  after: z.object({ title: z.string(), scope: z.string() }).strict(),
}).strict();

export const approvalImpactProjectionSchema = z.object({
  scope: z.string(),
  role: z.string(),
  architecture: z.string(),
  delayDays: z.number().int().nonnegative().nullable(),
  budgetCost: z.number().nonnegative().nullable(),
}).strict();

export const approvalEvidenceEntryProjectionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  capturedAt: utcTimestampSchema,
  description: z.string(),
  source: z.string(),
}).strict();
export type ApprovalEvidenceEntryProjection = z.infer<typeof approvalEvidenceEntryProjectionSchema>;

export const approvalDecisionProjectionSchema = z.object({
  actor: z.string(),
  outcome: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]),
  at: utcTimestampSchema,
  note: z.string().nullable(),
}).strict();

/** Детальная проекция согласования: proposal, plan diff, impacts, evidence, decision. */
export const approvalDetailProjectionSchema = z.object({
  id: z.string(),
  category: z.string(),
  status: approvalItemStatusSchema,
  priority: approvalPrioritySchema,
  project: z.object({ id: z.string(), displayName: z.string() }).strict(),
  proposal: z.object({ title: z.string(), summary: z.string() }).strict(),
  rationale: z.string(),
  planDiff: approvalPlanDiffProjectionSchema,
  impacts: approvalImpactProjectionSchema,
  evidence: z.array(approvalEvidenceEntryProjectionSchema),
  decision: approvalDecisionProjectionSchema.nullable(),
}).strict();
export type ApprovalDetailProjection = z.infer<typeof approvalDetailProjectionSchema>;

/** Эффективная политика согласований (read-only). */
export const approvalPolicyProjectionSchema = z.object({
  defaultAction: z.enum(["PENDING", "REJECTED"]),
  requireExactHashForActivation: z.boolean(),
  allowedOutcomes: z.array(z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"])),
}).strict();
export type ApprovalPolicyProjection = z.infer<typeof approvalPolicyProjectionSchema>;

export const schedulerSettingsProjectionSchema = z.object({
  schemaVersion: z.number().int().nullable(),
  globalMax: z.number().int().nullable(),
  projectMax: z.number().int().nullable(),
  roleCapacity: z.record(z.string(), z.number().int()).nullable(),
}).strict();

export const effectiveSettingsSourceSchema = z.enum(["GLOBAL", "PROJECT", "ROLE", "TASK_EPIC"]);

/** Иерархия Settings: global + допустимые project/role/task-epic overrides. */
export const settingsHierarchyProjectionSchema = z.object({
  global: schedulerSettingsProjectionSchema,
  project: schedulerSettingsProjectionSchema.nullable(),
  role: schedulerSettingsProjectionSchema.nullable(),
  taskEpic: schedulerSettingsProjectionSchema.nullable(),
}).strict();
export type SettingsHierarchyProjection = z.infer<typeof settingsHierarchyProjectionSchema>;

/**
 * Строгая схема редактируемых полей кандидата Project Config (v2).
 * Отвергает неизвестные поля и секретные значения; defaultBranch — только
 * когда целевая ветка разрешена branch-политикой (иначе null/read-only).
 */
export const projectConfigV2Schema = z.object({
  projectDisplayName: z.string().min(1).max(200),
  defaultBranch: z.string().min(1).max(200).nullable(),
  roles: z.array(z.object({
    role: z.string().min(1).max(100),
    provider: z.string().max(100).nullable(),
    model: z.string().max(200).nullable(),
  }).strict()).max(50),
  scheduler: z.object({
    concurrency: z.number().int().min(1).max(64),
    enablePriorityAging: z.boolean(),
    criticalPathBoost: z.boolean(),
  }).strict(),
  recovery: z.object({
    resumeSessions: z.boolean(),
    maxAttempts: z.number().int().min(1).max(20),
    recoveryCycleMinutes: z.number().int().min(1).max(1440),
    abortOnNoProgressDays: z.number().int().min(1).max(90),
  }).strict(),
  github: z.object({
    syncEnabled: z.boolean(),
    issueLinking: z.boolean(),
    pullRequestSync: z.boolean(),
  }).strict(),
  budgets: z.array(budgetLimitSchema).max(100),
}).strict().superRefine((value, ctx) => {
  if (looksLikeSecret(JSON.stringify(value))) {
    ctx.addIssue({ code: "custom", message: "secret-shaped values are not allowed in a config candidate" });
  }
});
export type ProjectConfigV2 = z.infer<typeof projectConfigV2Schema>;

const manifestHashSchema = z.string().regex(hex64, "expected a 64-character hex manifest hash");

/** Запрос editor-кандидата: ожидаемый manifest hash + строгий V2 settings. */
export const projectConfigCandidateEditorRequestSchema = z.object({
  expectedManifestHash: manifestHashSchema,
  settings: projectConfigV2Schema,
}).strict();

export const projectConfigDiffSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  modified: z.array(z.string()),
}).strict();

/** Сохранённый, но ещё не активированный кандидат (активация — только exact-hash approval). */
export const projectConfigCandidateProjectionSchema = z.object({
  candidateId: z.string(),
  projectId: z.string(),
  manifestHash: manifestHashSchema,
  expectedManifestHash: manifestHashSchema,
  diff: projectConfigDiffSchema,
  status: z.literal("PENDING_REVIEW"),
  createdAt: utcTimestampSchema,
}).strict();
export type ProjectConfigCandidateProjection = z.infer<typeof projectConfigCandidateProjectionSchema>;

export const journalReconcileResolutionSchema = z.enum(["ACCEPT_EXTERNAL", "RESTORE_APPROVED"]);

/** Команда reconciliation DEGRADED-журнала: только явный phase + явная resolution. */
export const journalReconcileRequestSchema = z.object({
  expectedPhase: z.literal("DEGRADED"),
  observedManifestHash: manifestHashSchema,
  resolution: journalReconcileResolutionSchema,
}).strict();

/** Итог reconciliation: терминальная фаза журнала + CAS-обновлённые указатели. */
export const journalReconcileResponseSchema = z.object({
  journalId: z.string(),
  projectId: z.string(),
  phase: z.enum(["RECONCILED_EXTERNAL", "RECONCILED_RESTORED"]),
  configStatus: z.literal("READY"),
  currentCandidateId: z.string(),
  activeRevisionId: z.string().nullable(),
  resolution: journalReconcileResolutionSchema,
  resolvedBy: z.string(),
  resolvedManifestHash: manifestHashSchema,
  resolvedAt: utcTimestampSchema,
}).strict();

export const runControlCommandSchema = z.enum(["CHECKPOINT", "PAUSE", "RESUME"]);

/** Доказанный durable checkpoint: только хэши/opaque ссылки, никогда transcript/credentials. */
export const runCheckpointProjectionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  attempt: z.number().int().positive(),
  sessionId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  containmentRef: z.string(),
  launchNonceHash: z.string(),
  contextHash: z.string(),
  workspaceSnapshotHash: z.string(),
  eventCursor: z.string(),
  checkpointHash: z.string(),
  createdAt: utcTimestampSchema,
}).strict();
export type RunCheckpointProjection = z.infer<typeof runCheckpointProjectionSchema>;

/**
 * Durable overlay-состояние управления Run (orthogonal к agent_runs.status).
 * Discriminated union: PAUSED/RESUME_PENDING обязаны иметь checkpointId.
 */
export const runControlStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ACTIVE"), version: z.number().int().nonnegative(), updatedAt: utcTimestampSchema, checkpointId: z.null() }).strict(),
  z.object({ state: z.literal("PAUSE_REQUESTED"), version: z.number().int().nonnegative(), updatedAt: utcTimestampSchema, checkpointId: z.null() }).strict(),
  z.object({ state: z.literal("PAUSED"), version: z.number().int().nonnegative(), updatedAt: utcTimestampSchema, checkpointId: z.string() }).strict(),
  z.object({ state: z.literal("RESUME_PENDING"), version: z.number().int().nonnegative(), updatedAt: utcTimestampSchema, checkpointId: z.string() }).strict(),
  z.object({ state: z.literal("CLOSED"), version: z.number().int().nonnegative(), updatedAt: utcTimestampSchema, checkpointId: z.string().nullable() }).strict(),
]);
export type RunControlState = z.infer<typeof runControlStateSchema>;

/** Результат команды checkpoint/pause/resume: статус команды + состояние управления. */
export const runControlCommandResultSchema = z.object({
  command: runControlCommandSchema,
  status: z.enum(["REQUESTED", "COMPLETED", "FAILED"]),
  control: runControlStateSchema,
  failureCode: z.string().nullable(),
}).strict();
export type RunControlCommandResult = z.infer<typeof runControlCommandResultSchema>;

/** Query пейджинга Run timeline: opaque outbox event ID курсор + bounded limit. */
export const runEventsQuerySchema = z.object({
  afterId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

/** Событие Run timeline; payload opaque, но контракт исключает секреты/сырые env-объекты. */
export const runEventProjectionSchema = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: utcTimestampSchema,
  payload: z.unknown(),
}).strict();
export type RunEventProjection = z.infer<typeof runEventProjectionSchema>;

/** Страница Run events: bounded items + следующий opaque курсор. */
export const runEventsPageProjectionSchema = z.object({
  items: z.array(runEventProjectionSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type RunEventsPageProjection = z.infer<typeof runEventsPageProjectionSchema>;

/** Код ошибки неизвестного/чужого курсора Run events. */
export const RUN_EVENTS_INVALID_CURSOR = "INVALID_CURSOR" as const;

export const runTerminalEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  text: z.string(),
  at: utcTimestampSchema,
}).strict();
export type RunTerminalEntry = z.infer<typeof runTerminalEntrySchema>;

/**
 * Sanitized terminal: только persisted-источник, явно назначенный владельцем Run
 * как sanitized. Никогда не переинтерпретирует agent_runs.output / model output / raw stdout.
 */
export const runTerminalProjectionSchema = z.discriminatedUnion("availability", [
  z.object({ availability: z.literal("available"), entries: z.array(runTerminalEntrySchema) }).strict(),
  z.object({ availability: z.literal("unavailable"), reason: z.literal("NO_SANITIZED_PERSISTED_SOURCE") }).strict(),
]);
export type RunTerminalProjection = z.infer<typeof runTerminalProjectionSchema>;

/** Run detail DTO: usage-поля сохраняют null-vs-zero; control — nullable discriminated union. */
export const runDetailProjectionSchema = z.object({
  id: z.string(),
  role: z.string(),
  runtime: z.string(),
  model: z.string(),
  taskId: z.string().nullable(),
  epicId: z.string().nullable(),
  status: runStatusSchema,
  sessionId: z.string().nullable(),
  attempt: z.number().int().positive().nullable(),
  triggerReason: z.string().nullable(),
  startedAt: utcTimestampSchema.nullable(),
  endedAt: utcTimestampSchema.nullable(),
  exitCode: z.number().int().nullable(),
  usage: runUsageProjectionSchema,
  control: runControlStateSchema.nullable(),
}).strict();
export type RunDetailProjection = z.infer<typeof runDetailProjectionSchema>;

export const cancelAllRunsOutcomeSchema = z.enum(["CANCELLED", "NOT_ACTIVE", "FAILED"]);

/** Cancel-all ограничен подтверждённым набором Run: non-empty, без дубликатов. */
export const cancelAllRunsRequestSchema = z.object({
  expectedRunIds: z.array(z.string()).min(1).max(200).refine((ids) => new Set(ids).size === ids.length, {
    message: "expectedRunIds must not contain duplicates",
    path: ["expectedRunIds"],
  }),
}).strict();

/** Упорядоченные per-ID исходы cancel-all; результат всегда в порядке expectedRunIds. */
export const cancelAllRunsResultSchema = z.object({
  results: z.array(z.object({ runId: z.string(), outcome: cancelAllRunsOutcomeSchema }).strict()),
}).strict();
export type CancelAllRunsResult = z.infer<typeof cancelAllRunsResultSchema>;

/** Запрос/ответ durable dispatch-паузы scheduler. */
export const dispatchStateRequestSchema = z.object({ paused: z.boolean() }).strict();
export const dispatchStateResponseSchema = z.object({
  paused: z.boolean(),
  updatedAt: utcTimestampSchema,
}).strict();
export type DispatchStateResponse = z.infer<typeof dispatchStateResponseSchema>;

/** Строка проекта в пагинированном индексе (без repository-путей). */
export const projectIndexRowProjectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  status: z.string(),
  updatedAt: utcTimestampSchema.nullable(),
}).strict();
export type ProjectIndexRowProjection = z.infer<typeof projectIndexRowProjectionSchema>;

/** Query `GET /projects`: opaque курсор + bounded limit. */
export const projectIndexQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

/** Пагинированная страница проектного индекса; пустая страница отличима от ошибки. */
export const projectIndexPageProjectionSchema = z.object({
  items: z.array(projectIndexRowProjectionSchema),
  nextCursor: z.string().nullable(),
}).strict();
export type ProjectIndexPageProjection = z.infer<typeof projectIndexPageProjectionSchema>;

export const projectControlStateSchema = z.enum(["ACTIVE", "PAUSED"]);

/** Подтверждение scoped pause/resume проекта (текущие Run не отменяются). */
export const projectPauseResponseSchema = z.object({
  projectId: z.string(),
  state: projectControlStateSchema,
  updatedAt: utcTimestampSchema,
}).strict();
export type ProjectPauseResponse = z.infer<typeof projectPauseResponseSchema>;

export const epicControlStateSchema = z.enum(["ACTIVE", "PAUSED"]);

export const epicPauseResponseSchema = z.object({
  epicId: z.string(),
  state: epicControlStateSchema,
  updatedAt: utcTimestampSchema,
}).strict();
export type EpicPauseResponse = z.infer<typeof epicPauseResponseSchema>;

export const epicReplanRequestSchema = z.object({}).strict();

/** Epic replan создаёт planning request под существующим coordinator/approval lifecycle. */
export const epicReplanResponseSchema = z.object({
  epicId: z.string(),
  requestId: z.string(),
  status: z.enum(["PLANNING", "PLAN_PENDING_APPROVAL"]),
  createdAt: utcTimestampSchema,
}).strict();
export type EpicReplanResponse = z.infer<typeof epicReplanResponseSchema>;

/** Команда изменения приоритета Task: validated канонический priority. */
export const taskPriorityRequestSchema = z.object({
  priority: z.number().int().min(1).max(1000),
}).strict();

export const taskPriorityResponseSchema = z.object({
  taskId: z.string(),
  priority: z.number().int().min(1).max(1000),
  updatedAt: utcTimestampSchema,
}).strict();
export type TaskPriorityResponse = z.infer<typeof taskPriorityResponseSchema>;

export const taskControlStateSchema = z.enum(["READY", "IN_PROGRESS", "PAUSED"]);

/** Task pause/resume сохраняет prior stage; ответ подтверждает backend-переход. */
export const taskControlResponseSchema = z.object({
  taskId: z.string(),
  state: taskControlStateSchema,
  priorStage: z.string().nullable(),
  updatedAt: utcTimestampSchema,
}).strict();
export type TaskControlResponse = z.infer<typeof taskControlResponseSchema>;
