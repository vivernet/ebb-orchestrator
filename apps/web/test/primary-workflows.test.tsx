/// <reference types="node" />
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { ApiError, apiClient } from '../src/api/client.js';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import ProjectPage from '../src/features/projects/ProjectPage.js';
import EpicPage from '../src/features/epics/EpicPage.js';
import TaskPage from '../src/features/tasks/TaskPage.js';
import ProjectOnboardingPage from '../src/features/onboarding/ProjectOnboardingPage.js';

const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
const gitEmpty = { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null };

function projectOverview(overrides: Record<string, unknown> = {}) {
  return {
    project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' },
    git: gitEmpty,
    epics: [], tasks: [], approvals: [], blockers: [], events: [],
    usage,
    ...overrides,
  };
}

function epicOverview(overrides: Record<string, unknown> = {}) {
  return {
    epic: { id: 'epic-1', display_id: 'E-1', title: 'Epic', status: 'ACTIVE' },
    contract: null,
    lifecycle: { status: 'ACTIVE', stage: null, updatedAt: null },
    git: gitEmpty,
    tasks: [], approvals: [], blockers: [], events: [],
    usage,
    ...overrides,
  };
}

function taskOverview(overrides: Record<string, unknown> = {}) {
  return {
    task: { title: 'Task', status: 'READY', project_id: 'project-1', epic_id: 'epic-1' },
    contract: null,
    lifecycle: { status: 'READY', stage: 'READY', updatedAt: null },
    git: gitEmpty,
    runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
    usage,
    scheduler: { status: 'RUNNABLE', reason: null },
    ...overrides,
  };
}

