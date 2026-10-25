import { describe, test, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import ProjectPage from '../src/features/projects/ProjectPage.js';
import EpicPage from '../src/features/epics/EpicPage.js';
import TaskPage from '../src/features/tasks/TaskPage.js';
import * as dashboardApi from '../src/features/dashboard/api.js';
import * as projectApi from '../src/features/projects/api.js';
import { apiClient } from '../src/api/client.js';
import WorkflowTimeline, { displayStageForLifecycle } from '../src/components/WorkflowTimeline.js';

function renderDashboard() {
  return render(<MemoryRouter><DashboardPage /></MemoryRouter>);
}

describe('Workflow lifecycle display mapping', () => {
  test.each([
    ['DRAFT', null],
    ['READY', 'DEV'],
    ['DEVELOPMENT', 'DEV'],
    ['REVIEW', 'REVIEW'],
    ['QA', 'QA'],
    ['READY_FOR_INTEGRATION', 'INTEGRATION'],
    ['INTEGRATION', 'INTEGRATION'],
    ['INTEGRATED_INTO_EPIC', 'INTEGRATION'],
    ['READY_FOR_MERGE', 'MERGE'],
    ['MERGING', 'MERGE'],
    ['DONE', 'MERGE'],
    ['RELEASED', 'MERGE'],
    ['BLOCKED', null],
  ])('maps %s to %s', (lifecycle, stage) => {
    expect(displayStageForLifecycle(lifecycle)).toBe(stage);
  });

  test.each(['WAITING_FOR_DEPENDENCY', 'WAITING_FOR_APPROVAL', 'BLOCKED', 'PAUSED', 'FAILED', 'CANCELLED'])('%s does not complete normal stages by position', (status) => {
    render(<WorkflowTimeline stages={['DEV', 'REVIEW', 'QA', 'FAILED', 'CANCELLED']} currentStage={status} />);

    const labels: Record<string, string> = { WAITING_FOR_DEPENDENCY: 'Ожидает зависимости', WAITING_FOR_APPROVAL: 'Ожидает согласования', BLOCKED: 'Заблокировано', PAUSED: 'Приостановлено', FAILED: 'Ошибка', CANCELLED: 'Отменено' };
    expect(screen.getByText(labels[status] ?? '')).toHaveStyle({ color: '#fff', fontWeight: '600' });
    expect(screen.getByText('Разработка')).not.toHaveStyle({ color: '#888' });
    expect(screen.getByText('Проверка')).not.toHaveStyle({ color: '#888' });
    expect(screen.getByText('Контроль качества')).not.toHaveStyle({ color: '#888' });
  });
});

describe('Dashboard', () => {
  test('renders coded active-work and queue reasons in Russian without backend messages', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({
      activeAgents: [], activeWork: [{ id: 'task-1', title: 'Blocked work', status: 'BLOCKED', eligibility: { status: 'BLOCK', reason: { code: 'PROJECT_NOT_ACTIVE', message: 'Secret backend detail' } } }],
      approvals: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, projects: [],
    });
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue({
      running: [], waiting: [{ taskId: 'task-2', reason: { code: 'WAITING_FOR_RESOURCE_LOCK', message: 'Secret backend detail' } }],
      blocked: [{ taskId: 'task-3', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'Secret backend detail' } }],
      capacity: { configured: 4, used: 0 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null },
    });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: /Blocked work/ })).toHaveTextContent('Проект не активен.');
    expect(screen.getByRole('region', { name: 'Очередь выполнения' })).toHaveTextContent('Ожидается освобождение ресурса.');
    expect(screen.getByRole('region', { name: 'Очередь выполнения' })).toHaveTextContent('Заблокировано рабочим процессом.');
    expect(screen.queryByText(/Secret backend detail/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
  test('renders values from the dashboard projection', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({
      activeAgents: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
      activeWork: [{ id: 'task-1', title: 'Ship projection', status: 'DEV', eligibility: { status: 'RUNNABLE', reason: null } }],
      approvals: 2, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 2, totalTokens: 3, cost: 0.42 },
      projects: [{ id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' }],
    });
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue({ running: [], waiting: [], blocked: [], capacity: { configured: 4, used: 0 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null } });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Ship projection/)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Developer/ })).toHaveAttribute('href', '/runs/run-1');
    expect(screen.getByText(/\$0.42/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ship projection/ })).toHaveAttribute('href', '/tasks/task-1');
    expect(screen.getByRole('link', { name: /Developer/ })).toHaveAttribute('href', '/runs/run-1');
    expect(screen.getByRole('link', { name: /Project One/ })).toHaveAttribute('href', '/projects/project-1');
    vi.restoreAllMocks();
  });

  test('encodes projection IDs in detail links', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({
      activeAgents: [{ runId: 'run/1', role: 'Developer', taskId: 'task/1', status: 'IN_PROGRESS' }],
      activeWork: [{ id: 'task/1', title: 'Encoded task', status: 'DEV', eligibility: { status: 'RUNNABLE', reason: null } }],
      approvals: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
      projects: [{ id: 'project/1', name: 'Project', displayName: 'Encoded project', status: 'ACTIVE' }],
    });
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue({ running: [], waiting: [], blocked: [], capacity: { configured: 4, used: 0 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null } });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('link', { name: /Encoded task/ })).toHaveAttribute('href', '/tasks/task%2F1'));
    expect(screen.getByRole('link', { name: /Developer/ })).toHaveAttribute('href', '/runs/run%2F1');
    expect(screen.getByRole('link', { name: /Encoded project/ })).toHaveAttribute('href', '/projects/project%2F1');
    vi.restoreAllMocks();
  });

  test('keeps dashboard projection and queue failures independent', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockRejectedValue(new Error('dashboard unavailable'));
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue({ running: [], waiting: [], blocked: [], capacity: { configured: 4, used: 0 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null } });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить сводные показатели: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.getByText('Очередь пуста.')).toBeInTheDocument();
    expect(screen.queryByText('Не удалось загрузить очередь:')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('refetches dashboard and execution projections after SSE reconnect', async () => {
    const dashboard = vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({
      activeAgents: [], activeWork: [], approvals: 0,
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, projects: [],
    });
    const execution = vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue({ running: [], waiting: [], blocked: [], capacity: { configured: 4, used: 0 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null } });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    await waitFor(() => {
      expect(dashboard).toHaveBeenCalledTimes(1);
      expect(execution).toHaveBeenCalledTimes(1);
    });
    window.dispatchEvent(new CustomEvent('sse-reconnect'));

    await waitFor(() => {
      expect(dashboard).toHaveBeenCalledTimes(2);
      expect(execution).toHaveBeenCalledTimes(2);
    });
    vi.restoreAllMocks();
  });

  test('exposes the agent pool section', () => {
    renderDashboard();
    expect(screen.getByRole('region', { name: 'Пул агентов' })).toBeInTheDocument();
  });

  test('exposes Active work section', () => {
    renderDashboard();
    expect(screen.getByText(/Активная работа/i)).toBeInTheDocument();
  });

  test('exposes the approval center', () => {
    renderDashboard();
    expect(screen.getByRole('region', { name: 'Центр согласований' })).toBeInTheDocument();
  });

  test('exposes key indicators', () => {
    renderDashboard();
    expect(screen.getByRole('region', { name: 'Ключевые показатели' })).toBeInTheDocument();
  });

  test('exposes active projects section', () => {
    renderDashboard();
    expect(screen.getByText('Активные проекты')).toBeInTheDocument();
  });

  test('exposes execution queue section', () => {
    renderDashboard();
    expect(screen.getByRole('region', { name: 'Очередь выполнения' })).toBeInTheDocument();
  });

  test('does not expose an unsupported Coordinator Chat entry', () => {
    renderDashboard();
    expect(screen.queryByRole('heading', { name: 'Coordinator Chat' })).not.toBeInTheDocument();
    expect(screen.queryByText(/submit a request for project work/i)).not.toBeInTheDocument();
  });

  test('exposes the approved dashboard operations', () => {
    renderDashboard();
    expect(screen.getByRole('region', { name: 'Центр согласований' })).toBeInTheDocument();
    expect(screen.getByText('Пул агентов')).toBeInTheDocument();
    expect(screen.queryByText('Coordinator Chat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Request' })).not.toBeInTheDocument();
  });
});

