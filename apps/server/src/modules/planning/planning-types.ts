import type { TaskContract } from "../work/work-types.js";

export type PlanningClassification = "TASK" | "EPIC" | "NEEDS_INPUT";
export type PlanningStatus = "PENDING" | "APPROVED" | "REJECTED";

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
  architectureChange?: boolean;
  requestedBy?: string;
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
  createdAt: string;
}

export interface PlanValidationResult {
  contracts: Map<string, TaskContract>;
}
