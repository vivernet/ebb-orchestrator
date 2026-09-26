import type { DatabaseTx } from "../../platform/database/database.js";
import type { Approval } from "./approval-types.js";
import type { ApproveApprovalCommand, RequestApprovalCommand } from "./approval-commands.js";

export interface ApprovalTransactionPort {
  requestInTransaction(tx: DatabaseTx, command: RequestApprovalCommand): Approval;
  approveInTransaction(tx: DatabaseTx, command: ApproveApprovalCommand): Approval;
}
