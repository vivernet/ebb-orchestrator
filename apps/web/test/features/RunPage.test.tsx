import { afterEach, describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import AgentRunPage from '../../src/features/runs/AgentRunPage.js';
import * as runApi from '../../src/features/runs/api.js';
import * as queryModule from '../../src/state/use-query.js';

const server = setupServer(
  http.get('/api/v1/runs/test-run-123', () => {
    return HttpResponse.json({
      id: 'test-run-123',
      role: 'Code Reviewer',
      runtime: 'node',
      model: 'gpt-4.1',
      status: 'COMPLETED',
      triggerReason: 'Pull request review',
      taskId: 'task-456',
      epicId: null,
      startedAt: '2026-01-15T10:00:00Z',
      endedAt: '2026-01-15T10:45:00Z',
      usage: {
        inputTokens: 5000,
        cachedTokens: 1000,
        outputTokens: 2000,
        cost: 0.0125,
      },
    });
  }),
);

function renderWithRouter(component: React.ReactElement) {
  return render(<MemoryRouter>{component}</MemoryRouter>);
}

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' });
  vi.clearAllMocks();
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

describe('AgentRunPage', () => {
  test('показывает loading state при загрузке', () => {
    vi.spyOn(queryModule, 'useQuery').mockReturnValue({
      status: 'loading',
      data: undefined,
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<AgentRunPage id="test-run-123" />);
    expect(screen.getByText('Loading Agent Run…')).toBeInTheDocument();
  });

  test('показывает error state при ошибке загрузки', () => {
    vi.spyOn(queryModule, 'useQuery').mockReturnValue({
      status: 'error',
      data: undefined,
      error: new Error('Failed to fetch'),
      refetch: vi.fn(),
    });

    renderWithRouter(<AgentRunPage id="test-run-123" />);
    expect(screen.getByText(/Unable to load Agent Run/i)).toBeInTheDocument();
  });

  test('показывает run details при успешной загрузке', async () => {
    vi.spyOn(queryModule, 'useQuery').mockReturnValue({
      status: 'success',
      data: {
        id: 'test-run-123',
        role: 'Code Reviewer',
        runtime: 'node',
        model: 'gpt-4.1',
        status: 'COMPLETED',
        triggerReason: 'Pull request review',
        taskId: 'task-456',
        epicId: null,
        startedAt: '2026-01-15T10:00:00Z',
        endedAt: '2026-01-15T10:45:00Z',
        usage: {
          inputTokens: 5000,
          cachedTokens: 1000,
          outputTokens: 2000,
          cost: 0.0125,
        },
      },
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<AgentRunPage id="test-run-123" />);

    expect(screen.getByText('Agent Run: test-run-123')).toBeInTheDocument();
    expect(screen.getByText('Code Reviewer')).toBeInTheDocument();
    expect(screen.getByText('node')).toBeInTheDocument();
    expect(screen.getByText('gpt-4.1')).toBeInTheDocument();
    expect(screen.getByText('Pull request review')).toBeInTheDocument();
    expect(screen.getByText('task-456')).toBeInTheDocument();
  });

  test('показывает Events section с данными', async () => {
    vi.spyOn(runApi, 'getRunEvents').mockResolvedValue([
      { id: 'evt-1', type: 'run_started', createdAt: '2026-01-15T10:00:00Z', aggregateType: 'Run', aggregateId: 'test-run-123', availableAt: '2026-01-15T10:00:00Z', processedAt: null, attempts: 1 },
      { id: 'evt-2', type: 'tool_used', createdAt: '2026-01-15T10:15:00Z', aggregateType: 'Run', aggregateId: 'test-run-123', availableAt: '2026-01-15T10:15:00Z', processedAt: null, attempts: 1 },
      { id: 'evt-3', type: 'run_completed', createdAt: '2026-01-15T10:45:00Z', aggregateType: 'Run', aggregateId: 'test-run-123', availableAt: '2026-01-15T10:45:00Z', processedAt: null, attempts: 1 },
    ]);
    vi.spyOn(runApi, 'getRunTools').mockResolvedValue({ tools: ['git', 'file_read'] });
    vi.spyOn(runApi, 'getRunPermissions').mockResolvedValue([]);
    vi.spyOn(runApi, 'getRunRecovery').mockResolvedValue({ runId: 'test-run-123', taskId: null, runStatus: 'COMPLETED', recovery: null });

    vi.spyOn(queryModule, 'useQuery').mockReturnValue({
      status: 'success',
      data: {
        id: 'test-run-123',
        role: 'Code Reviewer',
        runtime: 'node',
        model: 'gpt-4.1',
        status: 'COMPLETED',
        triggerReason: null,
        taskId: null,
        epicId: null,
        startedAt: '2026-01-15T10:00:00Z',
        endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      },
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<AgentRunPage id="test-run-123" />);

    await waitFor(() => {
      expect(screen.getByText('Events')).toBeInTheDocument();
    });

    expect(screen.getByText('run_started')).toBeInTheDocument();
    expect(screen.getByText('run_completed')).toBeInTheDocument();
  });

  test('показывает Tools section с данными', async () => {
    vi.spyOn(runApi, 'getRunEvents').mockResolvedValue([]);
    vi.spyOn(runApi, 'getRunTools').mockResolvedValue({ tools: ['git', 'file_read', 'file_write', 'code_review'] });
    vi.spyOn(runApi, 'getRunPermissions').mockResolvedValue([]);
    vi.spyOn(runApi, 'getRunRecovery').mockResolvedValue({ runId: 'test-run-123', taskId: null, runStatus: 'COMPLETED', recovery: null });

    vi.spyOn(queryModule, 'useQuery').mockReturnValue({
      status: 'success',
      data: {
        id: 'test-run-123',
        role: 'Code Reviewer',
        runtime: 'node',
        model: 'gpt-4.1',
        status: 'COMPLETED',
        triggerReason: null,
        taskId: null,
        epicId: null,
        startedAt: '2026-01-15T10:00:00Z',
        endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      },
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<AgentRunPage id="test-run-123" />);

    await waitFor(() => {
      expect(screen.getByText('Allowed Tools')).toBeInTheDocument();
    });

    expect(screen.getByText('git')).toBeInTheDocument();
    expect(screen.getByText('file_write')).toBeInTheDocument();
    expect(screen.getByText('code_review')).toBeInTheDocument();
  });

  test('показывает Permissions section с данными', async () => {
    vi.spyOn(runApi, 'getRunEvents').mockResolvedValue([]);
    vi.spyOn(runApi, 'getRunTools').mockResolvedValue({ tools: [] });
    vi.spyOn(runApi, 'getRunPermissions').mockResolvedValue([
      { id: 'aud-1', action: 'read_code', actor: 'system', aggregateType: 'PR', aggregateId: 'pr-789', details: {}, createdAt: '2026-01-15T10:10:00Z' },
      { id: 'aud-2', action: 'write_comment', actor: 'system', aggregateType: 'PR', aggregateId: 'pr-789', details: {}, createdAt: '2026-01-15T10:30:00Z' },
    ]);
    vi.spyOn(runApi, 'getRunRecovery').mockResolvedValue({ runId: 'test-run-123', taskId: null, runStatus: 'COMPLETED', recovery: null });

    vi.spyOn(queryModule, 'useQuery').mockReturnValue({
      status: 'success',
      data: {
        id: 'test-run-123',
        role: 'Code Reviewer',
        runtime: 'node',
        model: 'gpt-4.1',
        status: 'COMPLETED',
        triggerReason: null,
        taskId: null,
        epicId: null,
        startedAt: '2026-01-15T10:00:00Z',
        endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      },
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<AgentRunPage id="test-run-123" />);

    await waitFor(() => {
      expect(screen.getByText('Permissions & Audit Log')).toBeInTheDocument();
    });

    expect(screen.getByText('read_code')).toBeInTheDocument();
    expect(screen.getByText('write_comment')).toBeInTheDocument();
  });

  test('показывает Recovery section с данными', async () => {
    vi.spyOn(runApi, 'getRunEvents').mockResolvedValue([]);
    vi.spyOn(runApi, 'getRunTools').mockResolvedValue({ tools: [] });
    vi.spyOn(runApi, 'getRunPermissions').mockResolvedValue([]);
    vi.spyOn(runApi, 'getRunRecovery').mockResolvedValue({
      runId: 'test-run-123',
      taskId: 'task-456',
      runStatus: 'COMPLETED',
      recovery: {
        attempts: [{ id: 'rec-1', roleLevel: 'level-2', failureType: 'timeout', attemptCount: 1, timestamp: '2026-01-15T10:20:00Z', fingerprint: null }],
        schedulerRequests: [],
        state: { id: 'rec-state-1', status: 'resolved', reason: 'recovered after timeout', createdAt: '2026-01-15T10:21:00Z', updatedAt: '2026-01-15T10:25:00Z' },
      },
    });

    vi.spyOn(queryModule, 'useQuery').mockReturnValue({
      status: 'success',
      data: {
        id: 'test-run-123',
        role: 'Code Reviewer',
        runtime: 'node',
        model: 'gpt-4.1',
        status: 'COMPLETED',
        triggerReason: null,
        taskId: null,
        epicId: null,
        startedAt: '2026-01-15T10:00:00Z',
        endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      },
      error: null,
      refetch: vi.fn(),
    });

    renderWithRouter(<AgentRunPage id="test-run-123" />);

    await waitFor(() => {
      expect(screen.getByText('Recovery')).toBeInTheDocument();
    });

    expect(screen.getByText('Recovery Attempts')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBe(1);
  });
});
