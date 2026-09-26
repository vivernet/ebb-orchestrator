import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApprovalInboxPage, { mapApprovalRow } from '../src/features/approvals/ApprovalInboxPage.js';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import * as dashboardApi from '../src/features/dashboard/api.js';
import { ApiError, apiClient } from '../src/api/client.js';

describe('approval UI/API remediation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('maps the server envelope fields and uppercase values to the UI model', () => {
    expect(mapApprovalRow({
      id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'epic-1', subject_type: 'EPIC',
      status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
      resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
    })).toEqual({
      id: 'approval-1', scope: 'epic', action: 'FINAL_MERGE', description: 'EPIC epic-1',
      requestedBy: 'orchestrator', context: '', status: 'pending', createdAt: '2026-09-17T00:00:00Z',
    });
  });

  test('only exposes the server-approved approve mutation', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [{
      id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'task-1', subject_type: 'TASK',
      status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
      resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
    }] });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});
    render(<ApprovalInboxPage />);
    expect(await screen.findByRole('button', { name: 'Согласовать' })).toBeInTheDocument();
    expect(screen.getByText('Задача')).toHaveAttribute('data-status', 'task');
    expect(screen.getByText('Финальное слияние')).toBeInTheDocument();
    expect(screen.getByText('Задача task-1')).toBeInTheDocument();
    expect(screen.queryByText(/FINAL_MERGE|TASK task-1/)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Отклонить' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Запросить изменения' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Согласовать' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/approvals/approval-1/approve', {}));
  });

  test('uses safe fallback labels for unknown approval codes while preserving the DTO', async () => {
    const row = { id: 'approval-unknown', type: 'SECRET_APPROVAL_123', subject_id: 'task-1', subject_type: 'SECRET_SCOPE_123', status: 'PENDING', requested_by: 'orchestrator', resolved_by: null, resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null };
    vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [row] });
    render(<ApprovalInboxPage />);
    expect(await screen.findByText('Неизвестный тип согласования')).toBeInTheDocument();
    expect(screen.getByText('Объект task-1')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET_APPROVAL_123|SECRET_SCOPE_123/)).not.toBeInTheDocument();
    expect(mapApprovalRow(row)).toMatchObject({ action: row.type, description: `${row.subject_type} ${row.subject_id}` });
  });

  test('loads the inbox through the canonical query path with AbortSignal', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [] });
    render(<ApprovalInboxPage />);

    expect(await screen.findByText('Нет согласований, ожидающих решения.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/approvals', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  test('refetches the inbox after SSE reconnect and keeps the empty state explicit', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [] });
    render(<ApprovalInboxPage />);

    await screen.findByText('Нет согласований, ожидающих решения.');
    window.dispatchEvent(new CustomEvent('sse-reconnect'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Нет согласований, ожидающих решения.')).toBeInTheDocument();
  });

  test('deduplicates pending approve and refetches the authoritative approvals list', async () => {
    let resolveApprove!: (value: unknown) => void;
    const approve = new Promise((resolve) => { resolveApprove = resolve; });
    const get = vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ approvals: [{
        id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'task-1', subject_type: 'TASK',
        status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
        resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
      }] })
      .mockResolvedValueOnce({ approvals: [] });
    const post = vi.spyOn(apiClient, 'post').mockReturnValue(approve);
    render(<ApprovalInboxPage />);

    const button = await screen.findByRole('button', { name: 'Согласовать' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    resolveApprove({});
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('Нет согласований, ожидающих решения.')).toBeInTheDocument());
  });

  test('renders approval load failures with a retry affordance', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ approvals: [] });
    render(<ApprovalInboxPage />);
    expect(await screen.findByText('Не удалось загрузить согласования: Не удалось выполнить запрос.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Нет согласований, ожидающих решения.')).toBeInTheDocument();
  });

  test('renders approval mutation failures with a reload affordance', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [{
      id: 'approval-1', type: 'FINAL_MERGE', subject_id: 'task-1', subject_type: 'TASK',
      status: 'PENDING', requested_by: 'orchestrator', resolved_by: null,
      resolution_note: null, created_at: '2026-09-17T00:00:00Z', resolved_at: null,
    }] });
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('approval unavailable'));
    render(<ApprovalInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Согласовать' }));
    expect(await screen.findByText('Не удалось обновить согласование: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Согласовать' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

describe('dashboard failure states', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders explicit projection and queue errors with retry affordances', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockRejectedValue(new Error('server unavailable'));
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockRejectedValue(new Error('server unavailable'));
    render(<DashboardPage />);
    expect(await screen.findByText('Не удалось загрузить обзор: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.getByText('Не удалось загрузить очередь: Не удалось выполнить запрос.')).toBeInTheDocument();
    const retryButtons = screen.getAllByRole('button', { name: 'Повторить' });
    expect(retryButtons).toHaveLength(2);
    // Clicking retry buttons should not crash
    fireEvent.click(retryButtons.at(0)!);
    fireEvent.click(retryButtons.at(1)!);
  });

  test('localizes recognized API codes and never renders arbitrary error details', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockRejectedValue(new ApiError('secret: db host=internal', 403, 'AUTH_FORBIDDEN'));
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockRejectedValue(new Error('secret: queue backend detail'));
    render(<DashboardPage />);

    expect(await screen.findByText('Не удалось загрузить обзор: Доступ запрещён.')).toBeInTheDocument();
    expect(screen.getByText('Не удалось загрузить очередь: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:|internal|backend detail/)).not.toBeInTheDocument();
  });

  test('does not expose dead dashboard actions', () => {
    render(<DashboardPage />);
    expect(screen.queryByRole('button', { name: /Приостановить|Пауза/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Новый запрос|Создать запрос/ })).not.toBeInTheDocument();
  });
});

describe('API error parsing', () => {
  afterEach(() => vi.restoreAllMocks());

  test('preserves a structured server error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'approval denied' }), {
      status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/json' },
    }));
    await expect(apiClient.get('/approvals')).rejects.toThrow('approval denied');
  });

  test('falls back safely for non-JSON error responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }));
    await expect(apiClient.get('/approvals')).rejects.toThrow('API error: 502 Bad Gateway');
  });
});
