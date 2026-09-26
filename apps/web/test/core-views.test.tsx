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
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/dashboard'
      ? { activeAgents: [], activeWork: [{ id: 'task-1', title: 'Blocked work', status: 'BLOCKED', eligibility: { status: 'BLOCK', reason: { code: 'PROJECT_NOT_ACTIVE', message: 'Secret backend detail' } } }], approvals: 0, usage: { totalTokens: 0, cost: 0 }, projects: [] }
      : { running: [], waiting: [{ taskId: 'task-2', reason: { code: 'WAITING_FOR_RESOURCE_LOCK', message: 'Secret backend detail' } }], blocked: [{ taskId: 'task-3', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'Secret backend detail' } }] });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: /Blocked work/ })).toHaveTextContent('Проект не активен.');
    expect(screen.getByRole('region', { name: 'Очередь' })).toHaveTextContent('Ожидается освобождение ресурса.');
    expect(screen.getByRole('region', { name: 'Очередь' })).toHaveTextContent('Заблокировано рабочим процессом.');
    expect(screen.queryByText(/Secret backend detail/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
  test('renders values from the dashboard projection', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/dashboard'
      ? { activeAgents: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }], activeWork: [{ id: 'task-1', title: 'Ship projection', status: 'DEV', eligibility: { status: 'RUNNABLE', reason: null } }], approvals: 2, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 2, cost: 0.42 }, projects: [{ id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' }] }
      : { running: [], waiting: [], blocked: [] });
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
    const _get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/dashboard'
      ? { activeAgents: [{ runId: 'run/1', role: 'Developer', taskId: 'task/1', status: 'IN_PROGRESS' }], activeWork: [{ id: 'task/1', title: 'Encoded task', status: 'DEV', eligibility: { status: 'RUNNABLE', reason: null } }], approvals: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, projects: [{ id: 'project/1', name: 'Project', displayName: 'Encoded project', status: 'ACTIVE' }] }
      : { running: [], waiting: [], blocked: [] });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('link', { name: /Encoded task/ })).toHaveAttribute('href', '/tasks/task%2F1'));
    expect(screen.getByRole('link', { name: /Developer · Выполняется/ })).toHaveAttribute('href', '/runs/run%2F1');
    expect(screen.getByRole('link', { name: /Encoded project/ })).toHaveAttribute('href', '/projects/project%2F1');
    vi.restoreAllMocks();
  });

  test('keeps dashboard projection and queue failures independent', async () => {
    vi.spyOn(dashboardApi, 'getDashboard').mockRejectedValue(new Error('dashboard unavailable'));
    vi.spyOn(dashboardApi, 'getExecutionQueue').mockResolvedValue({ running: [], waiting: [], blocked: [] });
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить обзор: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.getByText('Очередь пуста.')).toBeInTheDocument();
    expect(screen.queryByText('Не удалось загрузить очередь:')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('refetches dashboard and execution projections after SSE reconnect', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) =>
      path === '/dashboard'
        ? { activeAgents: [], activeWork: [], approvals: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, projects: [] }
        : { running: [], waiting: [], blocked: [] }
    );
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    await waitFor(() => {
      expect(_get.mock.calls.filter(([path]) => path === '/dashboard')).toHaveLength(1);
      expect(_get.mock.calls.filter(([path]) => path === '/execution')).toHaveLength(1);
    });
    window.dispatchEvent(new CustomEvent('sse-reconnect'));

    await waitFor(() => {
      expect(_get.mock.calls.filter(([path]) => path === '/dashboard')).toHaveLength(2);
      expect(_get.mock.calls.filter(([path]) => path === '/execution')).toHaveLength(2);
    });
    vi.restoreAllMocks();
  });

  test('exposes Running agents section', () => {
    renderDashboard();
    expect(screen.getByText(/Работающие агенты/i)).toBeInTheDocument();
  });

  test('exposes Active work section', () => {
    renderDashboard();
    expect(screen.getByText(/Активная работа/i)).toBeInTheDocument();
  });

  test('exposes Need approval section', () => {
    renderDashboard();
    expect(screen.getByText(/Требуют согласования/i)).toBeInTheDocument();
  });

  test('exposes AI spend section', () => {
    renderDashboard();
    expect(screen.getByText(/Расходы на ИИ/i)).toBeInTheDocument();
  });

  test('exposes active projects section', () => {
    renderDashboard();
    expect(screen.getByText('Активные проекты')).toBeInTheDocument();
  });

  test('exposes queue section', () => {
    renderDashboard();
    expect(screen.getByText('Очередь')).toBeInTheDocument();
  });

  test('does not expose an unsupported Coordinator Chat entry', () => {
    renderDashboard();
    expect(screen.queryByRole('heading', { name: 'Coordinator Chat' })).not.toBeInTheDocument();
    expect(screen.queryByText(/submit a request for project work/i)).not.toBeInTheDocument();
  });

  test('exposes the approved dashboard operations', () => {
    renderDashboard();
    expect(screen.getByText('Сводка согласований')).toBeInTheDocument();
    expect(screen.getByText('Пул агентов')).toBeInTheDocument();
    expect(screen.queryByText('Coordinator Chat')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Request' })).not.toBeInTheDocument();
  });
});

