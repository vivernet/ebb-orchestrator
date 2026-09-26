import type { ApprovalType, ApprovalSubjectType } from "./approval-types.js";

export interface RequestApprovalCommand {
  readonly type: ApprovalType;
  readonly subjectId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly requestedBy: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ApproveApprovalCommand {
  readonly approvalId: string;
  readonly subjectId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly type: ApprovalType;
  readonly actor: string;
  readonly note?: string | null;
}