describe('Task', () => {
  function defaultTaskProjection(overrides: Record<string, unknown> = {}) {
    return {
      task: { title: 'Task', status: 'READY', project_id: 'p', epic_id: null }, contract: {},
      lifecycle: { status: 'READY', stage: 'READY', updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
      scheduler: { status: 'RUNNABLE', reason: null },
      ...overrides,
    };
  }

  const renderTask = (id = 'task-1') => render(<MemoryRouter><TaskPage id={id} /></MemoryRouter>);

  async function openTab(name: string) {
    fireEvent.click(screen.getByRole('tab', { name }));
  }

  test('renders the persisted current and completed lifecycle states', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Released task', status: 'DONE', project_id: null, epic_id: null },
      lifecycle: { status: 'DONE', stage: 'DONE', updatedAt: '2026-09-16T00:00:00Z' },
    }));
    renderTask('task-1');
    await waitFor(() => expect(screen.getByText('Статус: Завершено')).toBeInTheDocument());
    expect(screen.getByText('Разработка')).toBeInTheDocument();
    expect(screen.getAllByText('Завершено').length).toBeGreaterThan(0);
    expect(screen.getByText('Выпущено')).toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/tasks/task-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('renders waiting and failure/cancellation statuses as timeline states', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Blocked task', status: 'FAILED', project_id: null, epic_id: null },
      lifecycle: { status: 'FAILED', stage: 'FAILED', updatedAt: null },
      scheduler: { status: 'WAIT', reason: { code: 'WAITING_FOR_DEPENDENCY', message: 'Waiting for dependency' } },
    }));
    renderTask('task-2');
    await waitFor(() => expect(screen.getByText('Статус: Ошибка')).toBeInTheDocument());
    expect(screen.getByText('Ожидает зависимости')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Рабочий процесс' })).toHaveTextContent('Ожидается выполнение зависимости.');
    expect(screen.getByText('Отменено')).toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/tasks/task-2', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('renders a paused task and its localized scheduler reason', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Paused task', status: 'PAUSED', project_id: null, epic_id: null },
      lifecycle: { status: 'PAUSED', stage: 'PAUSED', updatedAt: null },
      scheduler: { status: 'WAIT', reason: { code: 'WAITING_FOR_PAUSE', message: 'Task is paused' } },
    }));
    renderTask('paused-task');
    expect(await screen.findByText('Статус: Приостановлено')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Рабочий процесс' })).toHaveTextContent('Ожидается возобновление задачи.');
    expect(_get).toHaveBeenCalledWith('/tasks/paused-task', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('renders explicit task not-found and empty subordinate states', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: null, contract: null,
      lifecycle: { status: 'UNKNOWN', stage: null, updatedAt: null },
      scheduler: { status: 'BLOCK', reason: { code: 'ONBOARDING_NOT_ACTIVE', message: 'Онбординг проекта не активирован' } },
    }));
    renderTask('missing/task');

    expect(await screen.findByRole('alert')).toHaveTextContent('Задача не найдена.');
    expect(_get).toHaveBeenCalledWith('/tasks/missing%2Ftask', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('links only present task run, project, epic, and dependency IDs with encoding', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Linked task', status: 'READY', project_id: 'project/1', epic_id: 'epic/1' },
      runs: [{ id: 'run/1', role: 'Developer', status: 'IN_PROGRESS' }],
      dependencies: [{ id: 'dependency-1', taskId: 'task/1', dependsOnTaskId: 'dependency/task/1', type: 'BLOCKS', status: 'READY' }],
    }));
    renderTask('task/1');

    await screen.findByRole('tab', { name: 'Запуски' });
    await openTab('Запуски');
    expect(await screen.findByRole('link', { name: /Developer · Выполняется/ })).toHaveAttribute('href', '/runs/run%2F1');

    await openTab('Обзор');
    expect(screen.getByRole('link', { name: /Проект/ })).toHaveAttribute('href', '/projects/project%2F1');
    expect(screen.getByRole('link', { name: /Эпик/ })).toHaveAttribute('href', '/epics/epic%2F1');
    expect(screen.getAllByRole('link', { name: /task\/1/ }).find((link) => link.getAttribute('href') === '/tasks/task%2F1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dependency\/task\/1/ })).toHaveAttribute('href', '/tasks/dependency%2Ftask%2F1');
    expect(_get).toHaveBeenCalledWith('/tasks/task%2F1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('exposes contract tab', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByRole('tab', { name: 'Контракт' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes workflow section', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByText('Процесс задачи')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes Agent Runs tab', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByRole('tab', { name: 'Запуски' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes findings/defects tab', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByRole('tab', { name: 'Review' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes Git tab', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByRole('tab', { name: 'Git' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes recovery section', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByText('Восстановление')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes usage tab', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByRole('tab', { name: 'Использование' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('Project', () => {
  test('renders GitHub connection as a safe Russian status', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue({
      project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' },
      git: { repositoryPath: '/repo', branch: null, defaultBranch: 'main', github: { status: 'CONNECTED', url: null }, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<MemoryRouter><ProjectPage id="project-1" /></MemoryRouter>);
    expect(await screen.findByText(/GitHub подключён/)).toBeInTheDocument();
    expect(screen.queryByText(/CONNECTED/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test.each([
    [ProjectPage, 'project-1', 'Не удалось загрузить проект: Не удалось выполнить запрос.'],
    [EpicPage, 'epic-1', 'Не удалось загрузить эпик: Не удалось выполнить запрос.'],
    [TaskPage, 'task-1', 'Не удалось загрузить задачу: Не удалось выполнить запрос.'],
  ])('shows a retryable error instead of an indefinite loading view', async (Component, id, message) => {
    const _get = vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network unavailable'));
    render(createElement(Component, { id }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(_get).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });

  test('renders project details', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue({
      project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' },
      git: { repositoryPath: '/repo', branch: null, defaultBranch: 'main', github: { status: 'CONNECTED', url: null }, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<MemoryRouter><ProjectPage id="1" /></MemoryRouter>);
    expect(await screen.findByText(/Проект:/)).toBeInTheDocument();
    expect(screen.getByText(/Репозиторий \/ путь \/ ветка \/ GitHub/)).toBeInTheDocument();
    expect(screen.queryByText(/Runs · Git · Guidelines · Usage/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders populated project activity without exposing event payload', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue({
      project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [],
      events: [{ id: 'event-1', type: 'TASK_CREATED', createdAt: '2026-09-28T10:30:00.000Z', payload: { secret: 'must-not-render' } }],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<MemoryRouter><ProjectPage id="project-1" /></MemoryRouter>);

    expect(await screen.findByText('TASK_CREATED')).toBeInTheDocument();
    expect(screen.getByRole('time')).toHaveAttribute('dateTime', '2026-09-28T10:30:00.000Z');
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('loads the project matching the current route ID after navigation', async () => {
    const getProjectOverview = vi.spyOn(projectApi, 'getProjectOverview').mockImplementation(async (id) => ({
      project: { id, name: id, displayName: `Project ${id}`, status: 'ACTIVE' },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    }));
    const view = render(<MemoryRouter><ProjectPage id="route-project-a" /></MemoryRouter>);

    expect(await screen.findByText('Проект: Project route-project-a')).toBeInTheDocument();
    expect(screen.getAllByText('Активно').length).toBeGreaterThan(0);
    view.rerender(<MemoryRouter><ProjectPage id="route-project-b" /></MemoryRouter>);

    await waitFor(() => expect(getProjectOverview).toHaveBeenLastCalledWith('route-project-b'));
    expect(await screen.findByText('Проект: Project route-project-b')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders explicit project not-found state when projection has no project', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue({
      project: null, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<ProjectPage id="missing/project" />);

    const notFoundAlert = await screen.findByRole('alert');
    expect(notFoundAlert).toHaveTextContent('Проект не найден.');
    expect(screen.queryByText(/Loading project/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(projectApi.getProjectOverview).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });

  test('links only returned project epics and tasks with encoded IDs', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue({
      project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      epics: [{ id: 'epic/1', display_id: 'E-1', title: 'Encoded epic', status: 'READY' }],
      tasks: [{ id: 'task/1', epic_id: 'epic/1', display_id: 'T-1', title: 'Encoded task', status: 'READY', required: 1, eligibility: { status: 'RUNNABLE', reason: null } }],
      approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<MemoryRouter><ProjectPage id="project-1" /></MemoryRouter>);

    expect(await screen.findByText('Проект: Project One')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Encoded epic/ })).toHaveAttribute('href', '/epics/epic%2F1');
    expect(screen.getByRole('link', { name: /Encoded task/ })).toHaveAttribute('href', '/tasks/task%2F1');
    vi.restoreAllMocks();
  });
});

describe('Epic', () => {
  test('renders epic details', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      epic: { title: 'Epic', status: 'READY' }, contract: null,
      lifecycle: { status: 'READY', stage: null, updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<MemoryRouter><EpicPage id="1" /></MemoryRouter>);
    expect(await screen.findByText(/Эпик:/)).toBeInTheDocument();
    expect(screen.getByText(/Жизненный цикл эпика/)).toBeInTheDocument();
    expect(screen.getByText('Контракт эпика')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders actual epic review, architecture review, QA and merge stages', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      epic: { title: 'Release epic', status: 'IN_PROGRESS' }, contract: {},
      lifecycle: { status: 'IN_PROGRESS', stage: 'EPIC_QA', updatedAt: null, stages: [
        { id: 'EPIC_REVIEW', label: 'Epic Review', status: 'COMPLETED', updatedAt: null },
        { id: 'ARCHITECTURE_REVIEW', label: 'Architecture Review', status: 'COMPLETED', updatedAt: null },
        { id: 'EPIC_QA', label: 'Epic QA', status: 'CURRENT', updatedAt: null },
        { id: 'INTEGRATION', label: 'Merge', status: 'PENDING', updatedAt: null },
      ] }, git: { repositoryPath: '/repo', branch: 'epic/1', defaultBranch: 'master', github: null, worktreePath: null },
      tasks: [], approvals: [], blockers: [], events: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<EpicPage id="epic-1" />);
    await waitFor(() => expect(screen.getByText('Проверка эпика: Завершено')).toBeInTheDocument());
    expect(screen.getByText('Архитектурная проверка: Завершено')).toBeInTheDocument();
    expect(screen.getByText('Контроль качества эпика: Текущий этап')).toBeInTheDocument();
    expect(screen.getByText('Слияние: Ожидает')).toBeInTheDocument();
    expect(screen.getByText('Контроль качества эпика · 0 задач')).toBeInTheDocument();
    expect(screen.getByText('Проверка эпика: Завершено')).toHaveAttribute('data-status', 'COMPLETED');
    vi.restoreAllMocks();
  });

  test('renders explicit epic not-found and empty task state', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      epic: null, contract: null,
      lifecycle: { status: 'UNKNOWN', stage: null, updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<EpicPage id="missing/epic" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Эпик не найден.');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('links returned epic child tasks with encoded IDs', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      epic: { title: 'Linked epic', status: 'IN_PROGRESS' }, contract: {},
      lifecycle: { status: 'IN_PROGRESS', stage: 'EPIC_QA', updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      tasks: [{ id: 'task/1', display_id: 'T-1', title: 'Child task', status: 'READY', required: 1 }, { id: 'task-2', display_id: 'T-2', title: 'Second task', status: 'READY', required: 1 }],
      approvals: [], blockers: [], events: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<MemoryRouter><EpicPage id="epic-1" /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: /Child task/ })).toHaveAttribute('href', '/tasks/task%2F1');
    expect(screen.getByRole('link', { name: /Second task/ })).toHaveAttribute('href', '/tasks/task-2');
    expect(screen.getByText('Контроль качества эпика · 2 задач')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Child task' }).closest('li')).toHaveTextContent('Child task · Готово');
    expect(screen.getByRole('link', { name: 'Second task' }).closest('li')).toHaveTextContent('Second task · Готово');
    vi.restoreAllMocks();
  });

  test('localizes a lifecycle stage that is itself a status code', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      epic: { title: 'Active epic', status: 'IN_PROGRESS' }, contract: null,
      lifecycle: { status: 'IN_PROGRESS', stage: 'IN_PROGRESS', updatedAt: null, stages: [] },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<EpicPage id="epic-1" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Жизненный цикл эпика и граф параллельной работы' }).querySelector('p')).toHaveTextContent('Выполняется · 0 задач'));
    vi.restoreAllMocks();
  });

  test('refetches Epic and Task projections after SSE reconnect', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/epics/epic-1'
      ? { epic: { title: 'Epic', status: 'READY' }, contract: null, lifecycle: { status: 'READY', stage: null, updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, tasks: [], approvals: [], blockers: [], events: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 } }
      : { task: { title: 'Task', status: 'READY' }, contract: null, lifecycle: { status: 'READY', stage: 'READY', updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, scheduler: { status: 'RUNNABLE', reason: null } });
    render(<MemoryRouter><><EpicPage id="epic-1" /><TaskPage id="task-1" /></></MemoryRouter>);

    await waitFor(() => {
      expect(_get.mock.calls.filter(([path]) => path === '/epics/epic-1')).toHaveLength(1);
      expect(_get.mock.calls.filter(([path]) => path === '/tasks/task-1')).toHaveLength(1);
    });
    window.dispatchEvent(new CustomEvent('sse-reconnect'));
    await waitFor(() => {
      expect(_get.mock.calls.filter(([path]) => path === '/epics/epic-1')).toHaveLength(2);
      expect(_get.mock.calls.filter(([path]) => path === '/tasks/task-1')).toHaveLength(2);
    });
    vi.restoreAllMocks();
  });
});
