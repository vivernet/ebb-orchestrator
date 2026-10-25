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

const HASH = 'a'.repeat(64);

const approvalInboxPending = {
  filter: 'pending',
  summary: { totalPending: 2, totalResolved: 0, oldestPendingCreatedAt: '2026-10-24T00:00:00.000Z' },
  items: [
    {
      id: 'approval-1', category: 'PLAN_CHANGE', status: 'PENDING', priority: 'HIGH', projectId: 'project-1',
      title: 'Изменение плана эпика', createdAt: '2026-10-24T00:00:00.000Z', resolvedAt: null,
    },
    {
      id: 'approval-2', category: 'PERMISSION', status: 'PENDING', priority: 'MEDIUM', projectId: null,
      title: 'Запрос разрешения DevOps', createdAt: '2026-10-24T01:00:00.000Z', resolvedAt: null,
    },
  ],
};

const approvalDetailFixture = {
  id: 'approval-1', category: 'PLAN_CHANGE', status: 'PENDING', priority: 'HIGH',
  project: { id: 'project-1', displayName: 'Ebb AI Hub' },
  proposal: { title: 'Изменение плана эпика', summary: 'Добавить обязательную TASK-430' },
  rationale: 'QA обнаружили, что текущие integration fixtures дублируют provider-specific события.',
  planDiff: {
    before: { title: 'TASK-425..428', scope: 'streaming' },
    after: { title: 'TASK-430 → TASK-428', scope: 'streaming + tool calling' },
  },
  impacts: { scope: '+1 обязательная задача', role: 'Middle Developer', architecture: 'Публичный API не изменяется', delayDays: 2, budgetCost: 0.5 },
  evidence: [
    { id: 'ev-1', kind: 'DEVELOPER_PROPOSAL', capturedAt: '2026-10-23T00:00:00.000Z', description: 'Предложение разработчика', source: 'TASK-428' },
  ],
  decision: null,
};

const resolvedApprovalDetail = {
  ...approvalDetailFixture,
  id: 'approval-3', status: 'RESOLVED',
  decision: { actor: 'local-user', outcome: 'APPROVED', at: '2026-10-24T02:00:00.000Z', note: 'Принято' },
};

const executionFull = {
  running: [
    { runId: 'run-1', role: 'Senior Developer', taskId: 'task-425', status: 'IN_PROGRESS' },
    { runId: 'run-2', role: 'QA', taskId: 'task-116', status: 'STARTED' },
  ],
  waiting: [{ taskId: 'task-424', reason: { code: 'WAITING_FOR_ROLE_CAPACITY', message: '' } }],
  blocked: [{ taskId: 'task-508', reason: { code: 'BLOCKED_BY_WORKFLOW', message: '' } }],
  capacity: { configured: 4, used: 2 },
  locks: [{ id: 'lock-1', resource: 'local_docker_environment', runId: 'run-2', kind: 'EXCLUSIVE', heldAt: '2026-10-24T00:00:00.000Z' }],
  recentEvents: [{ id: 'sched-ev-1', type: 'RUN_STARTED', createdAt: '2026-10-24T00:00:00.000Z' }],
  dispatchState: { paused: false, updatedAt: null },
};

const activeRunDetail = {
  id: 'run-1', role: 'Senior Developer', runtime: 'hermes', model: 'gpt-5.6-terra', status: 'IN_PROGRESS',
  taskId: 'task-425', epicId: null, sessionId: 'dev-425', attempt: 2, triggerReason: 'DEVELOPMENT',
  startedAt: '2026-10-24T00:00:00.000Z', endedAt: null, exitCode: null,
  usage: {
    inputTokens: { availability: 'available', value: 100 },
    cachedInputTokens: { availability: 'unavailable', reason: 'NOT_RECORDED' },
    outputTokens: { availability: 'available', value: 25 },
    effectiveCost: { availability: 'unavailable', reason: 'NOT_RECORDED' },
  },
  control: { state: 'ACTIVE', version: 1, updatedAt: '2026-10-24T00:00:00.000Z', checkpointId: null },
};

