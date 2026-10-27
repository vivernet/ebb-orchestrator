/// <reference types="node" />
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { ApiError, apiClient } from '../src/api/client.js';
import ApprovalInboxPage from '../src/features/approvals/ApprovalInboxPage.js';
import ExecutionPage from '../src/features/execution/ExecutionPage.js';
import SettingsPage from '../src/features/settings/SettingsPage.js';
import UsagePage from '../src/features/usage/UsagePage.js';
import AgentRunPage from '../src/features/runs/AgentRunPage.js';

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
      if (failList) throw new ApiError('secret: approvals db', 503);
      return inboxProjection;
    }
    if (path.startsWith('/approvals/')) return approvalDetail;
    throw new Error(`unexpected path: ${path}`);
  });
}

const settingsProjection = {
  effectiveHierarchy: { global: { schemaVersion: 1, globalMax: 3, projectMax: 1, roleCapacity: null }, project: null, role: null, taskEpic: null },
  securitySettings: { mostRestrictiveWins: true, localModeEnabled: true },
  providerSelection: { defaultModel: 'default', models: [] },
};

describe('Reference approval inbox', () => {
  test('loads the inbox through the canonical query path and renders queue + detail evidence', async () => {
    const get = mockApprovalApis();
    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Центр согласований' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/approvals?status=pending', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(get).toHaveBeenCalledWith('/approvals/approval-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('EPIC-42 · Изменение плана')).toBeInTheDocument();
    const details = screen.getByRole('complementary', { name: 'Детали согласования' });
    expect(within(details).getByText('Добавить новую обязательную TASK-430')).toBeInTheDocument();
    expect(within(details).getByText('Подтверждения')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Согласовать' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeInTheDocument();
  });

  test('renders retryable load failure without exposing backend details', async () => {
    const get = mockApprovalApis({ failList: true });
    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить согласования: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
    get.mockImplementation(async (path: string) => {
      if (path.startsWith('/approvals?status=')) return inboxProjection;
      if (path.startsWith('/approvals/')) return approvalDetail;
      throw new Error(`unexpected path: ${path}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Центр согласований' })).toBeInTheDocument();
  });
});

describe('Reference execution queue', () => {
  const queueProjection = {
    running: [
      { runId: 'run-841', role: 'Senior Developer', taskId: 'task-425', status: 'IN_PROGRESS' },
      { runId: 'run-846', role: 'Developer', taskId: 'task-426', status: 'IN_PROGRESS' },
      { runId: 'run-852', role: 'Developer', taskId: 'task-427', status: 'STARTED' },
    ],
    waiting: [], blocked: [],
    capacity: { configured: 4, used: 3 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null },
  };

  test('renders the reference queue and fetches through /execution with AbortSignal', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(queueProjection);
    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Очередь выполнения' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/execution', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Senior Developer · run-841')).toBeInTheDocument();
    expect(screen.getByText('Очередь ожидания')).toBeInTheDocument();
    expect(screen.getByText('Ёмкость планировщика')).toBeInTheDocument();
  });

  test('pause dispatcher goes through PUT /scheduler/dispatch-state and reflects mutation', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(queueProjection);
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ paused: true, updatedAt: '2026-10-24T10:00:00.000Z' });
    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить new work' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/scheduler/dispatch-state', { paused: true }));
    expect(screen.queryByText(/Не удалось приостановить очередь/)).not.toBeInTheDocument();
  });

  test('cancel-all posts expectedRunIds after confirmation', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(queueProjection);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ results: [] });
    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Остановить всех агентов' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить остановку' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/runs/cancel-all', { expectedRunIds: ['run-841', 'run-846', 'run-852'] }));
  });

  test('pause errors are not swallowed', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(queueProjection);
    vi.spyOn(apiClient, 'put').mockRejectedValue(new ApiError('scheduler unavailable', 503));
    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить new work' }));
    expect(await screen.findByText(/Не удалось приостановить очередь/)).toBeInTheDocument();
  });
});

describe('Reference settings', () => {
  test('renders section navigation and read-only sections', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsProjection);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Настройки проекта · Ebb AI Hub' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Разделы настроек' })).toBeInTheDocument();
    const scheduler = screen.getByRole('region', { name: 'Планировщик' });
    expect(within(scheduler).getByText('Параллельные агенты проекта')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'General' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'General' })).getByText('Модель по умолчанию')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Роли и модели' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Восстановление' })).toBeInTheDocument();
  });

  test('load failure is localized and retryable without exposing backend details', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new ApiError('secret: settings detail', 500)).mockResolvedValueOnce(settingsProjection);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить настройки: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Настройки проекта · Ebb AI Hub' })).toBeInTheDocument();
  });

  test('never renders credential values or secrets', () => {
    const source = readFileSync('src/features/settings/SettingsPage.tsx', 'utf8');
    expect(source).not.toMatch(/type="password"/);
    expect(source).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|sk-[A-Za-z0-9]+/);
  });
});

describe('Reference usage', () => {
  const usageProjection = {
    window: { from: '2026-09-24T00:00:00.000Z', to: '2026-10-24T00:00:00.000Z', granularity: 'day' },
    summary: { inputTokens: 1000, cachedTokens: 200, outputTokens: 300, totalTokens: 1500, cost: 6.42 },
    dailySeries: [], breakdowns: { byRole: [], byReason: [], byModel: [] }, modelComparison: [],
    budgets: { configurations: [], contexts: [], activeReservations: [] },
    efficiency: {
      cacheShare: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
      averageInitialContextTokens: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
      averageOutputTokens: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
      aiRunsPerTask: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
      reworkCyclesPerTask: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
      deterministicCheckCount: { availability: 'unavailable', reason: 'NO_DURABLE_CHECK_EXECUTION_SOURCE' },
      deterministicCheckCost: { availability: 'unavailable', reason: 'NO_DURABLE_CHECK_EXECUTION_SOURCE' },
    },
    anomaly: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
    taskRecoveryShare: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
  };

  test('renders reference metrics, tabs and budget sections', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(usageProjection);
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Использование и бюджет' })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Сводка использования' });
    expect(summary).toHaveTextContent('$6.42');
    expect(summary).toHaveTextContent('1.5k');
    expect(screen.getByText('Бюджеты проектов')).toBeInTheDocument();
    expect(screen.getByText('Расходы по ролям')).toBeInTheDocument();
    expect(screen.getAllByText('недоступно').length).toBeGreaterThan(0);
    expect(screen.getByText('Обзор')).toBeInTheDocument();
  });

  test('links budget policy to settings', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(usageProjection);
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: 'Политики бюджета' })).toHaveAttribute('href', '#/settings');
  });

  test('renders retryable error and refetches', async () => {
    let failUsage = true;
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async () => {
      if (failUsage) throw new Error('usage unavailable');
      return usageProjection;
    });
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить данные об использовании: Не удалось выполнить запрос.')).toBeInTheDocument();
    failUsage = false;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'Использование и бюджет' })).toBeInTheDocument();
    void get;
  });
});

describe('Reference agent run', () => {
  const runProjection = {
    id: 'run-841', role: 'Senior Developer', runtime: 'Hermes', model: 'terra', status: 'IN_PROGRESS',
    taskId: 'task-425', epicId: null, sessionId: 'dev-425', attempt: 2, triggerReason: 'REVIEW_REWORK',
    startedAt: '2026-10-24T05:41:18.000Z', endedAt: null, exitCode: null,
    usage: {
      inputTokens: { availability: 'available', value: 63400 },
      cachedInputTokens: { availability: 'available', value: 42100 },
      outputTokens: { availability: 'available', value: 10800 },
      effectiveCost: { availability: 'available', value: 0.78 },
    },
    control: { state: 'ACTIVE', version: 1, updatedAt: '2026-10-24T05:41:20.000Z', checkpointId: null },
  };

  const eventsProjection = {
    items: [{ id: 'ev-1', type: 'Начат вызов инструмента', createdAt: '2026-10-24T05:41:18.000Z', payload: {} }],
    nextCursor: null,
  };

  const terminalProjection = {
    availability: 'available',
    entries: [{ seq: 0, text: '[tool] factory check', at: '2026-10-24T05:41:19.000Z' }],
  };

  function mockRunApis({ failDetail = false }: { failDetail?: boolean } = {}) {
    return vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
      if (path === '/runs/run-841') {
        if (failDetail) throw new ApiError('secret: run db', 503);
        return runProjection;
      }
      if (path === '/runs/run-841/events') return eventsProjection;
      if (path === '/runs/run-841/terminal') return terminalProjection;
      throw new Error(`unexpected path: ${path}`);
    });
  }

  test('renders run detail columns and events without raw payload leakage', async () => {
    const get = mockRunApis();
    render(<MemoryRouter><AgentRunPage id="run-841" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'run-841 · Senior Developer' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/runs/run-841', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(get).toHaveBeenCalledWith('/runs/run-841/events', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(get).toHaveBeenCalledWith('/runs/run-841/terminal', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Начат вызов инструмента')).toBeInTheDocument();
    expect(screen.getByText('Вывод терминала')).toBeInTheDocument();
    expect(screen.getByText('Цель запуска')).toBeInTheDocument();
    expect(screen.getAllByText('Среда выполнения').length).toBeGreaterThan(0);
    expect(screen.getByText('Решения по разрешениям')).toBeInTheDocument();
    expect(screen.getByText('недоступно (источник решений недоступен в текущей проекции)')).toBeInTheDocument();
    expect(screen.getAllByText('Использование').length).toBeGreaterThan(0);
    expect(screen.getByText('Сигналы восстановления')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать контрольную точку' })).toBeInTheDocument();
    expect(screen.queryByText(/ALLOW|DENY/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private ui prompt|sentinel/)).not.toBeInTheDocument();
  });

  test('renders retryable load failure', async () => {
    const get = mockRunApis({ failDetail: true });
    render(<MemoryRouter><AgentRunPage id="run-841" /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить запуск агента: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
    get.mockImplementation(async (path: string) => {
      if (path === '/runs/run-841') return runProjection;
      if (path === '/runs/run-841/events') return eventsProjection;
      if (path === '/runs/run-841/terminal') return terminalProjection;
      throw new Error(`unexpected path: ${path}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { name: 'run-841 · Senior Developer' })).toBeInTheDocument();
  });
});
