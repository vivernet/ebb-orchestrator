import { describe, test, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import ProjectPage from '../src/features/projects/ProjectPage.js';
import EpicPage from '../src/features/epics/EpicPage.js';
import TaskPage from '../src/features/tasks/TaskPage.js';
import { apiClient } from '../src/api/client.js';
import WorkflowTimeline, { displayStageForLifecycle } from '../src/components/WorkflowTimeline.js';

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

    expect(screen.getByText(status)).toHaveStyle({ color: '#fff', fontWeight: '600' });
    expect(screen.getByText('DEV')).not.toHaveStyle({ color: '#888' });
    expect(screen.getByText('REVIEW')).not.toHaveStyle({ color: '#888' });
    expect(screen.getByText('QA')).not.toHaveStyle({ color: '#888' });
  });
});

describe('Dashboard', () => {
  test('renders values from the dashboard projection', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/dashboard'
      ? { activeAgents: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }], activeWork: [{ id: 'task-1', title: 'Ship projection', status: 'DEV', waitReason: null }], approvals: 2, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 2, totalTokens: 3, cost: 0.42 }, projects: [] }
      : { running: [], waiting: [], blocked: [] });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Ship projection/)).toBeInTheDocument());
    expect(screen.getByText(/Developer · IN_PROGRESS/)).toBeInTheDocument();
    expect(screen.getByText(/\$0.42/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes Running agents section', () => {
    render(<DashboardPage />);
    expect(screen.getByText(/Running agents/i)).toBeInTheDocument();
  });

  test('exposes Active work section', () => {
    render(<DashboardPage />);
    expect(screen.getByText(/Active work/i)).toBeInTheDocument();
  });

  test('exposes Need approval section', () => {
    render(<DashboardPage />);
    expect(screen.getByText(/Need approval/i)).toBeInTheDocument();
  });

  test('exposes AI spend section', () => {
    render(<DashboardPage />);
    expect(screen.getByText(/AI spend/i)).toBeInTheDocument();
  });

  test('exposes active projects section', () => {
    render(<DashboardPage />);
    expect(screen.getByText('Active projects')).toBeInTheDocument();
  });

  test('exposes queue section', () => {
    render(<DashboardPage />);
    expect(screen.getByText('Queue')).toBeInTheDocument();
  });

  test('exposes Coordinator entry', () => {
    render(<DashboardPage />);
    expect(screen.getByText('Coordinator')).toBeInTheDocument();
  });

  test('exposes the approved dashboard operations', () => {
    render(<DashboardPage />);
    expect(screen.getByText('Approval Inbox summary')).toBeInTheDocument();
    expect(screen.getByText('Agent Pool')).toBeInTheDocument();
    expect(screen.getByText('Coordinator Chat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New Request' })).not.toBeInTheDocument();
  });
});

describe('Task', () => {
  test('renders the persisted current and completed lifecycle states', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      task: { title: 'Released task', status: 'DONE' }, contract: {},
      lifecycle: { status: 'DONE', stage: 'DONE', updatedAt: '2026-09-16T00:00:00Z' },
      git: { repositoryPath: '/repo', branch: 'task/1', defaultBranch: 'master', github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, waitReason: null,
    });
    render(<TaskPage id="task-1" />);
    await waitFor(() => expect(screen.getByText('Status: DONE')).toBeInTheDocument());
    expect(screen.getByText('DEVELOPMENT')).toBeInTheDocument();
    expect(screen.getByText('DONE')).toBeInTheDocument();
    expect(screen.getByText('RELEASED')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders waiting and failure/cancellation statuses as timeline states', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      task: { title: 'Blocked task', status: 'FAILED' }, contract: {},
      lifecycle: { status: 'FAILED', stage: 'FAILED', updatedAt: null },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [],
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, waitReason: null,
    });
    render(<TaskPage id="task-2" />);
    await waitFor(() => expect(screen.getByText('Status: FAILED')).toBeInTheDocument());
    expect(screen.getByText('WAITING_FOR_DEPENDENCY')).toBeInTheDocument();
    expect(screen.getByText('CANCELLED')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('exposes contract section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Contract')).toBeInTheDocument();
  });

  test('exposes workflow section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Workflow')).toBeInTheDocument();
  });

  test('exposes Agent Runs section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Agent Runs')).toBeInTheDocument();
  });

  test('exposes findings/defects section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Findings')).toBeInTheDocument();
  });

  test('exposes Git state section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Git')).toBeInTheDocument();
  });

  test('exposes recovery section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Recovery')).toBeInTheDocument();
  });

  test('exposes usage section', () => {
    render(<TaskPage />);
    expect(screen.getByText('Usage')).toBeInTheDocument();
  });
});

describe('Project', () => {
  test.each([
    [ProjectPage, 'project-1', 'Unable to load project: network unavailable'],
    [EpicPage, 'epic-1', 'Unable to load epic: network unavailable'],
    [TaskPage, 'task-1', 'Unable to load task: network unavailable'],
  ])('shows a retryable error instead of an indefinite loading view', async (Component, id, message) => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network unavailable'));
    render(createElement(Component, { id }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });

  test('renders project details', () => {
    render(<ProjectPage id="1" />);
    expect(screen.getByText(/Project:/)).toBeInTheDocument();
    expect(screen.getByText(/Repository \/ path \/ branch \/ GitHub/)).toBeInTheDocument();
    expect(screen.getByText(/Project tabs/)).toBeInTheDocument();
  });
});

describe('Epic', () => {
  test('renders epic details', () => {
    render(<EpicPage id="1" />);
    expect(screen.getByText(/Epic:/)).toBeInTheDocument();
    expect(screen.getByText(/Lifecycle \/ parallel work graph/)).toBeInTheDocument();
    expect(screen.getByText('Epic Contract')).toBeInTheDocument();
  });

  test('renders actual epic review, architecture review, QA and merge stages', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
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
    await waitFor(() => expect(screen.getByText('Epic Review: COMPLETED')).toBeInTheDocument());
    expect(screen.getByText('Architecture Review: COMPLETED')).toBeInTheDocument();
    expect(screen.getByText('Epic QA: CURRENT')).toBeInTheDocument();
    expect(screen.getByText('Merge: PENDING')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
