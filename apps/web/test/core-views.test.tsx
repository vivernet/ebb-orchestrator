import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import ProjectPage from '../src/features/projects/ProjectPage.js';
import EpicPage from '../src/features/epics/EpicPage.js';
import TaskPage from '../src/features/tasks/TaskPage.js';
import { apiClient } from '../src/api/client.js';

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
    expect(screen.getByRole('button', { name: 'Pause All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Request' })).toBeInTheDocument();
  });
});

describe('Task', () => {
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
});
