import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import ProjectOnboardingPage from '../src/features/onboarding/ProjectOnboardingPage.js';
import SettingsPage from '../src/features/settings/SettingsPage.js';
import UsagePage from '../src/features/usage/UsagePage.js';
import { ApiError, apiClient } from '../src/api/client.js';
import type { UsagePageProjection } from '@ebb-orchestrator/contracts';

function usageFixture(
  overrides: Partial<Record<'global' | 'project' | 'epic' | 'task', object>> = {},
  budgetOverrides: Partial<UsagePageProjection['budget']> = {},
): UsagePageProjection {
  const bucket = { inputTokens: 10, cachedTokens: 2, outputTokens: 3, totalTokens: 15, tokens: 15, cost: 1.25, aggregation: 'all_records' as const };
  return {
    global: { ...bucket, ...overrides.global },
    project: { ...bucket, aggregation: 'records_with_project_id', ...overrides.project },
    epic: { ...bucket, aggregation: 'records_with_epic_id', ...overrides.epic },
    task: { ...bucket, aggregation: 'records_with_task_id', ...overrides.task },
    budget: {
      configurations: budgetOverrides.configurations ?? [],
      contexts: budgetOverrides.contexts ?? [{
        scope: 'global', scopeId: 'global', projectId: null, epicId: null, taskId: null,
        applicableLimits: [], effectiveLimit: null,
      }],
      activeReservations: budgetOverrides.activeReservations ?? [],
    },
  };
}