const pausedRunDetail = {
  ...activeRunDetail,
  control: { state: 'PAUSED', version: 2, updatedAt: '2026-10-24T01:00:00.000Z', checkpointId: 'cp-1' },
};

const usageWindowFixture = {
  window: { from: '2026-09-24T00:00:00.000Z', to: '2026-10-24T00:00:00.000Z', granularity: 'day' },
  summary: { inputTokens: 1000, cachedTokens: 200, outputTokens: 300, totalTokens: 1500, cost: 6.42 },
  dailySeries: [
    { date: '2026-10-23', usage: { inputTokens: 100, cachedTokens: 20, outputTokens: 30, totalTokens: 150, cost: 0.64 } },
  ],
  breakdowns: {
    byRole: [{ key: 'Senior Developer', spend: 4.1, tokens: 900, share: 0.64, runCount: 5 }],
    byReason: [{ key: 'DEVELOPMENT', spend: 2.5, tokens: 500, share: 0.4, runCount: 3 }],
    byModel: [{ key: 'gpt-5.6-terra', spend: 3.0, tokens: 600, share: 0.47, runCount: 4 }],
  },
  modelComparison: [{ role: 'Senior Developer', model: 'gpt-5.6-terra', averageCostPerRun: 0.82, runs: 5 }],
  budgets: { configurations: [], contexts: [], activeReservations: [] },
  efficiency: {
    cacheShare: { availability: 'available', value: 0.64 },
    averageInitialContextTokens: { availability: 'available', value: 28400 },
    averageOutputTokens: { availability: 'available', value: 6200 },
    aiRunsPerTask: { availability: 'available', value: 3.7 },
    reworkCyclesPerTask: { availability: 'available', value: 0.8 },
    deterministicCheckCount: { availability: 'unavailable', reason: 'NO_DURABLE_CHECK_EXECUTION_SOURCE' },
    deterministicCheckCost: { availability: 'unavailable', reason: 'NO_DURABLE_CHECK_EXECUTION_SOURCE' },
  },
  anomaly: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
  taskRecoveryShare: { availability: 'unavailable', reason: 'NO_APPROVED_POLICY' },
};

