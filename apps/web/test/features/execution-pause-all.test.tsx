import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ExecutionPage from '../../src/features/execution/ExecutionPage.js';
import { apiClient } from '../../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

const queueProjection = {
  running: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
  waiting: [{ taskId: 'task-2', reason: { code: 'WAITING_FOR_CAPACITY', message: 'x' } }],
  blocked: [{ taskId: 'task-3', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'x' } }],
  capacity: { configured: 4, used: 1 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null },
};

describe('ExecutionPage actions', () => {
  test('does not expose a synthetic Pause All action; bulk cancel goes through confirmation with expectedRunIds', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(queueProjection);
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ results: [] });
    const get = vi.mocked(apiClient.get);

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByText('Developer · run-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Приостановить всё' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отменить' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Остановить всех агентов' }));
    const before = get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить остановку' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/runs/cancel-all', { expectedRunIds: ['run-1'] }));
    expect(post).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  test('acknowledges an empty queue without firing bulk mutations', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ ...queueProjection, running: [] });
    const post = vi.spyOn(apiClient, 'post');

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByText('Активных запусков нет.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Приостановить всё' })).not.toBeInTheDocument();
    // Bulk control exists but must not call the API for an empty queue.
    fireEvent.click(screen.getByRole('button', { name: 'Остановить всех агентов' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить остановку' }));
    expect(post).not.toHaveBeenCalled();
  });
});
