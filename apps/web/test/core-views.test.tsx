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

const emptyQueue = { running: [], waiting: [], blocked: [], capacity: { configured: 4, used: 0 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null } };
const emptyUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };

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
  test('renders queue and metric values from typed projections without backend messages', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({
      activeAgents: [], activeWork: [{ id: 'task-1', title: 'Blocked work', status: 'BLOCKED', eligibility: { status: 'BLOCK', reason: { code: 'PROJECT_NOT_ACTIVE', message: 'Secret backend detail' } } }],
      approvals: 0, usage: emptyUsage, projects: [],
    });
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue({
      running: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
      waiting: [{ taskId: 'task-2', reason: { code: 'WAITING_FOR_RESOURCE_LOCK', message: 'Secret backend detail' } }],
      blocked: [{ taskId: 'task-3', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'Secret backend detail' } }],
      capacity: { configured: 4, used: 1 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null },
    });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Панель управления' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Очередь выполнения' })).toHaveTextContent('Developer');
    expect(screen.getByRole('region', { name: 'Очередь выполнения' })).toHaveTextContent('task-2');
    expect(screen.queryByText(/Secret backend detail/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Активные проекты' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Центр согласований' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Пул агентов' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Координатор' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders metric values from the dashboard projection', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({
      activeAgents: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
      activeWork: [{ id: 'task-1', title: 'Ship projection', status: 'DEV', eligibility: { status: 'RUNNABLE', reason: null } }],
      approvals: 2, usage: emptyUsage,
      projects: [{ id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' }],
    });
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue(emptyQueue);
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    const metrics = await screen.findByRole('region', { name: 'Ключевые показатели' });
    expect(metrics).toHaveTextContent('1');
    expect(metrics).toHaveTextContent('2');
    expect(screen.getByRole('region', { name: 'Активные проекты' })).toHaveTextContent('1 проекта');
    vi.restoreAllMocks();
  });

  test('keeps dashboard projection and queue failures independent', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockRejectedValue(new Error('dashboard unavailable'));
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue(emptyQueue);
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить проекты: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Очередь выполнения' })).toBeInTheDocument();
    expect(screen.queryByText('Не удалось загрузить очередь:')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('refetches dashboard and execution projections after SSE reconnect', async () => {
    const dashboard = vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({
      activeAgents: [], activeWork: [], approvals: 0, usage: emptyUsage, projects: [],
    });
    const execution = vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue(emptyQueue);
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

  test('exposes the approved dashboard operations with localized labels', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({ activeAgents: [], activeWork: [], approvals: 0, usage: emptyUsage, projects: [] });
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue(emptyQueue);
    renderDashboard();

    expect(await screen.findByRole('button', { name: 'Приостановить всё' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Новый запрос' })).toHaveAttribute('href', '/projects/new');
    expect(screen.queryByRole('button', { name: 'Pause All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New Request' })).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('pause-all dispatches the typed scheduler dispatch-state command', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockResolvedValue({ activeAgents: [], activeWork: [], approvals: 0, usage: emptyUsage, projects: [] });
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue(emptyQueue);
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue({ paused: true, updatedAt: null });
    renderDashboard();

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить всё' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/scheduler/dispatch-state', { paused: true }));
    vi.restoreAllMocks();
  });
});

describe('Task', () => {
  function defaultTaskProjection(overrides: Record<string, unknown> = {}) {
    return {
      task: { title: 'Task', status: 'READY', project_id: 'p', epic_id: null }, contract: {},
      lifecycle: { status: 'READY', stage: 'READY', updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: emptyUsage,
      scheduler: { status: 'RUNNABLE', reason: null },
      ...overrides,
    };
  }

  const renderTask = (id = 'task-1') => render(<MemoryRouter><TaskPage id={id} /></MemoryRouter>);

  test('renders the persisted current and completed lifecycle states', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Released task', status: 'DONE', project_id: null, epic_id: null },
      lifecycle: { status: 'DONE', stage: 'DONE', updatedAt: '2026-09-16T00:00:00Z' },
      runs: [{ id: 'run-1', role: 'Developer', status: 'COMPLETED' }],
    }));
    renderTask('task-1');
    await waitFor(() => expect(screen.getByText('DONE')).toBeInTheDocument());
    expect(screen.getByText('завершён')).toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/tasks/task-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('renders waiting and failure/cancellation statuses without backend messages', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Blocked task', status: 'FAILED', project_id: null, epic_id: null },
      lifecycle: { status: 'FAILED', stage: 'FAILED', updatedAt: null },
      scheduler: { status: 'BLOCK', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'Waiting for dependency' } },
    }));
    renderTask('task-2');
    await waitFor(() => expect(screen.getByText('FAILED')).toBeInTheDocument());
    expect(screen.getByText('Да')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for dependency')).not.toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/tasks/task-2', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('renders a paused task with the resume control', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Paused task', status: 'PAUSED', project_id: null, epic_id: null },
      lifecycle: { status: 'PAUSED', stage: 'PAUSED', updatedAt: null },
      scheduler: { status: 'WAIT', reason: { code: 'WAITING_FOR_PAUSE', message: 'Task is paused' } },
    }));
    renderTask('paused-task');
    expect(await screen.findByRole('button', { name: 'Возобновить задачу' })).toBeInTheDocument();
    expect(screen.queryByText('Task is paused')).not.toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/tasks/paused-task', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('renders explicit task not-found state', async () => {
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

  test('links run IDs with encoding and does not fabricate project/epic/dependency links', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection({
      task: { title: 'Linked task', status: 'READY', project_id: 'project/1', epic_id: 'epic/1' },
      runs: [{ id: 'run/1', role: 'Developer', status: 'IN_PROGRESS' }],
      dependencies: [{ id: 'dependency-1', taskId: 'task/1', dependsOnTaskId: 'dependency/task/1', type: 'BLOCKS', status: 'READY' }],
    }));
    renderTask('task/1');

    expect(await screen.findByRole('link', { name: /смотреть запуск/ })).toHaveAttribute('href', '/runs/run%2F1');
    expect(screen.queryByRole('link', { name: /Проект|Эпик/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /dependency/ })).not.toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/tasks/task%2F1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('exposes reference tabs and sections', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultTaskProjection());
    renderTask();
    expect(await screen.findByRole('tab', { name: 'Контракт' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Запуски' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Git' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Использование' })).toBeInTheDocument();
    expect(screen.getByText('Процесс задачи')).toBeInTheDocument();
    expect(screen.getAllByText('Восстановление').length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });
});