describe('Task 8 — Approval Inbox: typed decision routes, detail и counters', () => {
  test('approve/reject/request-changes вызывают typed маршруты и refetch-ят список', async () => {
    let getCalls = 0;
    vi.spyOn(apiClient, 'get').mockImplementation(async () => {
      getCalls += 1;
      return approvalInboxPending;
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/approvals/approval-1/approve' || path === '/approvals/approval-1/reject' || path === '/approvals/approval-1/request-changes') return {};
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    const approve = await screen.findByRole('button', { name: 'Согласовать' });
    fireEvent.click(approve);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/approvals/approval-1/approve', {}));
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(2));

    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/approvals/approval-1/reject', {}));

    fireEvent.click(screen.getByRole('button', { name: 'Запросить изменения' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/approvals/approval-1/request-changes', {}));
  });

  test('детальная проекция показывает rationale, plan-diff, impact, evidence и решение', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/approvals/approval-1') return approvalDetailFixture;
      return approvalInboxPending;
    });

    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    await screen.findByRole('region', { name: 'Детали согласования' });
    fireEvent.click(screen.getByRole('button', { name: /Изменение плана эпика/ }));

    const details = await screen.findByRole('region', { name: 'Детали согласования' });
    expect(details).toHaveTextContent('QA обнаружили, что текущие integration fixtures дублируют provider-specific события.');
    expect(details).toHaveTextContent('TASK-430 → TASK-428');
    expect(details).toHaveTextContent('+1 обязательная задача');
    expect(details).toHaveTextContent('Предложение разработчика');
    expect(details).toHaveTextContent('Решение ещё не принято');
    expect(details).not.toHaveTextContent('event-id-raw');
  });

  test('решённое согласование показывает actor и outcome вместо кнопок решения', async () => {
    const resolvedBox = {
      filter: 'resolved',
      summary: { totalPending: 0, totalResolved: 1, oldestPendingCreatedAt: null },
      items: [
        {
          id: 'approval-3', category: 'PLAN_CHANGE', status: 'RESOLVED', priority: 'HIGH', projectId: 'project-1',
          title: 'Изменение плана эпика', createdAt: '2026-10-24T00:00:00.000Z', resolvedAt: '2026-10-24T02:00:00.000Z',
        },
      ],
    };
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/approvals/approval-3') return resolvedApprovalDetail;
      return resolvedBox;
    });

    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Решённые' }));

    fireEvent.click(await screen.findByRole('button', { name: /Изменение плана эпика/ }));
    const details = await screen.findByRole('region', { name: 'Детали согласования' });
    expect(details).toHaveTextContent('local-user');
    expect(details).toHaveTextContent('Согласовано');
    expect(screen.queryByRole('button', { name: 'Согласовать' })).not.toBeInTheDocument();
  });

  test('решённый фильтр отбрасывает статус-несоответствия и не показывает кнопки решений', async () => {
    const mixedBox = {
      filter: 'resolved',
      summary: { totalPending: 1, totalResolved: 1, oldestPendingCreatedAt: null },
      items: [
        {
          id: 'approval-pending', category: 'PLAN_CHANGE', status: 'PENDING', priority: 'HIGH', projectId: null,
          title: 'Скрытый pending', createdAt: '2026-10-24T00:00:00.000Z', resolvedAt: null,
        },
        {
          id: 'approval-3', category: 'PLAN_CHANGE', status: 'RESOLVED', priority: 'HIGH', projectId: 'project-1',
          title: 'Изменение плана эпика', createdAt: '2026-10-24T00:00:00.000Z', resolvedAt: '2026-10-24T02:00:00.000Z',
        },
      ],
    };
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/approvals/approval-3') return resolvedApprovalDetail;
      return mixedBox;
    });

    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Решённые' }));

    expect(await screen.findByRole('button', { name: /Изменение плана эпика/ })).toBeInTheDocument();
    expect(screen.queryByText('Скрытый pending')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Изменение плана эпика/ }));
    await screen.findByRole('region', { name: 'Детали согласования' });
    expect(screen.queryByRole('button', { name: 'Согласовать' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отклонить' })).not.toBeInTheDocument();
  });

  test('optimistic current-state check блокирует решение по подтверждённо решённой записи', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/approvals/approval-1') {
        return { ...approvalDetailFixture, status: 'RESOLVED', decision: resolvedApprovalDetail.decision };
      }
      return approvalInboxPending;
    });
    const post = vi.spyOn(apiClient, 'post');

    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Изменение плана эпика/ }));
    await screen.findByRole('region', { name: 'Детали согласования' });

    fireEvent.click(screen.getByRole('button', { name: 'Согласовать' }));
    expect(await screen.findByText(/Это согласование уже решено/)).toBeInTheDocument();
    await waitFor(() => expect(post).not.toHaveBeenCalled());
  });

  test('summary счётчики и самый давний запрос рендерятся из проекции', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(approvalInboxPending);

    render(<MemoryRouter><ApprovalInboxPage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Входящие согласования' });
    const metrics = screen.getByRole('region', { name: 'Сводка согласований' });
    expect(within(metrics).getByText('2', { exact: true })).toBeInTheDocument();
    expect(metrics).toHaveTextContent(/2026/);
  });
});

