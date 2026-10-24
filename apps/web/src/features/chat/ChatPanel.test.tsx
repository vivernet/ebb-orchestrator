// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, MessagesPage } from '@ebb-orchestrator/contracts';
import { apiClient } from '../../api/client.js';
import ChatPanel, { type ConversationEventSubscription } from './ChatPanel.js';

afterEach(() => { cleanup(); });

const NOW = '2026-10-24T12:00:00.000Z';

const conversation = {
  id: 'conv_1',
  projectId: 'project_1',
  title: null,
  status: 'ACTIVE' as const,
  createdAt: NOW,
  updatedAt: NOW,
};

const userMsg: ChatMessage = {
  id: 'msg_1',
  conversationId: 'conv_1',
  role: 'user',
  kind: 'text',
  content: 'Спланируй миграцию БД',
  requestId: null,
  planId: null,
  status: null,
  createdAt: NOW,
};

const coordMsg: ChatMessage = {
  id: 'msg_2',
  conversationId: 'conv_1',
  role: 'coordinator',
  kind: 'status_update',
  content: 'Планирование запущено',
  requestId: 'request_1',
  planId: null,
  status: 'PLANNING',
  createdAt: NOW,
};

const approvalMsg: ChatMessage = {
  id: 'msg_3',
  conversationId: 'conv_1',
  role: 'system',
  kind: 'approval_request',
  content: 'План готов к согласованию.',
  requestId: 'request_1',
  planId: 'plan_1',
  status: 'PLAN_PENDING_APPROVAL',
  createdAt: NOW,
};

const needInputMsg: ChatMessage = {
  id: 'msg_4',
  conversationId: 'conv_1',
  role: 'system',
  kind: 'need_input',
  content: 'Недостаточно данных для планирования.',
  requestId: 'request_1',
  planId: null,
  status: 'NEEDS_INPUT',
  createdAt: NOW,
};

const extraMsg: ChatMessage = {
  id: 'msg_5',
  conversationId: 'conv_1',
  role: 'coordinator',
  kind: 'text',
  content: 'Новое сообщение после события',
  requestId: null,
  planId: null,
  status: null,
  createdAt: NOW,
};

const olderMsg: ChatMessage = {
  id: 'msg_0',
  conversationId: 'conv_1',
  role: 'user',
  kind: 'text',
  content: 'Старое сообщение',
  requestId: null,
  planId: null,
  status: null,
  createdAt: '2026-10-23T10:00:00.000Z',
};

function makeEventSource() {
  const handlers = new Set<(data: { conversationId?: string }) => void>();
  return {
    subscribe: ((
      _conversationId: string,
      handler: (data: { conversationId?: string }) => void,
    ) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }) as ConversationEventSubscription,
    emit(data: { conversationId?: string }) {
      for (const handler of handlers) handler(data);
    },
  };
}

function stubConversationsGet(backend: { messages: ChatMessage[]; prevCursor?: string | null }) {
  return vi.spyOn(apiClient, 'get').mockImplementation(((
    path: string,
  ) => {
    if (path.includes('/messages')) {
      const cursor = new URL(path, 'http://localhost').searchParams.get('cursor');
      const page: MessagesPage = cursor !== null
        ? { items: [olderMsg], prevCursor: null, nextCursor: null }
        : { items: backend.messages, prevCursor: backend.prevCursor ?? null, nextCursor: null };
      return Promise.resolve(page);
    }
    return Promise.resolve({ conversations: [conversation] });
  }) as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChatPanel: SSE-подписка и история', () => {
  it('без SSE-подписки новые сообщения не появляются в ThreadView', async () => {
    const backend = { messages: [userMsg, coordMsg] };
    stubConversationsGet(backend);
    render(<ChatPanel projectId="project_1" subscribe={() => () => undefined} />);
    expect(await screen.findByText('Спланируй миграцию БД')).toBeInTheDocument();
    backend.messages = [userMsg, coordMsg, extraMsg];
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByText('Новое сообщение после события')).not.toBeInTheDocument();
  });

  it('SSE-событие беседы доставляет новое сообщение в ThreadView', async () => {
    const source = makeEventSource();
    const backend = { messages: [userMsg, coordMsg] };
    stubConversationsGet(backend);
    render(<ChatPanel projectId="project_1" subscribe={source.subscribe} />);
    expect(await screen.findByText('Спланируй миграцию БД')).toBeInTheDocument();
    backend.messages = [userMsg, coordMsg, extraMsg];
    act(() => source.emit({ conversationId: 'conv_1' }));
    expect(await screen.findByText('Новое сообщение после события')).toBeInTheDocument();
  });

  it('SSE-событие после смены статуса обновляет чип существующего сообщения', async () => {
    const source = makeEventSource();
    const backend = { messages: [userMsg, coordMsg] };
    stubConversationsGet(backend);
    render(<ChatPanel projectId="project_1" subscribe={source.subscribe} />);
    expect(await screen.findByText('Планирование')).toBeInTheDocument();
    backend.messages = [{ ...coordMsg, status: 'MATERIALIZED' }];
    act(() => source.emit({ conversationId: 'conv_1' }));
    expect(await screen.findByText('Материализовано')).toBeInTheDocument();
    expect(screen.queryByText('Планирование')).not.toBeInTheDocument();
  });

  it('«загрузить раньше» подгружает старшие сообщения по cursor', async () => {
    const get = stubConversationsGet({ messages: [userMsg, coordMsg], prevCursor: 'older_cursor' });
    render(<ChatPanel projectId="project_1" subscribe={() => () => undefined} />);
    expect(await screen.findByText('Спланируй миграцию БД')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить раньше' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/conversations/conv_1/messages?cursor=older_cursor&direction=older'));
    expect(await screen.findByText('Старое сообщение')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Загрузить раньше' })).not.toBeInTheDocument());
  });
});

describe('ChatPanel: взаимодействие с API', () => {
  it('продолжение NEEDS_INPUT отправляет сообщение с requestId', async () => {
    stubConversationsGet({ messages: [userMsg, coordMsg, needInputMsg] });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
      message: { ...userMsg, id: 'msg_6', content: 'Дополню запрос' },
      planning: { requestId: 'request_1', status: 'RECEIVED' },
    });
    render(<ChatPanel projectId="project_1" subscribe={() => () => undefined} />);
    expect(await screen.findByText('Недостаточно данных для планирования.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Сообщение координатору…' }), { target: { value: 'Дополню запрос' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/conv_1/messages', {
      content: 'Дополню запрос',
      asPlanningRequest: true,
      requestId: 'request_1',
    }));
  });

  it('кнопка одобрения вызывает planApprove c requestId плана', async () => {
    stubConversationsGet({ messages: [userMsg, coordMsg, approvalMsg] });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ result: {} });
    render(<ChatPanel projectId="project_1" subscribe={() => () => undefined} />);
    expect(await screen.findByText('План готов к согласованию.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/conv_1/plans/plan_1/approve', { requestId: 'request_1' }));
  });

  it('кнопка отклонения вызывает planReject с conversationId/planId', async () => {
    stubConversationsGet({ messages: [userMsg, coordMsg, approvalMsg] });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ result: {} });
    render(<ChatPanel projectId="project_1" subscribe={() => () => undefined} />);
    expect(await screen.findByText('План готов к согласованию.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/conversations/conv_1/plans/plan_1/reject', {}));
  });
});
