import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@ebb-orchestrator/contracts';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import { chatRoleLabel, chatStatusLabel, ru } from '../../i18n/ru.js';
import ApprovalInline from './ApprovalInline.js';

interface ThreadViewProps {
  messages: ChatMessage[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  error: string | null;
  approvalBusy: boolean;
  onLoadOlder: () => void;
  onRetry: () => void;
  onApprove: (message: ChatMessage) => void;
  onReject: (message: ChatMessage) => void;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({ message, approvalBusy, onApprove, onReject }: { message: ChatMessage; approvalBusy: boolean; onApprove: (message: ChatMessage) => void; onReject: (message: ChatMessage) => void; }) {
  const className = [
    'thread-msg',
    `thread-msg--${message.role}`,
    ...(message.kind === 'error' ? ['thread-msg--err'] : []),
    ...(message.kind === 'need_input' ? ['thread-msg--input'] : []),
  ].join(' ');
  return (
    <div className={className} data-kind={message.kind} data-role={message.role}>
      <div className="thread-msg__content">{message.content}</div>
      <div className="thread-msg__meta">
        {message.status !== null && (
          <span className={`thread-status ${message.status === 'FAILED' || message.status === 'REJECTED' ? 'thread-status--bad' : ''}`}>
            {chatStatusLabel(message.status)}
          </span>
        )}
        <span>{chatRoleLabel(message.role)}</span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </div>
      {message.kind === 'approval_request' && message.status === 'PLAN_PENDING_APPROVAL' && (
        <ApprovalInline
          planId={message.planId}
          busy={approvalBusy}
          onApprove={() => onApprove(message)}
          onReject={() => onReject(message)}
        />
      )}
    </div>
  );
}

/**
 * История сообщений беседы: роли/виды сообщений, статусная прогрессия и
 * cursor-пагинация «загрузить раньше».
 */
export default function ThreadView({ messages, loading, loadingOlder, hasOlder, error, approvalBusy, onLoadOlder, onRetry, onApprove, onReject }: ThreadViewProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = bottomRef.current;
    if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (loading && messages.length === 0) return <PageState status="loading" message={ru.chat.loadingHistory} />;
  if (error !== null && messages.length === 0) return <div className="thread-view"><ErrorAlert message={error} onRetry={onRetry} /></div>;
  if (messages.length === 0) return <EmptyState message={ru.chat.noMessages} />;

  return (
    <div className="thread-view" role="log" aria-live="polite">
      {hasOlder && (
        <div className="thread-view__older">
          <button type="button" className="thread-view__older-btn" disabled={loadingOlder} onClick={onLoadOlder}>
            {loadingOlder ? ru.chat.loadingHistory : ru.chat.loadEarlier}
          </button>
        </div>
      )}
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} approvalBusy={approvalBusy} onApprove={onApprove} onReject={onReject} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
