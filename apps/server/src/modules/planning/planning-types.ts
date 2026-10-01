import type { TaskContract } from "../work/work-types.js";
import type { DesignResult, ProductDefinition } from "@ebb-orchestrator/contracts";

export type PlanningClassification = "TASK" | "EPIC" | "NEEDS_INPUT";
export type PlanningStatus = "PENDING" | "APPROVED" | "REJECTED";
export type PlanningRequestStatus = "RECEIVED" | "PLANNING" | "NEEDS_INPUT" | "PLAN_PENDING_APPROVAL" | "REJECTED" | "MATERIALIZED" | "FAILED";
export const EPIC_RECOVERY_FAILURE_CODE = "EPIC_RECOVERY_FAILED" as const;

export interface PlanningApprovalPolicy {
  standalone_task: boolean;
  multi_task_plan: boolean;
  epic: boolean;
  architecture_change: boolean;
}

export interface TemporaryTask {
  ref: string;
  title: string;
  goal?: string;
  context?: string;
  requirements?: string[];
  acceptanceCriteria: string[];
  dependsOn?: string[];
  role: string;
  workflow: string;
  optional?: boolean;
}

export interface PlanningPlanInput {
  projectId: string;
  tasks: TemporaryTask[];
  epic?: { title: string; goal?: string };
  /** Результаты отдельных PM/Architect planning Runs, сохранённые для human review. */
  planningDecisions?: PlanningDecisions;
  architectureChange?: boolean;
  requestedBy?: string;
}

export interface PlanningDecisions {
  productManager: ProductDefinition;
  architect: DesignResult;
}

export interface PlanningPlan extends PlanningPlanInput {
  id: string;
  status: PlanningStatus;
  approvalRequired: boolean;
  temporaryIdMap: Record<string, string>;
  createdAt: string;
}

export interface PlanningRequest {
  id: string;
  projectId: string;
  request: string;
  requestedBy: string;
  classification: PlanningClassification | null;
  planId: string | null;
  status: PlanningRequestStatus;
  coordinatorRunId: string | null;
  planningDecisionsRequired: boolean;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanValidationResult {
  contracts: Map<string, TaskContract>;
}