describe('Task 8 — Execution Queue: dispatch pause, cancel-all и выбранный запуск', () => {
  test('глобальная пауза диспетчеризации идёт через PUT /scheduler/dispatch-state и refetch', async () => {
    let paused = false;
    let getCalls = 0;
    vi.spyOn(apiClient, 'get').mockImplementation(async () => {
      getCalls += 1;
      return { ...executionFull, dispatchState: { paused, updatedAt: null } };
    });
    const put = vi.spyOn(apiClient, 'put').mockImplementation(async (path) => {
      if (path === '/scheduler/dispatch-state') {
        paused = true;
        return { paused: true, updatedAt: '2026-10-24T10:00:00.000Z' };
      }
      throw new Error(`Unexpected PUT ${path}`);
    });

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить новую работу' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/scheduler/dispatch-state', { paused: true }));
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(2));
    await screen.findByRole('button', { name: 'Возобновить новую работу' });
  });

  test('cancel-all отправляет expectedRunIds и показывает itemized частичные исходы', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(executionFull);
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/runs/cancel-all') {
        return { results: [
          { runId: 'run-1', outcome: 'CANCELLED' },
          { runId: 'run-2', outcome: 'FAILED' },
        ] };
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Остановить всех агентов' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить остановку' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/runs/cancel-all', { expectedRunIds: ['run-1', 'run-2'] }));
    const outcomes = await screen.findByRole('region', { name: 'Результаты остановки' });
    await waitFor(() => expect(outcomes).toHaveTextContent('run-1'));
    expect(outcomes).toHaveTextContent('run-2');
    expect(outcomes).toHaveTextContent('Ошибка');
    expect(outcomes).toHaveTextContent('Отменено');
  });

  test('выбранный запуск вызывает run lifecycle маршруты pause/resume/cancel', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-1') return activeRunDetail;
      return executionFull;
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/runs/run-1/pause') return { command: 'PAUSE', status: 'REQUESTED', control: { state: 'PAUSE_REQUESTED', version: 2, updatedAt: '2026-10-24T01:00:00.000Z', checkpointId: null }, failureCode: null };
      if (path === '/runs/run-1/cancel') return {};
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Управление run-1' }));
    await screen.findByRole('button', { name: 'Приостановить запуск' });

    fireEvent.click(screen.getByRole('button', { name: 'Приостановить запуск' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/runs/run-1/pause'));
    expect(get).toHaveBeenCalledWith('/runs/run-1');
  });

  test('частичные ошибки не скрываются: пауза и cancel-all показывают ошибку', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(executionFull);
    vi.spyOn(apiClient, 'put').mockRejectedValue(new ApiError('scheduler unavailable', 503));
    vi.spyOn(apiClient, 'post').mockRejectedValue(new ApiError('cancel-all partially failed', 500));

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить новую работу' }));
    expect(await screen.findByText(/Не удалось приостановить очередь/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Остановить всех агентов' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить остановку' }));
    expect(await screen.findByText(/Не удалось остановить агентов/)).toBeInTheDocument();
  });

  test('пауза выбранного запуска показывает ошибку без silent swallowing', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-1') return activeRunDetail;
      return executionFull;
    });
    vi.spyOn(apiClient, 'post').mockRejectedValue(new ApiError('control plane down', 503));

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Управление run-1' }));
    await screen.findByRole('button', { name: 'Приостановить запуск' });
    fireEvent.click(screen.getByRole('button', { name: 'Приостановить запуск' }));

    expect(await screen.findByText(/Не удалось приостановить запуск/)).toBeInTheDocument();
  });
});

