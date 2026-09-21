/**
 * Доменные типы usage: UsageRecord, BudgetDecision, BudgetConfig, TriggerReason.
 */

/** Причины запуска AI Runs. */
export type TriggerReason =
  | "PLANNING"
  | "PRODUCT_DEFINITION"
  | "ARCHITECTURE_DESIGN"
  | "DEVELOPMENT"
  | "CODE_REVIEW"
  | "QA_VALIDATION"
  | "INTEGRATION"
  | "REVIEW_REWORK"
  | "QA_REWORK"
  | "RECOVERY"
  | "RECOVERY_ESCALATION"
  | "COORDINATOR_DIAGNOSIS"
  | "EPIC_REVIEW"
  | "ARCHITECTURE_REVIEW";

/** Решение по бюджету после оценки запроса на резервирование. */
export type BudgetDecision = "ALLOW" | "ASK" | "DENY";

/** Уровни области действия бюджета. */
export type BudgetScope = "global" | "project" | "epic" | "task";

/** Политика ограничения бюджета. */
export type BudgetPolicy = "soft" | "hard";

/** Запись конфигурации бюджета для конкретной области. */
export interface BudgetConfig {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  limitCost: number;
  softLimitCost: number;
  policy: BudgetPolicy;
  spentCost: number;
  reservedCost: number;
  createdAt: string;
  updatedAt: string;
}

/** Запись использования для AI Run. */
export interface UsageRecord {
  id: string;
  runId: string | null;
  reservationId: string | null;
  projectId: string;
  epicId: string | null;
  taskId: string | null;
  role: string;
  model: string;
  triggerReason: TriggerReason;
  reworkCategory: string | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  runtime: string;
  estimatedCost: number;
  actualCost: number;
  createdAt: string;
}

/** Результат попытки резервирования бюджета. */
export interface ReserveResult {
  decision: BudgetDecision;
  reservationId: string | null;
  /** Объяснение решения ASK или DENY. */
  reason?: string;
}

/** Результат reconciliation резервирования. */
export interface ReconcileResult {
  status: "RECONCILED" | "ALREADY_RECONCILED";
  actualCost: number;
  reservationId: string;
}

/** Параметры создания резервирования. */
export interface ReserveOptions {
  projectId: string;
  epicId?: string;
  taskId?: string;
  estimateCost: number;
  role: string;
  model: string;
  triggerReason: TriggerReason;
  reworkCategory?: string;
}

/** Параметры token details для reconciliation. */
export interface ReconcileTokenDetails {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  runtime?: string;
}