describe('Project', () => {
  function defaultProject(overrides: Record<string, unknown> = {}) {
    return {
      project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' },
      git: { repositoryPath: '/repo', branch: null, defaultBranch: 'main', github: { status: 'CONNECTED', url: null }, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: emptyUsage,
      ...overrides,
    };
  }

  const renderProject = (id = 'project-1') => render(<MemoryRouter><ProjectPage id={id} /></MemoryRouter>);

  test('renders GitHub connection as a safe Russian status', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue(defaultProject());
    renderProject();
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
    await waitFor(() => expect(_get.mock.calls.filter(([path]) => path.includes(`/${id}`)).length).toBeGreaterThanOrEqual(2));
    vi.restoreAllMocks();
  });

  test('renders project details from the reference structure', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue(defaultProject());
    renderProject();
    expect(await screen.findByRole('heading', { name: 'Project One' })).toBeInTheDocument();
    expect(screen.getByText(/\/repo/)).toBeInTheDocument();
    expect(screen.queryByText(/Runs · Git · Guidelines · Usage/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders populated project activity without exposing event payload', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue(defaultProject({
      events: [{ id: 'event-1', type: 'TASK_CREATED', createdAt: '2026-09-28T10:30:00.000Z', payload: { secret: 'must-not-render' } }],
    }));
    renderProject();

    expect(await screen.findByRole('heading', { name: 'Project One' })).toBeInTheDocument();
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('TASK_CREATED')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('loads the project matching the current route ID after navigation', async () => {
    const getProjectOverview = vi.spyOn(projectApi, 'getProjectOverview').mockImplementation(async (id) => ({
      project: { id, name: id, displayName: `Project ${id}`, status: 'ACTIVE' },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: emptyUsage,
    }));
    const view = render(<MemoryRouter><ProjectPage id="route-project-a" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Project route-project-a' })).toBeInTheDocument();
    view.rerender(<MemoryRouter><ProjectPage id="route-project-b" /></MemoryRouter>);

    await waitFor(() => expect(getProjectOverview).toHaveBeenLastCalledWith('route-project-b'));
    expect(await screen.findByRole('heading', { name: 'Project route-project-b' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders explicit project not-found state when projection has no project', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue(defaultProject({ project: null, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null } }));
    render(<ProjectPage id="missing/project" />);

    const notFoundAlert = await screen.findByRole('alert');
    expect(notFoundAlert).toHaveTextContent('Проект не найден.');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(projectApi.getProjectOverview).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });

  test('links returned project tasks with encoded IDs', async () => {
    vi.spyOn(projectApi, 'getProjectOverview').mockResolvedValue(defaultProject({
      epics: [{ id: 'epic/1', display_id: 'E-1', title: 'Encoded epic', status: 'READY' }],
      tasks: [{ id: 'task/1', epic_id: 'epic/1', display_id: 'T-1', title: 'Encoded task', status: 'READY', required: 1, eligibility: { status: 'RUNNABLE', reason: null } }],
    }));
    renderProject();

    expect(await screen.findByRole('link', { name: /Encoded task/ })).toHaveAttribute('href', '/tasks/task%2F1');
    expect(screen.queryByRole('link', { name: /Encoded epic/ })).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('Epic', () => {
  function defaultEpic(overrides: Record<string, unknown> = {}) {
    return {
      epic: { id: 'epic-1', title: 'Epic', status: 'READY', project_id: 'p' }, contract: null,
      lifecycle: { status: 'READY', stage: null, updatedAt: null, stages: [] },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      tasks: [], approvals: [], blockers: [], events: [],
      usage: emptyUsage,
      ...overrides,
    };
  }

  const renderEpic = (id = 'epic-1') => render(<MemoryRouter><EpicPage id={id} /></MemoryRouter>);

  test('renders epic details', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultEpic());
    renderEpic();
    expect(await screen.findByRole('heading', { name: /Epic/ })).toBeInTheDocument();
    expect(screen.getByText('Жизненный цикл эпика')).toBeInTheDocument();
    expect(screen.getByText('Контракт эпика')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders actual epic review, architecture review, QA and merge stages', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultEpic({
      epic: { id: 'epic-1', title: 'Release epic', status: 'IN_PROGRESS', project_id: 'p' },
      contract: {},
      lifecycle: { status: 'IN_PROGRESS', stage: 'EPIC_QA', updatedAt: null, stages: [
        { id: 'EPIC_REVIEW', label: 'Epic Review', status: 'COMPLETED', updatedAt: null },
        { id: 'ARCHITECTURE_REVIEW', label: 'Architecture Review', status: 'COMPLETED', updatedAt: null },
        { id: 'EPIC_QA', label: 'Epic QA', status: 'CURRENT', updatedAt: null },
        { id: 'INTEGRATION', label: 'Merge', status: 'PENDING', updatedAt: null },
      ] },
      git: { repositoryPath: '/repo', branch: 'epic/1', defaultBranch: 'master', github: null, worktreePath: null },
    }));
    renderEpic('epic-1');
    await waitFor(() => expect(screen.getByText('Проверка эпика')).toBeInTheDocument());
    expect(screen.getByText('Архитектурная проверка')).toBeInTheDocument();
    expect(screen.getByText('Контроль качества эпика')).toBeInTheDocument();
    expect(screen.getByText('Слияние')).toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/epics/epic-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('renders explicit epic not-found state', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue(defaultEpic({ epic: null, contract: null }));
    render(<EpicPage id="missing/epic" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Эпик не найден.');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/epics/missing%2Fepic', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('localizes a lifecycle stage that is itself a status code', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(defaultEpic({
      lifecycle: { status: 'IN_PROGRESS', stage: 'IN_PROGRESS', updatedAt: null, stages: [{ id: 'IN_PROGRESS', label: 'IN_PROGRESS', status: 'PENDING', updatedAt: null }] },
    }));
    renderEpic();
    await waitFor(() => expect(screen.getByText('Выполняется')).toBeInTheDocument());
    vi.restoreAllMocks();
  });

  test('refetches Epic and Task projections after SSE reconnect', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/epics/epic-1'
      ? defaultEpic()
      : { task: { title: 'Task', status: 'READY' }, contract: null, lifecycle: { status: 'READY', stage: 'READY', updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [], usage: emptyUsage, scheduler: { status: 'RUNNABLE', reason: null } });
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
