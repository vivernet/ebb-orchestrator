import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ProjectOnboardingPage from '../src/features/onboarding/ProjectOnboardingPage.js';
import SettingsPage from '../src/features/settings/SettingsPage.js';
import UsagePage from '../src/features/usage/UsagePage.js';
import { apiClient } from '../src/api/client.js';

describe('Onboarding DETECTED vs PROPOSED separation', () => {
  test('renders detected branch/package manager separately from Coordinator proposals', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      projectId: '1',
      repository: { path: '/repo', remoteUrl: 'https://github.com/test/repo.git' },
      detected: {
        defaultBranch: 'main',
        packageManager: 'pnpm',
        testFramework: 'vitest',
        orchestratorConfigFound: false,
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

    await waitFor(() => expect(screen.getAllByText('DETECTED')).toHaveLength(1));
    expect(screen.getByText(/Package manager: pnpm/)).toBeInTheDocument();

    expect(screen.getByText(/Workflow: standard/)).toBeInTheDocument();
    expect(screen.getByText(/Roles: Developer, Reviewer, QA/)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Activate/i })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('activation button cannot proceed with unresolved semantic config approval', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      projectId: '1',
      repository: { path: '/repo', remoteUrl: 'https://github.com/test/repo.git' },
      detected: { defaultBranch: 'main', packageManager: 'npm', testFramework: null, orchestratorConfigFound: false },
      proposed: { defaultBranch: 'main', workflow: 'standard', roles: ['Developer'], guidelines: [] },
      approvalStatus: 'PENDING',
      semanticConfigApproved: false,
      localModeEnabled: false,
    });

    render(<ProjectOnboardingPage id="1" />);

    await waitFor(() => expect(screen.getAllByText('DETECTED')).toHaveLength(1));
    const activateButton = screen.getByRole('button', { name: /Activate/i });
    expect(activateButton).toBeDisabled();
    vi.restoreAllMocks();
  });

  test('activation can proceed when semantic config is approved', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      projectId: '1',
      repository: { path: '/repo', remoteUrl: 'https://github.com/test/repo.git' },
      detected: { defaultBranch: 'main', packageManager: 'npm', testFramework: null, orchestratorConfigFound: false },
      proposed: { defaultBranch: 'main', workflow: 'standard', roles: ['Developer'], guidelines: [] },
      approvalStatus: 'PENDING',
      semanticConfigApproved: true,
      localModeEnabled: false,
    });

    render(<ProjectOnboardingPage id="1" />);

    await waitFor(() => expect(screen.getAllByText('DETECTED')).toHaveLength(1));
    const activateButton = screen.getByRole('button', { name: /Activate/i });
    expect(activateButton).toBeEnabled();
    vi.restoreAllMocks();
  });
});

describe('Settings page configuration hierarchy', () => {
  test('shows effective hierarchy Global → Project → Role → Task/Epic', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: {
        global: { maxParallelAgents: 5, defaultModel: 'gpt-4' },
        project: { maxParallelAgents: 3, budgetLimit: 100 },
        role: { Developer: { defaultModel: 'claude-3' } },
        taskEpic: {},
      },
      securitySettings: { mostRestrictiveWins: true, localModeEnabled: false },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getAllByText('Global')).toHaveLength(1));
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
    expect(screen.getByText('Task/Epic')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('distinguishes security most-restrictive behavior', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: { global: {}, project: {}, role: {}, taskEpic: {} },
      securitySettings: { mostRestrictiveWins: true, localModeEnabled: false },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getAllByText('Security')).toHaveLength(1));
    expect(screen.getByText(/most-restrictive/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('Local Mode warning is visible for untrusted code execution', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: { global: {}, project: {}, role: {}, taskEpic: {} },
      securitySettings: { mostRestrictiveWins: true, localModeEnabled: true },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getAllByText(/Local Mode/i)).toHaveLength(3));
    expect(screen.getAllByText(/untrusted/i)).toHaveLength(2);
    expect(screen.getByText(/sandbox/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('Usage page budget tracking', () => {
  test('shows usage budget hierarchy', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      global: { tokens: 1000, cost: 10 },
      project: { tokens: 500, cost: 5 },
      epic: { tokens: 200, cost: 2 },
      task: { tokens: 50, cost: 0.5 },
      effectiveLimit: 'project',
    });

    render(<UsagePage />);

    await waitFor(() => expect(screen.getAllByText('Global')).toHaveLength(1));
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Epic')).toBeInTheDocument();
    expect(screen.getByText('Task')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
