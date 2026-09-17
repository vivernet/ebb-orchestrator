/**
 * Usage domain types — UsageRecord, BudgetDecision, BudgetConfig, TriggerReason.
 */

/** Trigger reasons for AI Runs. */
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

/** Budget decision after evaluating a reservation request. */
export type BudgetDecision = "ALLOW" | "ASK" | "DENY";

/** Budget scope levels. */
export type BudgetScope = "global" | "project" | "epic" | "task";

/** Budget limit policy. */
export type BudgetPolicy = "soft" | "hard";

/** Budget config entry for a specific scope. */
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

/** Usage record for an AI Run. */
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
  estimatedCost: number;
  actualCost: number;
  createdAt: string;
}

/** Result of a budget reservation attempt. */
export interface ReserveResult {
  decision: BudgetDecision;
  reservationId: string | null;
  /** Explanation for ASK or DENY decisions. */
  reason?: string;
}

/** Result of a reservation reconciliation. */
export interface ReconcileResult {
  status: "RECONCILED" | "ALREADY_RECONCILED";
  actualCost: number;
  reservationId: string;
}

/** Options for creating a reservation. */
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

/** Options for reconciliation token details. */
export interface ReconcileTokenDetails {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
}
