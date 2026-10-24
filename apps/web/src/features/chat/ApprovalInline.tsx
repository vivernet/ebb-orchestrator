import { ru } from '../../i18n/ru.js';

interface ApprovalInlineProps {
  planId: string | null;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * Инлайн-одобрения плана внутри сообщения типа approval_request:
 * approve/reject делегируются в API планов беседы.
 */
export default function ApprovalInline({ planId, busy, onApprove, onReject }: ApprovalInlineProps) {
  if (!planId) return null;
  return (
    <div className="approval-inline">
      <button type="button" className="approval-inline__approve" disabled={busy} onClick={onApprove}>{ru.chat.approve}</button>
      <button type="button" className="approval-inline__reject" disabled={busy} onClick={onReject}>{ru.chat.reject}</button>
    </div>
  );
}
