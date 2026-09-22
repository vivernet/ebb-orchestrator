import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import ProjectOnboardingPage from '../src/features/onboarding/ProjectOnboardingPage.js';
import SettingsPage from '../src/features/settings/SettingsPage.js';
import UsagePage from '../src/features/usage/UsagePage.js';
import { apiClient } from '../src/api/client.js';

function usageFixture(overrides: Partial<Record<'global' | 'project' | 'epic' | 'task', object>> = {}) {
  const bucket = { inputTokens: 10, cachedTokens: 2, outputTokens: 3, totalTokens: 15, tokens: 15, cost: 1.25, aggregation: 'all_records' };
  return {
    global: { ...bucket, ...overrides.global },
    project: { ...bucket, aggregation: 'records_with_project_id', ...overrides.project },
    epic: { ...bucket, aggregation: 'records_with_epic_id', ...overrides.epic },
    task: { ...bucket, aggregation: 'records_with_task_id', ...overrides.task },
    effectiveLimit: 'global',
  };
}

describe('Onboarding DETECTED vs PROPOSED separation', () => {
  test('does not request an invalid onboarding endpoint when no project is selected', () => {
    const get = vi.spyOn(apiClient, 'get');

    render(<ProjectOnboardingPage id="" />);

    expect(screen.getByRole('heading', { name: 'Project onboarding' })).toBeInTheDocument();
    expect(screen.getByText(/select a project/i)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

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

    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.getByText(/activation is unavailable/i)).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.getByText(/does not expose a client-side bypass/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('does not fabricate an activation action without backend authority', async () => {
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
    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.getByText(/activation is unavailable/i)).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('Settings page configuration hierarchy', () => {
  test('shows effective hierarchy Global → Project → Role → Task/Epic', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: {
        global: { schemaVersion: 1, globalMax: 7, projectMax: 3, roleCapacity: { developer: 4 } },
        project: null,
        role: null,
        taskEpic: null,
      },
      securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getAllByText('Global')).toHaveLength(1));
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
    expect(screen.getByText('Task/Epic')).toBeInTheDocument();
    expect(screen.getByText('Global max: 7')).toBeInTheDocument();
    expect(screen.queryByText(/gpt-4/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('labels unsupported hierarchy and security settings as unavailable', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      effectiveHierarchy: { global: { schemaVersion: null, globalMax: null, projectMax: null, roleCapacity: null }, project: null, role: null, taskEpic: null },
      securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getAllByText('Security')).toHaveLength(1));
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Local Mode: Disabled/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders retryable settings load failure', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('settings unavailable')).mockResolvedValueOnce({
      effectiveHierarchy: { global: { schemaVersion: 1, globalMax: 4, projectMax: 3, roleCapacity: {} }, project: null, role: null, taskEpic: null },
      securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
    });

    render(<SettingsPage />);

    expect(await screen.findByText('Unable to load settings: settings unavailable')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(screen.getByText('Global max: 4')).toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});

describe('Usage page budget tracking', () => {
  test('renders loading usage data as a canonical status region', () => {
    vi.spyOn(apiClient, 'get').mockReturnValue(new Promise(() => undefined));

    render(<UsagePage />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading usage data…');
    vi.restoreAllMocks();
  });

  test('shows corrected token metrics with honest aggregate labels', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(usageFixture({
      global: { inputTokens: 100, cachedTokens: 20, outputTokens: 30, totalTokens: 150, tokens: 150, cost: 10 },
    }));

    render(<UsagePage />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'All records' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Records with project_id' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Records with epic_id' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Records with task_id' })).toBeInTheDocument();
    const allRecords = screen.getByRole('heading', { name: 'All records' }).closest('article');
    expect(allRecords).not.toBeNull();
    expect(within(allRecords!).getByText('100')).toBeInTheDocument();
    expect(within(allRecords!).getByText('20')).toBeInTheDocument();
    expect(within(allRecords!).getByText('30')).toBeInTheDocument();
    expect(within(allRecords!).getByText('150')).toBeInTheDocument();
    expect(allRecords).toHaveTextContent('$10.00');
    expect(screen.queryByText(/Effective limit/)).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/usage', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('shows explicit empty state for zero aggregate usage', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(usageFixture({
      global: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
      project: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
      epic: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
      task: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, tokens: 0, cost: 0 },
    }));

    render(<UsagePage />);

    expect(await screen.findByText('No usage records are available.')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('renders retryable error and refetches authoritative usage', async () => {
    const get = vi.spyOn(apiClient, 'get')
      .mockRejectedValueOnce(new Error('usage unavailable'))
      .mockResolvedValueOnce(usageFixture());

    render(<UsagePage />);

    expect(await screen.findByText('Unable to load usage: usage unavailable')).toBeInTheDocument();
    get.mockResolvedValue(usageFixture());
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'All records' })).toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  test('refetches usage after SSE reconnect', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(usageFixture());

    render(<UsagePage />);

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new CustomEvent('sse-reconnect'));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    vi.restoreAllMocks();
  });
});
