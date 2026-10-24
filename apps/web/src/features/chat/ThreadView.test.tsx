// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@ebb-orchestrator/contracts';
import ThreadView from './ThreadView.js';

afterEach(() => { cleanup(); });

const NOW = '2026-10-24T12:00:00.000Z';

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

const baseProps = {
  messages: [userMsg] as ChatMessage[],
  loading: false,
  loadingOlder: false,
  hasOlder: false,
  error: null as string | null,
  approvalBusy: false,
  onLoadOlder: () => undefined,
  onRetry: () => undefined,
  onApprove: (_message: ChatMessage) => undefined,
  onReject: (_message: ChatMessage) => undefined,
};

describe('ThreadView', () => {
  it('отображает сообщения по ролям и видам со статусным чипом', () => {
    render(<ThreadView {...baseProps} messages={[userMsg, approvalMsg]} />);
    expect(screen.getByText('Спланируй миграцию БД')).toBeInTheDocument();
    expect(screen.getByText('План готов к согласованию.')).toBeInTheDocument();
    expect(screen.getByText('Ожидает согласования')).toBeInTheDocument();
  });

  it('показывает «Загрузить раньше» только при наличии older-cursor', () => {
    const { rerender } = render(<ThreadView {...baseProps} hasOlder={true} />);
    expect(screen.getByRole('button', { name: 'Загрузить раньше' })).toBeInTheDocument();
    rerender(<ThreadView {...baseProps} hasOlder={false} />);
    expect(screen.queryByRole('button', { name: 'Загрузить раньше' })).not.toBeInTheDocument();
  });

  it('кнопка «Загрузить раньше» вызывает onLoadOlder', () => {
    const onLoadOlder = vi.fn();
    render(<ThreadView {...baseProps} hasOlder={true} onLoadOlder={onLoadOlder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить раньше' }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('инлайн-одобрения вызывают onApprove/onReject с сообщением', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ThreadView {...baseProps} messages={[approvalMsg]} onApprove={onApprove} onReject={onReject} />);
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
    expect(onApprove).toHaveBeenCalledWith(approvalMsg);
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
    expect(onReject).toHaveBeenCalledWith(approvalMsg);
  });
});
