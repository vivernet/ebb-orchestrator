/// <reference types="node" />
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { apiClient } from '../src/api/client.js';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import TaskPage from '../src/features/tasks/TaskPage.js';
import EpicPage from '../src/features/epics/EpicPage.js';
import ApprovalInboxPage from '../src/features/approvals/ApprovalInboxPage.js';
import ExecutionPage from '../src/features/execution/ExecutionPage.js';
import ProjectPage from '../src/features/projects/ProjectPage.js';
import OnboardingPage from '../src/features/onboarding/OnboardingPage.js';
import SettingsPage from '../src/features/settings/SettingsPage.js';
import UsagePage from '../src/features/usage/UsagePage.js';
import AgentRunPage from '../src/features/runs/AgentRunPage.js';
import * as projectApi from '../src/features/projects/api.js';
import { apiErrorMessage, ru } from '../src/i18n/ru.js';
import { readFileSync } from 'node:fs';

const baseCssSrc = readFileSync('src/styles/base.css', 'utf8');

function expectToken(name: string, value: string) {
  expect(baseCssSrc, name).toMatch(new RegExp(`${name}:\\s*${value}`));
}

function renderPage(page: React.ReactNode) {
  return render(<MemoryRouter>{page}</MemoryRouter>);
}

function expectLayout(name: string, layout: string) {
  const page = document.querySelector(`.reference-screen--${name}`);
  expect(page, `Экран ${name} должен иметь отдельную макетную композицию`).not.toBeNull();
  expect(page?.querySelector(`.${layout}`), `Экран ${name} должен использовать ${layout}`).not.toBeNull();
}