describe('Task 8 — Settings: candidate редактор через typed маршрут', () => {
  const configResponse = {
    current: null,
    active: {
      revisionId: 'rev-1', candidateId: 'cand-0', projectId: 'project-1', schemaVersion: 2,
      normalizedConfig: {
        projectDisplayName: 'Ebb AI Hub', defaultBranch: 'develop',
        roles: [{ role: 'coordinator', provider: null, model: null }],
        scheduler: { concurrency: 3, enablePriorityAging: true, criticalPathBoost: true },
        recovery: { resumeSessions: true, maxAttempts: 2, recoveryCycleMinutes: 30, abortOnNoProgressDays: 2 },
        github: { syncEnabled: true, issueLinking: true, pullRequestSync: false },
        budgets: [],
      },
      manifestHash: HASH, revisionHash: 'b'.repeat(64), manifest: [], files: {},
      createdAt: '2026-10-24T00:00:00.000Z',
    },
    revisions: [], degraded: false, candidateInvalid: false,
  };
  const settingsProjection = {
    effectiveHierarchy: { global: { schemaVersion: 1, globalMax: 4, projectMax: 2, roleCapacity: null }, project: null, role: null, taskEpic: null },
    securitySettings: { mostRestrictiveWins: true, localModeEnabled: true },
    providerSelection: { defaultModel: 'default', models: [] },
  };

  const renderEditor = () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/projects/project-1/config') return configResponse;
      return settingsProjection;
    });
    return render(<MemoryRouter><SettingsPage initialProjectId="project-1" /></MemoryRouter>);
  };

  test('сохранение кандидата идёт через POST editor route с expectedManifestHash и показывает diff', async () => {
    renderEditor();
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
      candidateId: 'cand-1', projectId: 'project-1', manifestHash: 'c'.repeat(64),
      expectedManifestHash: HASH,
      diff: { added: ['settings.scheduler.concurrency'], removed: [], modified: ['settings.projectDisplayName'] },
      status: 'PENDING_REVIEW', createdAt: '2026-10-24T03:00:00.000Z',
    });

    await screen.findByRole('heading', { name: 'Конфигурация проекта' });
    const nameInput = screen.getByLabelText('Название проекта');
    fireEvent.change(nameInput, { target: { value: 'Ebb AI Hub' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменения' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/projects/project-1/config/candidates/editor',
      expect.objectContaining({
        expectedManifestHash: HASH,
        settings: expect.objectContaining({ projectDisplayName: 'Ebb AI Hub' }),
      }),
    ));

    expect(await screen.findByText(/PENDING_REVIEW/)).toBeInTheDocument();
    expect(screen.getByText('settings.scheduler.concurrency')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Перейти к согласованию кандидата' })).toHaveAttribute('href', '/approvals');
  });

  test('редактор заблокирован, когда активная ревизия отсутствует или конфигурация повреждена', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/projects/project-1/config') return { current: null, active: null, revisions: [], degraded: true, candidateInvalid: false };
      return settingsProjection;
    });

    render(<MemoryRouter><SettingsPage initialProjectId="project-1" /></MemoryRouter>);

    expect(await screen.findByText(/Конфигурация проекта повреждена/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить изменения' })).not.toBeInTheDocument();
  });

  test('scheduler-конфигурация сохраняется через typed PUT /scheduler/config с валидированным body', async () => {
    renderEditor();
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({
      schemaVersion: 1, globalMax: 6, projectMax: 2, roleCapacity: { developer: 4 },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    fireEvent.change(screen.getByLabelText('Общий максимум'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/scheduler/config',
      expect.objectContaining({ schemaVersion: 1, globalMax: 6, projectMax: 2 }),
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('Настройки сохранены');
  });

  test('credential-факты рендерятся только статусом, секреты не выводятся', () => {
    const source = readFileSync('src/features/settings/SettingsPage.tsx', 'utf8');
    expect(source).not.toMatch(/type="password"/);
    expect(source).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|sk-[A-Za-z0-9]+/);
  });
});

describe('Task 8 — Usage: UTC-окно и поле-уровневая недоступность', () => {
  const legacyUsage = {
    global: { inputTokens: 10, cachedTokens: 2, outputTokens: 3, totalTokens: 15, tokens: 15, cost: 0.1, aggregation: 'all_records' },
    project: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0, aggregation: 'records_with_project_id' },
    epic: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0, aggregation: 'records_with_epic_id' },
    task: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0, aggregation: 'records_with_task_id' },
    budget: { configurations: [], contexts: [], activeReservations: [] },
  };

  const windowMock = (get: ReturnType<typeof vi.spyOn>) => {
    get.mockImplementation(async (path: string) => {
      if (path === '/usage') return legacyUsage;
      if (path.startsWith('/usage?from=')) return usageWindowFixture;
      throw new Error(`Unexpected GET ${path}`);
    });
  };

  test('выбор окна вызывает GET /usage?from&to&granularity=day и рендерит breakdowns', async () => {
    const get = vi.spyOn(apiClient, 'get');
    windowMock(get);

    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    const from = await screen.findByLabelText('Начало периода (UTC)');
    const to = screen.getByLabelText('Конец периода (UTC)');
    fireEvent.change(from, { target: { value: '2026-09-24' } });
    fireEvent.change(to, { target: { value: '2026-10-24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить окно' }));

    await waitFor(() => {
      const call = get.mock.calls.find(([path]) => typeof path === 'string' && path.startsWith('/usage?'));
      expect(call).toBeDefined();
      expect(String(call![0])).toContain('granularity=day');
      expect(String(call![0])).toMatch(/from=2026-09-24T00%3A00%3A00/);
    });

    expect(await screen.findByText('Senior Developer')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.6-terra')).toBeInTheDocument();
  });

  test('anomaly/recovery-share/deterministic-check рендерятся как поле-уровнево недоступные', async () => {
    const get = vi.spyOn(apiClient, 'get');
    windowMock(get);

    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    fireEvent.change(await screen.findByLabelText('Начало периода (UTC)'), { target: { value: '2026-09-24' } });
    fireEvent.change(screen.getByLabelText('Конец периода (UTC)'), { target: { value: '2026-10-24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить окно' }));

    expect(await screen.findByText(/Аномалии стоимости недоступны/)).toBeInTheDocument();
    expect(screen.getByText(/Доля восстановления задач недоступна/)).toBeInTheDocument();
    const efficiency = screen.getByRole('region', { name: 'Эффективность' });
    expect(within(efficiency).getAllByText('Недоступно').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/NO_APPROVED_POLICY/)).not.toBeInTheDocument();
  });

  test('политики бюджета ведут на Settings candidate редактор', async () => {
    const get = vi.spyOn(apiClient, 'get');
    windowMock(get);

    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    fireEvent.change(await screen.findByLabelText('Начало периода (UTC)'), { target: { value: '2026-09-24' } });
    fireEvent.change(screen.getByLabelText('Конец периода (UTC)'), { target: { value: '2026-10-24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить окно' }));

    expect(await screen.findByRole('link', { name: 'Политики бюджета' })).toHaveAttribute('href', '/settings');
  });
});

