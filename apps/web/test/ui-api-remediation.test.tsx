import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ApprovalInboxPage, { mapApprovalRow } from '../src/features/approvals/ApprovalInboxPage.js';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import * as dashboardApi from '../src/features/dashboard/api.js';
import { ApiError, apiClient } from '../src/api/client.js';

const inboxItem = {
  id: 'approval-1', category: 'PLAN_CHANGE', status: 'PENDING', priority: 'HIGH',
  projectId: 'project-1', title: 'EPIC-42 · Изменение плана',
  createdAt: '2026-10-24T05:42:00.000Z', resolvedAt: null,
};

const inboxProjection = {
  filter: 'pending',
  summary: { totalPending: 1, totalResolved: 0, oldestPendingCreatedAt: '2026-10-24T05:42:00.000Z' },
  items: [inboxItem],
};

const approvalDetail = {
  id: 'approval-1', category: 'PLAN_CHANGE', status: 'PENDING', priority: 'HIGH',
  project: { id: 'project-1', displayName: 'Project One' },
  proposal: { title: 'Изменение плана: добавить TASK-430', summary: 'Добавить новую обязательную TASK-430' },
  rationale: 'Требуется расширение скоупа задачи.',
  planDiff: {
    before: { title: 'План до', scope: 'epic-1' },
    after: { title: 'План после', scope: 'epic-1' },
  },
  impacts: { scope: 'epic-1', role: 'Senior Developer', architecture: 'Monolith', delayDays: 2, budgetCost: 12.5 },
  evidence: [
    { id: 'ev-1', kind: 'Дифф плана', capturedAt: '2026-10-24T05:41:00.000Z', description: 'TASK-430 добавлена в план', source: 'plan-diff' },
  ],
  decision: null,
};

function mockApprovalApis({ failList = false }: { failList?: boolean } = {}) {
  return vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
    if (path.startsWith('/approvals?status=')) {
      if (failList) throw new Error('network down');
      return inboxProjection;
    }
    if (path.startsWith('/approvals/')) return approvalDetail;
    throw new Error(`unexpected path: ${path}`);
  });
}

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

  test('loads the inbox through the canonical query path with AbortSignal', async () => {
    const get = mockApprovalApis();
    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Центр согласований' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/approvals?status=pending', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(get).toHaveBeenCalledWith('/approvals/approval-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByRole('region', { name: 'Очередь согласований' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Детали согласования' })).toBeInTheDocument();
    expect(screen.getByText('EPIC-42 · Изменение плана')).toBeInTheDocument();
  });

  test('renders the reference decision queue and detail evidence without raw codes', async () => {
    mockApprovalApis();
    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: 'Согласовать' })).toBeInTheDocument();
    const details = screen.getByRole('complementary', { name: 'Детали согласования' });
    expect(within(details).getByText('Добавить новую обязательную TASK-430')).toBeInTheDocument();
    expect(within(details).getByText('Изменение плана')).toBeInTheDocument();
    expect(within(details).getByText('Подтверждения')).toBeInTheDocument();
    expect(within(details).getByText('Дифф плана')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET_APPROVAL|invalid raw/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запросить изменения' })).toBeInTheDocument();
  });

  test('renders approval load failures with a retry affordance', async () => {
    const get = mockApprovalApis({ failList: true });
    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);
    expect(await screen.findByText('Не удалось загрузить согласования: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    // Переключаем mock на успех и повторяем через UI-кнопку.
    get.mockImplementation(async (path: string) => {
      if (path.startsWith('/approvals?status=')) return inboxProjection;
      if (path.startsWith('/approvals/')) return approvalDetail;
      throw new Error(`unexpected path: ${path}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Центр согласований' })).toBeInTheDocument();
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
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findAllByText('Не удалось загрузить проекты: Не удалось выполнить запрос.')).toHaveLength(1);
    expect(screen.getByText('Не удалось загрузить согласования: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.getByText('Не удалось загрузить очередь: Не удалось выполнить запрос.')).toBeInTheDocument();
    const retryButtons = screen.getAllByRole('button', { name: 'Повторить' });
    expect(retryButtons.length).toBeGreaterThanOrEqual(3);
    // Clicking retry buttons should not crash
    for (const button of retryButtons) fireEvent.click(button);
  });

  test('localizes recognized API codes and never renders arbitrary error details', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockRejectedValue(new ApiError('secret: db host=internal', 403, 'AUTH_FORBIDDEN'));
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockRejectedValue(new Error('secret: queue backend detail'));
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(await screen.findAllByText('Не удалось загрузить проекты: Доступ запрещён.')).toHaveLength(1);
    expect(screen.getByText('Не удалось загрузить согласования: Доступ запрещён.')).toBeInTheDocument();
    expect(screen.getByText('Не удалось загрузить очередь: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:|internal|backend detail/)).not.toBeInTheDocument();
  });

  test('does not expose dead dashboard actions', async () => {
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    const pauseAll = await screen.findByRole('button', { name: /Приостановить всё/ });
    expect(pauseAll).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Новый запрос' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pause All|Пауза/ })).not.toBeInTheDocument();
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