describe('Onboarding DETECTED vs PROPOSED separation', () => {
  test('does not request an invalid onboarding endpoint when no project is selected', () => {
    const get = vi.spyOn(apiClient, 'get');

    render(<ProjectOnboardingPage id="" />);

    expect(screen.getByRole('heading', { name: 'Настройка проекта' })).toBeInTheDocument();
    expect(screen.getByText(/Выберите проект/i)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test('renders detected branch/package manager separately from Coordinator proposals', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      projectId: '1',
      repository: { path: '/repo', remoteUrl: 'https://github.com/test/repo.git' },
      detected: {
        defaultBranch: 'main',
        packageManager: 'pnpm',
        testFramework: 'vitest',
        ebbOrchestratorConfigFound: false,
      },
      proposed: {
        defaultBranch: 'main',
        workflow: 'standard',
        roles: ['Developer', 'Reviewer', 'QA'],
        guidelines: [],
      },
      approvalStatus: 'PENDING',
      semanticConfigApproved: false,
      localModeEnabled: false,
    });

    render(<ProjectOnboardingPage id="1" />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Обнаружено' })).toBeInTheDocument());
    expect(screen.getByText(/Менеджер пакетов: pnpm/)).toBeInTheDocument();

    expect(screen.getByText(/Рабочий процесс: standard/)).toBeInTheDocument();
    expect(screen.getByText(/Роли: Developer, Reviewer, QA/)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Активация проекта недоступна/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('activation button cannot proceed with unresolved semantic config approval', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      projectId: '1',
      repository: { path: '/repo', remoteUrl: 'https://github.com/test/repo.git' },
      detected: { defaultBranch: 'main', packageManager: 'npm', testFramework: null, ebbOrchestratorConfigFound: false },
      proposed: { defaultBranch: 'main', workflow: 'standard', roles: ['Developer'], guidelines: [] },
      approvalStatus: 'PENDING',
      semanticConfigApproved: false,
      localModeEnabled: false,
    });

    render(<ProjectOnboardingPage id="1" />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Обнаружено' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.getByText(/не предоставляет обход этой политики на стороне клиента/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('does not fabricate an activation action without backend authority', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      projectId: '1',
      repository: { path: '/repo', remoteUrl: 'https://github.com/test/repo.git' },
      detected: { defaultBranch: 'main', packageManager: 'npm', testFramework: null, ebbOrchestratorConfigFound: false },
      proposed: { defaultBranch: 'main', workflow: 'standard', roles: ['Developer'], guidelines: [] },
      approvalStatus: 'PENDING',
      semanticConfigApproved: true,
      localModeEnabled: false,
    });

    render(<ProjectOnboardingPage id="1" />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Обнаружено' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Активация проекта недоступна/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('Settings page configuration hierarchy', () => {
  test('shows effective hierarchy Global → Project → Role → Task/Epic', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: {
        global: { schemaVersion: 1, globalMax: 7, projectMax: 3, roleCapacity: { developer: 4 } },
        project: null,
        role: null,
        taskEpic: null,
      },
      securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Глобально' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Проект' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Роль' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Задача/эпик' })).toBeInTheDocument();
    expect(screen.getByText('Общий максимум: 7')).toBeInTheDocument();
    expect(screen.queryByText(/gpt-4/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('labels unsupported hierarchy and security settings as unavailable', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: { global: { schemaVersion: null, globalMax: null, projectMax: null, roleCapacity: null }, project: null, role: null, taskEpic: null },
      securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Безопасность' })).toBeInTheDocument());
    expect(screen.getAllByText(/Недоступно/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Локальный режим: Выключен/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders retryable settings load failure without exposing backend details', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('secret: settings unavailable')).mockResolvedValueOnce({
      effectiveHierarchy: { global: { schemaVersion: 1, globalMax: 4, projectMax: 3, roleCapacity: {} }, project: null, role: null, taskEpic: null },
      securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
    });

    render(<SettingsPage />);

    expect(await screen.findByText('Не удалось загрузить настройки: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Повторить' }).click();
    await waitFor(() => expect(screen.getByText('Общий максимум: 4')).toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  test('maps recognized settings API error codes to safe Russian copy', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new ApiError('secret: settings detail', 403, 'AUTH_FORBIDDEN'));

    render(<SettingsPage />);

    expect(await screen.findByText('Не удалось загрузить настройки: Доступ запрещён.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
  });
});

describe('Usage page budget tracking', () => {
  test('renders loading usage data as a canonical status region', () => {
    vi.spyOn(apiClient, 'get').mockReturnValue(new Promise(() => undefined));

    render(<UsagePage />);

    expect(screen.getByRole('status')).toHaveTextContent('Загрузка данных об использовании…');
    vi.restoreAllMocks();
  });

  test('shows corrected token metrics with honest aggregate labels', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(usageFixture({
      global: { inputTokens: 100, cachedTokens: 20, outputTokens: 30, totalTokens: 150, tokens: 150, cost: 10 },
    }));

    render(<UsagePage />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Все записи' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Записи с project_id' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Записи с epic_id' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Записи с task_id' })).toBeInTheDocument();
    const allRecords = screen.getByRole('heading', { name: 'Все записи' }).closest('article');
    expect(allRecords).not.toBeNull();
    expect(within(allRecords!).getByText('100')).toBeInTheDocument();
    expect(within(allRecords!).getByText('20')).toBeInTheDocument();
    expect(within(allRecords!).getByText('30')).toBeInTheDocument();
    expect(within(allRecords!).getByText('150')).toBeInTheDocument();
    expect(allRecords).toHaveTextContent('$10.00');
    expect(screen.getByText('Настроенных лимитов нет.')).toBeInTheDocument();
    expect(screen.queryByText('global')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/usage', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('shows explicit empty state for zero aggregate usage', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(usageFixture({
      global: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
      project: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
      epic: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
      task: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
    }));

    render(<UsagePage />);

    expect(await screen.findByText('Нет данных об использовании, лимитов бюджета или активных резервирований.')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders retryable error and refetches authoritative usage', async () => {
    const get = vi.spyOn(apiClient, 'get')
      .mockRejectedValueOnce(new Error('usage unavailable'))
      .mockResolvedValueOnce(usageFixture());

    render(<UsagePage />);

    expect(await screen.findByText('Не удалось загрузить данные об использовании: Не удалось выполнить запрос.')).toBeInTheDocument();
    get.mockResolvedValue(usageFixture());
    screen.getByRole('button', { name: 'Повторить' }).click();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Все записи' })).toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  test('refetches usage after SSE reconnect', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(usageFixture());

    render(<UsagePage />);

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new CustomEvent('sse-reconnect'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });

  test('renders configured scope limits, effective limiting config, and active reservations read-only', async () => {
    const globalLimit = { scope: 'global', scopeId: 'global', limitCost: 100, softLimitCost: 80, policy: 'hard', spentCost: 10, reservedCost: 5 } as const;
    const projectLimit = { scope: 'project', scopeId: 'project-1', limitCost: 50, softLimitCost: 40, policy: 'soft', spentCost: 20, reservedCost: 3 } as const;
    const reservation = {
      id: 'reservation-1', projectId: 'project-1', epicId: null, taskId: null,
      estimateCost: 2.5, status: 'RESERVED', role: 'developer', model: 'model-x',
      triggerReason: 'DEVELOPMENT', reworkCategory: null, createdAt: '2026-09-30T12:00:00.000Z',
    } as const;
    vi.spyOn(apiClient, 'get').mockResolvedValue(usageFixture({}, {
      configurations: [globalLimit, projectLimit],
      contexts: [
        { scope: 'global', scopeId: 'global', projectId: null, epicId: null, taskId: null, applicableLimits: [globalLimit], effectiveLimit: globalLimit },
        { scope: 'project', scopeId: 'project-1', projectId: 'project-1', epicId: null, taskId: null, applicableLimits: [globalLimit, projectLimit], effectiveLimit: projectLimit },
      ],
      activeReservations: [reservation],
    }));

    render(<UsagePage />);

    expect(await screen.findByRole('heading', { name: 'Лимиты бюджета' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Сохранённые конфигурации лимитов' })).toHaveTextContent('Жёсткая (hard)');
    expect(screen.getByRole('table', { name: 'Сохранённые конфигурации лимитов' })).toHaveTextContent('Мягкая (soft)');
    const effectiveTable = screen.getByRole('table', { name: 'Наиболее строгая применимая конфигурация для каждой области' });
    expect(effectiveTable).toHaveTextContent('Глобально (global), Проект (project-1)');
    expect(effectiveTable).toHaveTextContent('Проект (project-1)');
    expect(screen.getByRole('table', { name: 'Записи со статусом RESERVED' })).toHaveTextContent('reservation-1');
    expect(screen.getByText('Текущие резервирования')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
