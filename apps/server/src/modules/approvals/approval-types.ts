/**
 * Approval domain types.
 */

export type ApprovalType =
  | "FINAL_MERGE"
  | "SCOPE_CHANGE"
  | "ARCHITECTURE_CHANGE"
  | "ROLE_CHANGE"
  | "WORKFLOW_CHANGE";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export type ApprovalSubjectType = "TASK" | "EPIC" | "PROJECT";

export interface Approval {
  readonly id: string;
  readonly type: ApprovalType;
  readonly subjectId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly resolvedBy: string | null;
  readonly resolutionNote: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface ApprovalRequestInput {
  readonly type: ApprovalType;
  readonly subjectId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly requestedBy: string;
}
