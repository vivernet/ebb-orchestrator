import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProjectOnboardingPage from '../src/features/onboarding/ProjectOnboardingPage.js';
import SettingsPage from '../src/features/settings/SettingsPage.js';
import UsagePage from '../src/features/usage/UsagePage.js';
import { ApiError, apiClient } from '../src/api/client.js';

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
      detected: { defaultBranch: 'main', packageManager: 'pnpm', testFramework: 'vitest', ebbOrchestratorConfigFound: false },
      proposed: { defaultBranch: 'main', workflow: 'standard', roles: ['Developer', 'Reviewer', 'QA'], guidelines: [] },
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
});

describe('Settings page (reference 08)', () => {
  const settingsProjection = {
    effectiveHierarchy: { global: { schemaVersion: 1, globalMax: 7, projectMax: 3, roleCapacity: { developer: 4 } }, project: null, role: null, taskEpic: null },
    securitySettings: { mostRestrictiveWins: true, localModeEnabled: true },
    providerSelection: { defaultModel: 'default', models: [] },
  };

  test('рендерит разделы навигации и статичные карточки макета', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsProjection);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Настройки проекта · Ebb AI Hub' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Разделы настроек' })).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Роли и модели')).toBeInTheDocument();
    expect(screen.getByText('Scheduler')).toBeInTheDocument();
    expect(screen.getByText('Восстановление')).toBeInTheDocument();
    expect(screen.getByText('Git & GitHub')).toBeInTheDocument();
    expect(screen.getByText('Владение конфигурацией')).toBeInTheDocument();
    expect(screen.queryByText(/gpt-4/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('рендерит retryable ошибку загрузки без раскрытия деталей backend', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new ApiError('secret: settings unavailable', 500)).mockResolvedValueOnce(settingsProjection);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить настройки: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Повторить' }).click();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Настройки проекта · Ebb AI Hub' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('не выводит значения ключей в DOM', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsProjection);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    await screen.findByRole('heading', { name: 'Настройки проекта · Ebb AI Hub' });
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
    expect(document.body).not.toHaveTextContent(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
    vi.restoreAllMocks();
  });
});

describe('Usage page (reference 09)', () => {
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

  test('рендерит метрики и секции макета', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(usageProjection);
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Использование и бюджет' })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Сводка использования' });
    expect(summary).toHaveTextContent('$6.42');
    expect(summary).toHaveTextContent('$128.73');
    expect(summary).toHaveTextContent('1.84M');
    expect(screen.getByText('Бюджеты проектов')).toBeInTheDocument();
    expect(screen.getByText('Расходы по ролям')).toBeInTheDocument();
    expect(screen.getByText('Эффективность')).toBeInTheDocument();
    expect(screen.getByText('Политика бюджета')).toBeInTheDocument();
    expect(screen.queryByText(/NO_APPROVED_POLICY/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('рендерит retryable ошибку и перезапрашивает', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new ApiError('usage unavailable', 500)).mockResolvedValueOnce(usageProjection);
    render(<MemoryRouter><UsagePage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить данные об использовании: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/usage unavailable/)).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Повторить' }).click();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Использование и бюджет' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