describe('Task', () => {
  test('renders the persisted current and completed lifecycle states', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      task: { title: 'Released task', status: 'DONE' }, contract: {},
      lifecycle: { status: 'DONE', stage: 'DONE', updatedAt: '2026-09-16T00:00:00Z' },
      git: { repositoryPath: '/repo', branch: 'task/1', defaultBranch: 'master', github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, scheduler: { status: 'RUNNABLE', reason: null },
    });
    render(<TaskPage id="task-1" />);
    await waitFor(() => expect(screen.getByText('Статус: Завершено')).toBeInTheDocument());
    expect(screen.getByText('Разработка')).toBeInTheDocument();
    expect(screen.getByText('Завершено')).toHaveStyle({ color: '#fff', fontWeight: '600' });
    expect(screen.getByText('Выпущено')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders waiting and failure/cancellation statuses as timeline states', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      task: { title: 'Blocked task', status: 'FAILED' }, contract: {},
      lifecycle: { status: 'FAILED', stage: 'FAILED', updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, scheduler: { status: 'WAIT', reason: { code: 'WAITING_FOR_DEPENDENCY', message: 'Waiting for dependency' } },
    });
    render(<TaskPage id="task-2" />);
    await waitFor(() => expect(screen.getByText('Статус: Ошибка')).toBeInTheDocument());
    expect(screen.getByText('Ожидает зависимости')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Восстановление' })).toHaveTextContent('Ожидается выполнение зависимости.');
    expect(screen.getByText('Отменено')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders explicit task not-found and empty subordinate states', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      task: null, contract: null,
      lifecycle: { status: 'UNKNOWN', stage: null, updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, scheduler: { status: 'BLOCK', reason: { code: 'ONBOARDING_NOT_ACTIVE', message: 'Онбординг проекта не активирован' } },
    });
    render(<TaskPage id="missing/task" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Задача не найдена.');
    expect(screen.getByText('Запуски агента недоступны.')).toBeInTheDocument();
    expect(screen.getByText('Результаты проверки недоступны.')).toBeInTheDocument();
    expect(_get).toHaveBeenCalledWith('/tasks/missing%2Ftask', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('links only present task run, project, epic, and dependency IDs with encoding', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      task: { title: 'Linked task', status: 'READY', project_id: 'project/1', epic_id: 'epic/1' }, contract: {},
      lifecycle: { status: 'READY', stage: 'READY', updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      runs: [{ id: 'run/1', role: 'Developer', status: 'IN_PROGRESS' }], findings: [], defects: [],
      dependencies: [{ id: 'dependency-1', taskId: 'task/1', dependsOnTaskId: 'dependency/task/1', type: 'BLOCKS', status: 'READY' }],
      approvals: [], events: [], usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, scheduler: { status: 'RUNNABLE', reason: null },
    });
    render(<MemoryRouter><TaskPage id="task/1" /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: /Developer · Выполняется/ })).toHaveAttribute('href', '/runs/run%2F1');
    expect(screen.getByRole('link', { name: /Проект/ })).toHaveAttribute('href', '/projects/project%2F1');
    expect(screen.getByRole('link', { name: /Эпик/ })).toHaveAttribute('href', '/epics/epic%2F1');
    expect(screen.getAllByRole('link', { name: /task\/1/ }).find((link) => link.getAttribute('href') === '/tasks/task%2F1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /dependency\/task\/1/ })).toHaveAttribute('href', '/tasks/dependency%2Ftask%2F1');
    vi.restoreAllMocks();
  });

  test('exposes contract section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Контракт')).toBeInTheDocument();
  });

  test('exposes workflow section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Рабочий процесс')).toBeInTheDocument();
  });

  test('exposes Agent Runs section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Запуски агента')).toBeInTheDocument();
  });

  test('exposes findings/defects section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Результаты проверки')).toBeInTheDocument();
  });

  test('exposes Git state section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Git')).toBeInTheDocument();
  });

  test('exposes recovery section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Восстановление')).toBeInTheDocument();
  });

  test('exposes usage section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Использование')).toBeInTheDocument();
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

  test('renders project details', () => {
    render(<ProjectPage id="1" />);
    expect(screen.getByText(/Проект:/)).toBeInTheDocument();
    expect(screen.getByText(/Репозиторий \/ путь \/ ветка \/ GitHub/)).toBeInTheDocument();
    expect(screen.queryByText(/Runs · Git · Guidelines · Usage/)).not.toBeInTheDocument();
  });

  test('renders explicit project not-found state when projection has no project', async () => {
    const _get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      project: null, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      epics: [], tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<ProjectPage id="missing/project" />);

    const notFoundAlert = await screen.findByRole('alert');
    expect(notFoundAlert).toHaveTextContent('Проект не найден.');
    expect(screen.queryByText(/Loading project/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(_get).toHaveBeenCalledTimes(2));
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

    expect(await screen.findByText('Активно · Project')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Encoded epic/ })).toHaveAttribute('href', '/epics/epic%2F1');
    expect(screen.getByRole('link', { name: /Encoded task/ })).toHaveAttribute('href', '/tasks/task%2F1');
    vi.restoreAllMocks();
  });
});

describe('Epic', () => {
  test('renders epic details', () => {
    render(<EpicPage id="1" />);
    expect(screen.getByText(/Эпик:/)).toBeInTheDocument();
    expect(screen.getByText(/Жизненный цикл \/ граф параллельной работы/)).toBeInTheDocument();
    expect(screen.getByText('Контракт эпика')).toBeInTheDocument();
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
    expect(screen.getByText('Задачи недоступны.')).toBeInTheDocument();
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