describe('Task 8 — Agent Run: durable timeline, terminal и контроль по состоянию', () => {
  const runSubresources = () => ({
    '/runs/run-1/artifacts': [],
    '/runs/run-1/context-manifests': { availability: 'unavailable', runId: 'run-1', subject: { type: 'TASK', id: 'task-425' }, role: 'developer', reason: 'LEGACY_PROVENANCE_UNAVAILABLE' },
    '/runs/run-1/tools': { tools: [] },
    '/runs/run-1/permissions': [],
    '/runs/run-1/recovery': { runId: 'run-1', taskId: 'task-425', runStatus: 'IN_PROGRESS', recovery: null },
    '/settings': { securitySettings: { localModeEnabled: false } },
  });

  test('timeline хранит durable события по HTTP-курсору без SSE replay claim', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path.startsWith('/runs/run-1/events')) {
        if (path.includes('afterId=cursor-2')) {
          return { items: [{ id: 'e-3', type: 'run_completed', createdAt: '2026-10-24T00:03:00.000Z', payload: null }], nextCursor: null };
        }
        return { items: [
          { id: 'e-1', type: 'run_started', createdAt: '2026-10-24T00:00:00.000Z', payload: null },
          { id: 'e-2', type: 'tool_used', createdAt: '2026-10-24T00:01:00.000Z', payload: null },
        ], nextCursor: 'cursor-2' };
      }
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return activeRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    const events = await screen.findByRole('region', { name: 'События' });
    expect(events).toHaveTextContent('Запуск начат');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/runs/run-1/events'));

    fireEvent.click(screen.getByRole('button', { name: 'Загрузить ещё' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/runs/run-1/events?afterId=cursor-2&limit=50'));
    expect(await screen.findByText('Запуск завершён')).toBeInTheDocument();

    // Порядок остаётся монотонным (возрастающим): старые события раньше новых.
    const items = Array.from(events.querySelectorAll('.run-event-list li'));
    const texts = items.map((li) => li.textContent ?? '');
    const startIdx = texts.findIndex((t) => t.includes('Запуск начат'));
    const endIdx = texts.findIndex((t) => t.includes('Запуск завершён'));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    expect(screen.queryByRole('button', { name: 'Загрузить раньше' })).not.toBeInTheDocument();
  });

  test('терминал грузится лениво и рендерит sanitized записи', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-1/terminal') {
        return { availability: 'available', entries: [{ seq: 0, text: '$ pnpm test', at: '2026-10-24T00:00:00.000Z' }] };
      }
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return activeRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Запуск агента: run-1' });
    expect(get).not.toHaveBeenCalledWith('/runs/run-1/terminal');

    fireEvent.click(screen.getByRole('button', { name: 'Загрузить терминал' }));
    expect(await screen.findByText('$ pnpm test')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('<script>');
  });

  test('терминал показывает typed unavailable состояние без fallback', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-1/terminal') {
        return { availability: 'unavailable', reason: 'NO_SANITIZED_PERSISTED_SOURCE' };
      }
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return activeRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Запуск агента: run-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить терминал' }));

    expect(await screen.findByText(/Терминал недоступен/)).toBeInTheDocument();
    expect(screen.queryByText(/NO_SANITIZED_PERSISTED_SOURCE/)).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/runs/run-1/terminal');
  });

  test('checkpoint/pause/resume/cancel идут по состоянию управления, 503 → unavailable', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return activeRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/runs/run-1/checkpoint') throw new ApiError('checkpoint runtime unavailable', 503);
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    await screen.findByRole('button', { name: 'Создать контрольную точку' });
    fireEvent.click(screen.getByRole('button', { name: 'Создать контрольную точку' }));

    expect(await screen.findByText(/Контрольная точка недоступна/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать контрольную точку' })).toBeDisabled();
    expect(post).toHaveBeenCalledWith('/runs/run-1/checkpoint');
    expect(get).toHaveBeenCalledWith('/runs/run-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  test('resume доступен только при подтверждённом PAUSED состоянии', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return pausedRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/runs/run-1/resume') return { command: 'RESUME', status: 'COMPLETED', control: activeRunDetail.control, failureCode: null };
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    const resume = await screen.findByRole('button', { name: 'Возобновить запуск' });
    fireEvent.click(resume);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/runs/run-1/resume'));
    expect(screen.queryByRole('button', { name: 'Создать контрольную точку' })).not.toBeInTheDocument();
  });

  test('пауза запуска показывает ошибку без silent swallowing', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return activeRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });
    vi.spyOn(apiClient, 'post').mockRejectedValue(new ApiError('control plane down', 503));

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить запуск' }));
    expect(await screen.findByText(/Не удалось приостановить запуск/)).toBeInTheDocument();
  });

  test('usage null-vs-zero сохраняется: 0 отображается, NULL → недоступно', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return activeRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Запуск агента: run-1' });
    const usageRegion = screen.getByRole('region', { name: 'Использование запуска' });
    expect(usageRegion).toHaveTextContent('100');
    expect(usageRegion).toHaveTextContent('25');
    expect(usageRegion).toHaveTextContent('Недоступно');
    expect(get).toHaveBeenCalledWith('/runs/run-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  test('прогресс недоступен по контракту; elapsed выводится из авторитетных временных меток', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      const sub = runSubresources();
      if (path.startsWith('/runs/run-1/events')) return { items: [], nextCursor: null };
      if (path in sub) return sub[path as keyof typeof sub];
      if (path === '/runs/run-1') return activeRunDetail;
      throw new Error(`Unexpected GET ${path}`);
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Запуск агента: run-1' });
    expect(screen.getByText(/Прогресс недоступен/)).toBeInTheDocument();
    expect(screen.queryByText(/68%/)).not.toBeInTheDocument();
  });
});
