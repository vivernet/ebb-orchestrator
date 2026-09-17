import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DashboardPage from '../src/features/dashboard/DashboardPage.js';
import ProjectPage from '../src/features/projects/ProjectPage.js';
import EpicPage from '../src/features/epics/EpicPage.js';
import TaskPage from '../src/features/tasks/TaskPage.js';

describe('Dashboard', () => {
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
  });
});

describe('Epic', () => {
  test('renders epic details', () => {
    render(<EpicPage id="1" />);
    expect(screen.getByText(/Epic:/)).toBeInTheDocument();
  });
});