describe('Primary workflows — реальные действия экранов через typed API', () => {
  test('Dashboard ведёт на создание запроса через route builder и сохраняет независимые секции', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/dashboard') {
        return {
          activeAgents: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
          activeWork: [{ id: 'task-1', title: 'Активная задача', status: 'DEV', eligibility: { status: 'RUNNABLE', reason: null } }],
          approvals: 2,
          usage: { inputTokens: 10, cachedTokens: 2, outputTokens: 3, totalTokens: 15, cost: 0.42 },
          projects: [{ id: 'project-1', name: 'Project', displayName: 'Project One', status: 'ACTIVE' }],
        };
      }
      if (path === '/execution') {
        return {
          running: [{ runId: 'run-2', role: 'QA', taskId: 'task-2', status: 'IN_PROGRESS' }],
          waiting: [{ taskId: 'task-3', reason: { code: 'WAITING_FOR_CAPACITY', message: '' } }],
          blocked: [], capacity: { configured: 4, used: 1 }, locks: [], recentEvents: [],
          dispatchState: { paused: false, updatedAt: null },
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    const requestLink = await screen.findByRole('link', { name: 'Новый запрос' });
    expect(requestLink).toHaveAttribute('href', '/projects/new');
    expect(screen.getByRole('link', { name: /Project One/ })).toHaveAttribute('href', '/projects/project-1');
    expect(screen.getByRole('link', { name: /Активная задача/ })).toHaveAttribute('href', '/tasks/task-1');
    expect(screen.getByRole('link', { name: /Developer/ })).toHaveAttribute('href', '/runs/run-1');
    expect(screen.getByRole('region', { name: 'Центр согласований' })).toHaveTextContent('2');
  });

  test('Project: scoped pause/resume вызывает typed маршруты и подтверждает состояние refetch-ом', async () => {
    let projectStatus = 'ACTIVE';
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/projects/project-1') {
        return projectOverview({ project: { id: 'project-1', name: 'Project', displayName: 'Project One', status: projectStatus } });
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/projects/project-1/pause') {
        projectStatus = 'PAUSED';
        return { projectId: 'project-1', state: 'PAUSED', updatedAt: '2026-10-24T00:00:00.000Z' };
      }
      if (path === '/projects/project-1/resume') {
        projectStatus = 'ACTIVE';
        return { projectId: 'project-1', state: 'ACTIVE', updatedAt: '2026-10-24T00:00:00.000Z' };
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><ProjectPage id="project-1" /></MemoryRouter>);

    const overviewCalls = () => get.mock.calls.filter(([path]) => path === '/projects/project-1').length;

    const pause = await screen.findByRole('button', { name: 'Приостановить проект' });
    fireEvent.click(pause);
    await screen.findByRole('button', { name: 'Возобновить проект' });
    expect(post).toHaveBeenCalledWith('/projects/project-1/pause');
    await waitFor(() => expect(overviewCalls()).toBeGreaterThanOrEqual(2));

    fireEvent.click(screen.getByRole('button', { name: 'Возобновить проект' }));
    await screen.findByRole('button', { name: 'Приостановить проект' });
    expect(post).toHaveBeenCalledWith('/projects/project-1/resume');
  });

  test('Project: блокировки и согласования показаны отдельными панелями с пустыми состояниями', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/projects/project-1') {
        return projectOverview({
          blockers: [{ id: 'blocker-1', status: 'BLOCKED', reason: 'Не хватает ревью' }],
          approvals: [{ id: 'approval-1', type: 'FINAL_MERGE', status: 'PENDING', createdAt: '2026-10-24T00:00:00.000Z' }],
        });
      }
      throw new Error(`Unexpected GET ${path}`);
    });

    render(<MemoryRouter><ProjectPage id="project-1" /></MemoryRouter>);

    expect(await screen.findByRole('region', { name: 'Блокировки' })).toHaveTextContent('Не хватает ревью');
    expect(screen.getByRole('region', { name: 'Согласования' })).toHaveTextContent('Финальное слияние');
    const gitRegion = screen.getByRole('region', { name: 'Репозиторий и GitHub' });
    expect(within(gitRegion).getByRole('button', { name: 'Синхронизировать сейчас' })).toBeInTheDocument();
    expect(gitRegion).not.toHaveTextContent(/контракт не предоставляет такого действия/);
  });

  test('Project: синхронизация GitHub вызывает typed маршрут sync и обновляет страницу', async () => {
    let overviewCalls = 0;
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/projects/project-1') {
        overviewCalls += 1;
        return projectOverview();
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/projects/project-1/github/sync') {
        return { status: 'SYNCED' };
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><ProjectPage id="project-1" /></MemoryRouter>);

    const gitRegion = await screen.findByRole('region', { name: 'Репозиторий и GitHub' });
    const syncButton = await within(gitRegion).findByRole('button', { name: 'Синхронизировать сейчас' });
    fireEvent.click(syncButton);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/project-1/github/sync'));
    await waitFor(() => expect(overviewCalls).toBeGreaterThanOrEqual(2));
  });

  test('Project: недоступность GitHub-синхронизации показывается ошибкой', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(projectOverview());
    vi.spyOn(apiClient, 'post').mockRejectedValue(new ApiError('GitHub sync is unavailable', 503));

    render(<MemoryRouter><ProjectPage id="project-1" /></MemoryRouter>);

    const gitRegion = await screen.findByRole('region', { name: 'Репозиторий и GitHub' });
    const syncButton = await within(gitRegion).findByRole('button', { name: 'Синхронизировать сейчас' });
    fireEvent.click(syncButton);
    expect(await within(gitRegion).findByText(/Синхронизация с GitHub недоступна/)).toBeInTheDocument();
  });

  test('Epic: перепланирование и scoped pause/resume идут через typed маршруты', async () => {
    let epicStatus = 'ACTIVE';
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/epics/epic-1') {
        return epicOverview({ epic: { id: 'epic-1', display_id: 'E-1', title: 'Epic', status: epicStatus } });
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/epics/epic-1/pause') {
        epicStatus = 'PAUSED';
        return { epicId: 'epic-1', state: 'PAUSED', updatedAt: '2026-10-24T00:00:00.000Z' };
      }
      if (path === '/epics/epic-1/resume') {
        epicStatus = 'ACTIVE';
        return { epicId: 'epic-1', state: 'ACTIVE', updatedAt: '2026-10-24T00:00:00.000Z' };
      }
      if (path === '/epics/epic-1/replan') {
        return { epicId: 'epic-1', requestId: 'req-1', status: 'PLANNING', createdAt: '2026-10-24T00:00:00.000Z' };
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><EpicPage id="epic-1" /></MemoryRouter>);

    const replan = await screen.findByRole('button', { name: 'Перепланировать' });
    fireEvent.click(replan);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/epics/epic-1/replan', {}));
    expect(get).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Приостановить эпик' }));
    await screen.findByRole('button', { name: 'Возобновить эпик' });
    expect(post).toHaveBeenCalledWith('/epics/epic-1/pause');
  });

  test('Task: возобновление приостановленной задачи вызывает typed маршрут resume', async () => {
    let getCalls = 0;
    const _get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/tasks/task-1') {
        getCalls += 1;
        return taskOverview({
          task: { title: 'Paused task', status: 'PAUSED', project_id: 'project-1', epic_id: 'epic-1' },
          lifecycle: { status: 'PAUSED', stage: 'PAUSED', updatedAt: null },
          scheduler: { status: 'WAIT', reason: { code: 'WAITING_FOR_PAUSE', message: 'paused' } },
        });
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/tasks/task-1/resume') {
        return { taskId: 'task-1', state: 'READY', priorStage: 'DEV', updatedAt: '2026-10-24T00:00:00.000Z' };
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><TaskPage id="task-1" /></MemoryRouter>);

    const resume = await screen.findByRole('button', { name: 'Возобновить задачу' });
    fireEvent.click(resume);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/task-1/resume'));
    await waitFor(() => expect(getCalls).toBe(2));
  });

  test('Task: пауза активной задачи вызывает typed маршрут pause', async () => {
    let getCalls = 0;
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/tasks/task-1') {
        getCalls += 1;
        return taskOverview();
      }
      throw new Error(`Unexpected GET ${path}`);
    });
    const post = vi.spyOn(apiClient, 'post').mockImplementation(async (path) => {
      if (path === '/tasks/task-1/pause') {
        return { taskId: 'task-1', state: 'PAUSED', priorStage: 'READY', updatedAt: '2026-10-24T00:00:00.000Z' };
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    render(<MemoryRouter><TaskPage id="task-1" /></MemoryRouter>);

    const pause = await screen.findByRole('button', { name: 'Приостановить задачу' });
    fireEvent.click(pause);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/task-1/pause'));
    await waitFor(() => expect(getCalls).toBe(2));
  });

  test('Task: недоступность паузы показывается ошибкой без потери контролов', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(taskOverview());
    vi.spyOn(apiClient, 'post').mockRejectedValue(new ApiError('work service unavailable', 503));

    render(<MemoryRouter><TaskPage id="task-1" /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить задачу' }));
    expect(await screen.findByText(/Не удалось изменить задачу/)).toBeInTheDocument();
  });

  test('Task: изменение приоритета уходит на typed маршрут с числовым body', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(taskOverview());
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({
      taskId: 'task-1', priority: 75, updatedAt: '2026-10-24T00:00:00.000Z',
    });

    render(<MemoryRouter><TaskPage id="task-1" /></MemoryRouter>);

    const priorityInput = await screen.findByLabelText('Приоритет задачи');
    fireEvent.change(priorityInput, { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить приоритет' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/task-1/priority', { priority: 75 }));
  });

  test('Task: работачее дерево отображается безопасным текстом и никогда не становится HTML-ссылкой', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(taskOverview({
      git: { repositoryPath: '/repo', branch: 'task/425', defaultBranch: 'main', github: null, worktreePath: '/safe/worktree/task-425' },
    }));

    render(<MemoryRouter><TaskPage id="task-1" /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('tab', { name: 'Git' }));
    const gitRegion = screen.getByRole('region', { name: 'Git' });
    expect(gitRegion).toHaveTextContent('/safe/worktree/task-425');
    const codeEl = within(gitRegion).getByText('/safe/worktree/task-425');
    expect(codeEl.tagName.toLowerCase()).toBe('code');
    expect(gitRegion.querySelector('a[href*="worktree"]')).toBeNull();
    expect(gitRegion.querySelector('a[href*="file:"]')).toBeNull();
  });

  test('Task: INVALID_RESPONSE с кодом 0 локализуется и не попадает в обработку истечения сессии', async () => {
    const onReconnect = vi.fn();
    window.addEventListener('sse-reconnect', onReconnect);
    vi.spyOn(apiClient, 'get').mockRejectedValue(new ApiError('contract mismatch', 0, 'INVALID_RESPONSE'));

    render(<MemoryRouter><TaskPage id="task-1" /></MemoryRouter>);

    expect(await screen.findByText(/Ответ сервера не соответствует контракту\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    await waitFor(() => expect(onReconnect).not.toHaveBeenCalled());
    window.removeEventListener('sse-reconnect', onReconnect);
  });

  test('ProjectOnboardingPage использует route builder и типизированный адаптер, а не строку endpoint', () => {
    const source = readFileSync('src/features/onboarding/ProjectOnboardingPage.tsx', 'utf8');
    expect(source).not.toMatch(/`\/onboarding\//);
    expect(source).toMatch(/onboardingApi|apiPaths\.onboarding/);
    expect(source).not.toMatch(/\$\{encodeURIComponent\(id\)\}/);
  });

  test('ProjectOnboardingPage отделяет обнаруженные факты от предложений и не выдумывает активацию', async () => {
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

    expect(await screen.findByRole('heading', { name: 'Обнаружено' })).toBeInTheDocument();
    expect(screen.getByText(/Менеджер пакетов: pnpm/)).toBeInTheDocument();
    expect(screen.getByText(/Рабочий процесс: standard/)).toBeInTheDocument();
    expect(screen.getByText(/Роли: Developer, Reviewer, QA/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activate|Активировать/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Активация проекта недоступна/)).toBeInTheDocument();
  });
});