describe('Композиция экранов по утверждённым макетам', () => {
  test('Dashboard группирует реальные сводные карточки и рабочие панели', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/dashboard'
      ? { activeAgents: [], activeWork: [], approvals: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, projects: [] }
      : { running: [], waiting: [], blocked: [] });
    renderPage(<DashboardPage />);

    expect(await screen.findByRole('heading', { name: 'Обзор' })).toBeInTheDocument();
    expectLayout('dashboard', 'reference-metrics');
    expect(screen.getByRole('region', { name: 'Центр согласований' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Очередь выполнения' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Чат с координатором' })).toBeInTheDocument();
    const dashboardColumns = document.querySelector('.dashboard-columns');
    const chatPanel = dashboardColumns?.querySelector('.dashboard-chat-panel');
    expect(chatPanel).not.toBeNull();
    expect(chatPanel?.parentElement).toBe(dashboardColumns);
    expect(chatPanel).toHaveClass('dashboard-chat-panel');
    vi.restoreAllMocks();
  });

  test('Task удерживает процесс, контракт и связанную работу в двухколоночном обзоре', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      task: { title: 'Task', status: 'READY', project_id: 'project-1', epic_id: null }, contract: {},
      lifecycle: { status: 'READY', stage: 'READY', updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
      scheduler: { status: 'RUNNABLE', reason: null },
    });
    renderPage(<TaskPage id="task-1" />);

    expect(await screen.findByRole('tablist', { name: 'Разделы задачи' })).toBeInTheDocument();
    expectLayout('task', 'reference-columns');
    expect(screen.getByRole('region', { name: 'Рабочий процесс' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Связанная работа' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Epic показывает lifecycle и дочернюю работу рядом с контекстными панелями', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      epic: { title: 'Epic', status: 'READY' }, contract: null,
      lifecycle: { status: 'READY', stage: null, updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    renderPage(<EpicPage id="epic-1" />);

    expect(await screen.findByRole('heading', { name: 'Эпик: Epic' })).toBeInTheDocument();
    expectLayout('epic', 'reference-columns');
    expect(screen.getByRole('region', { name: 'Жизненный цикл эпика и граф параллельной работы' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Задачи' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Approval Inbox отделяет очередь решений от выбранного evidence', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ approvals: [{
      id: 'approval-1', type: 'PLAN_CHANGE', subject_id: 'task-1', subject_type: 'TASK',
      status: 'PENDING', requested_by: 'Coordinator', resolved_by: null, resolution_note: null,
      created_at: '2026-10-24T00:00:00.000Z', resolved_at: null,
    }] });
    renderPage(<ApprovalInboxPage />);

    expect(await screen.findByRole('heading', { name: 'Входящие согласования' })).toBeInTheDocument();
    expectLayout('approvals', 'approval-layout');
    expect(screen.getByRole('region', { name: 'Очередь согласований' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Детали согласования' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Execution Queue separates active, waiting and blocked work without invented capacity', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      running: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
      waiting: [{ taskId: 'task-2', reason: { code: 'WAITING_FOR_CAPACITY', message: '' } }],
      blocked: [{ taskId: 'task-3', reason: { code: 'BLOCKED_BY_WORKFLOW', message: '' } }],
    });
    renderPage(<ExecutionPage />);

    expect(await screen.findByRole('heading', { name: 'Монитор выполнения' })).toBeInTheDocument();
    expectLayout('execution', 'reference-columns');
    expect(screen.getByRole('region', { name: 'Активные запуски' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Очередь ожидания' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Заблокированная работа' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Приостановить всё' })).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Project groups returned work separately from project facts and activity', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue({
      project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    renderPage(<ProjectPage id="project-1" />);

    expect(await screen.findByRole('heading', { name: 'Проект: Project One' })).toBeInTheDocument();
    expectLayout('project', 'reference-columns');
    expect(screen.getByRole('region', { name: 'Эпики и задачи' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Сведения о проекте' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Onboarding keeps the five-step flow and discovery form in its wizard layout', () => {
    renderPage(<OnboardingPage />);

    expect(screen.getByRole('heading', { name: 'Настройка проекта' })).toBeInTheDocument();
    expectLayout('onboarding', 'onboarding-layout');
    expect(screen.getByRole('list', { name: 'Этапы онбординга' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Поиск проекта' })).toBeInTheDocument();
  });

  test('Settings provides section navigation over only supported settings projections', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: { global: { schemaVersion: 1, globalMax: 4, projectMax: 2, roleCapacity: null }, project: null, role: null, taskEpic: null },
      securitySettings: { mostRestrictiveWins: true, localModeEnabled: true },
      providerSelection: { defaultModel: 'default', models: [] },
    });
    renderPage(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Настройки' })).toBeInTheDocument();
    expectLayout('settings', 'settings-layout');
    expect(screen.getByRole('navigation', { name: 'Разделы настроек' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Планировщик' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Безопасность' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Восстановление' })).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Usage groups concrete metrics, saved budgets and reservations', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      window: { from: '2026-09-24T00:00:00.000Z', to: '2026-10-24T23:59:59.999Z', granularity: 'day' },
      summary: { inputTokens: 12, cachedTokens: 3, outputTokens: 9, totalTokens: 21, cost: 0.2 },
      dailySeries: [{ date: '2026-09-25', usage: { inputTokens: 12, cachedTokens: 3, outputTokens: 9, totalTokens: 21, cost: 0.2 } }],
      breakdowns: { byRole: [], byReason: [], byModel: [] },
      modelComparison: [],
      budgets: {
        configurations: [],
        contexts: [{ scope: 'global', scopeId: 'global', projectId: null, epicId: null, taskId: null, applicableLimits: [], effectiveLimit: null }],
        activeReservations: [],
      },
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
    });
    renderPage(<UsagePage />);

    expect(await screen.findByRole('heading', { name: 'Использование и бюджет' })).toBeInTheDocument();
    expectLayout('usage', 'reference-columns');
    expect(screen.getByRole('region', { name: 'Дневная серия' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Лимиты бюджета' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Agent Run places its observable event stream beside runtime context', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-1/events' || path === '/runs/run-1/permissions') return [];
      if (path === '/runs/run-1/tools') return { tools: [] };
      if (path === '/runs/run-1/recovery') return { runId: 'run-1', taskId: null, runStatus: 'DONE', recovery: null };
      if (path === '/runs/run-1/artifacts') return [];
      if (path === '/runs/run-1/context-manifests') return { availability: 'unknown', role: 'Developer' };
      if (path === '/settings') return { securitySettings: { localModeEnabled: false } };
      return {
        id: 'run-1', role: 'Developer', runtime: 'hermes', model: 'default', status: 'DONE',
        taskId: null, epicId: null, triggerReason: null, startedAt: null, endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      };
    });
    renderPage(<AgentRunPage id="run-1" />);

    expect(await screen.findByRole('heading', { name: 'Запуск агента: run-1' })).toBeInTheDocument();
    expectLayout('run', 'reference-columns');
    expect(screen.getByRole('region', { name: 'События' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Разрешения' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Создать контрольную точку' })).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('Фиксированная геометрия и токены по референсу', () => {
  test('боковая панель ровно 230px без дублирующих override', () => {
    expectToken('--sidebar', '230px');
    expect(baseCssSrc).not.toContain('236px');
    expect(baseCssSrc).toMatch(/\.app-shell\s*\{[^}]*grid-template-columns:\s*(?:var\(--sidebar\)|230px)/);
  });

  test('основное содержимое использует отступы 24px/28px/36px', () => {
    expect(baseCssSrc).toMatch(/\.main-content\s*\{[^}]*padding:\s*24px 28px 36px/);
  });

  test('панели используют единый шаг 16px', () => {
    expect(baseCssSrc).toMatch(/\.reference-panel[^{]*\{[^}]*padding:\s*16px/);
  });

  test('плоские поверхности: без градиентов и теней в базе', () => {
    expect(baseCssSrc).not.toMatch(/gradient\(/);
    expect(baseCssSrc).not.toMatch(/box-shadow:/);
  });

  test('палитра совпадает с референсом', () => {
    expectToken('--bg', '#0b0d10');
    expectToken('--panel', '#12161b');
    expectToken('--panel2', '#171c22');
    expectToken('--border', '#252c34');
    expectToken('--text', '#eef2f6');
    expectToken('--muted', '#8e9aa7');
    expectToken('--accent', '#8ab4ff');
    expectToken('--good', '#77d19a');
    expectToken('--warn', '#e8c66a');
    expectToken('--bad', '#ef8e8e');
  });

  test('типографика: база 14px, заголовок страницы 24px', () => {
    expect(baseCssSrc).toMatch(/font-size:\s*14px/);
    expect(baseCssSrc).toMatch(/\.page-header h1[^{]*\{[^}]*font-size:\s*24px/);
  });
});

describe('Русские подписи разделов референса', () => {
  test('все ключевые подписи присутствуют в ru.ts', () => {
    expect(ru.dashboard.runningAgents).toBe('Работающие агенты');
    expect(ru.dashboard.activeWork).toBe('Активная работа');
    expect(ru.dashboard.pendingApprovals).toBe('Требуют согласования');
    expect(ru.dashboard.aiSpendToday).toBe('Расходы ИИ сегодня');
    expect(ru.dashboard.activeProjects).toBe('Активные проекты');
    expect(ru.dashboard.newRequest).toBe('Новый запрос');
    expect(ru.runs.createCheckpoint).toBe('Создать контрольную точку');
  });

  test('ошибки курсора и невалидного ответа локализованы', () => {
    expect(apiErrorMessage('INVALID_RESPONSE')).toBe('Ответ сервера не соответствует контракту.');
    expect(apiErrorMessage('INVALID_CURSOR')).not.toBe('Не удалось выполнить запрос.');
    expect(apiErrorMessage('INVALID_CURSOR')).toMatch(/[А-Яа-яЁё]/);
  });
});
