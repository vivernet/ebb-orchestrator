import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '@ebb-orchestrator/contracts';
import {
  ApiError,
  createConversation,
  getMessages,
  listConversations,
  planApprove,
  planReject,
  sendChatMessage,
  type SendChatMessageInput,
} from '../../api/client.js';
import { onConversationEvent, type ConversationEventPayload } from '../../api/events.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { ru } from '../../i18n/ru.js';
import Composer, { type ComposerSubmitInput } from './Composer.js';
import ThreadView from './ThreadView.js';
import './chat.css';

/** Тип фабрики подписки на события беседы (для инъекции в тестах). */
export type ConversationEventSubscription = (conversationId: string, handler: (data: ConversationEventPayload) => void) => () => void;

interface ChatPanelProps {
  /** Проект, для которого открывается беседа; null — чат недоступен. */
  projectId: string | null;
  /** Фабрика SSE-подписки; по умолчанию — общий клиент событий. */
  subscribe?: ConversationEventSubscription;
}

function messageError(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Панель чата координатора для Dashboard: грузит беседы проекта, историю
 * сообщений с cursor-пагинацией и подписывается на SSE-события беседы.
 */
export default function ChatPanel({ projectId, subscribe }: ChatPanelProps) {
  const [step, setStep] = useState<'loading' | 'unavailable' | 'empty' | 'ready'>('loading');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prevCursor, setPrevCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);

  useEffect(() => {
    setError(null);
    setConversationId(null);
    setMessages([]);
    setPrevCursor(null);
    if (!projectId) {
      setStep('unavailable');
      setInitialLoading(false);
      return;
    }
    let cancelled = false;
    setStep('loading');
    listConversations(projectId)
      .then((list) => {
        if (cancelled) return;
        if (list.length === 0) {
          setStep('empty');
        } else {
          setConversationId(list[0]!.id);
          setStep('ready');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(messageError(err));
        setStep('ready');
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    setInitialLoading(true);
    setError(null);
    getMessages(conversationId)
      .then((page) => {
        if (cancelled) return;
        setMessages(page.items);
        setPrevCursor(page.prevCursor);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(messageError(err));
      })
      .finally(() => {
        if (!cancelled) setInitialLoading(false);
      });
    return () => { cancelled = true; };
  }, [conversationId]);

  const refreshLatest = useCallback(() => {
    if (!conversationId) return Promise.resolve();
    return getMessages(conversationId)
      .then((page) => {
        setMessages((previous) => mergeMessages(previous, page.items));
        setPrevCursor(page.prevCursor);
      })
      .catch((err: unknown) => {
        setError(messageError(err));
      });
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    const doSubscribe = subscribe ?? onConversationEvent;
    return doSubscribe(conversationId, () => { void refreshLatest(); });
  }, [conversationId, subscribe, refreshLatest]);

  const loadOlder = useCallback(() => {
    if (!conversationId || !prevCursor || loadingOlder) return;
    setLoadingOlder(true);
    getMessages(conversationId, { cursor: prevCursor, direction: 'older' })
      .then((page) => {
        setMessages((previous) => mergeMessages(previous, page.items));
        setPrevCursor(page.prevCursor);
      })
      .catch((err: unknown) => {
        setError(messageError(err));
      })
      .finally(() => {
        setLoadingOlder(false);
      });
  }, [conversationId, prevCursor, loadingOlder]);

  const handleSend = useCallback(async (input: ComposerSubmitInput) => {
    if (!conversationId) return;
    setSending(true);
    try {
      const request: SendChatMessageInput = { content: input.content, asPlanningRequest: input.asPlanningRequest };
      if (input.requestId !== undefined) request.requestId = input.requestId;
      await sendChatMessage(conversationId, request);
      await refreshLatest();
    } catch (err) {
      const message = messageError(err);
      setError(message);
      throw new Error(message, { cause: err });
    } finally {
      setSending(false);
    }
  }, [conversationId, refreshLatest]);

  const handleApprove = useCallback((message: ChatMessage) => {
    if (!conversationId || !message.planId) return;
    setApprovalBusy(true);
    planApprove(conversationId, message.planId, message.requestId ?? undefined)
      .then(() => refreshLatest())
      .catch((err: unknown) => setError(messageError(err)))
      .finally(() => setApprovalBusy(false));
  }, [conversationId, refreshLatest]);

  const handleReject = useCallback((message: ChatMessage) => {
    if (!conversationId || !message.planId) return;
    setApprovalBusy(true);
    planReject(conversationId, message.planId)
      .then(() => refreshLatest())
      .catch((err: unknown) => setError(messageError(err)))
      .finally(() => setApprovalBusy(false));
  }, [conversationId, refreshLatest]);

  const continuationRequestId = useMemo(() => {
    let found: string | null = null;
    for (const message of messages) {
      if (message.kind === 'need_input' && message.status === 'NEEDS_INPUT' && message.requestId !== null) {
        found = message.requestId;
      }
    }
    return found;
  }, [messages]);

  const handleCreateConversation = useCallback(() => {
    if (!projectId) return;
    createConversation(projectId)
      .then((conversation) => {
        setConversationId(conversation.id);
        setStep('ready');
      })
      .catch((err: unknown) => setError(messageError(err)));
  }, [projectId]);

  return (
    <section className="chat-panel" aria-label={ru.chat.title}>
      <div className="chat-panel__head">
        <h3>{ru.chat.title}</h3>
        <span className="chat-online"><span className="chat-pulse" />{ru.chat.online}</span>
      </div>
      {step === 'loading' && <PageState status="loading" message={ru.chat.loadingConversations} />}
      {step === 'unavailable' && <EmptyState message={ru.chat.unavailable} />}
      {step === 'empty' && (
        <div className="chat-panel__empty">
          <EmptyState message={ru.chat.noConversations} />
          <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 18 }}>
            <button type="button" onClick={handleCreateConversation}>{ru.chat.createConversation}</button>
          </div>
        </div>
      )}
      {step === 'ready' && (
        <>
          <ThreadView
            messages={messages}
            loading={initialLoading}
            loadingOlder={loadingOlder}
            hasOlder={prevCursor !== null}
            error={error}
            onLoadOlder={() => { loadOlder(); }}
            onRetry={() => { void refreshLatest(); }}
            onApprove={handleApprove}
            onReject={handleReject}
            approvalBusy={approvalBusy}
          />
          <Composer disabled={sending || initialLoading} continuationRequestId={continuationRequestId} onSend={handleSend} />
        </>
      )}
    </section>
  );
}
