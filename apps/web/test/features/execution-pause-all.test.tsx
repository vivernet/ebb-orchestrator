import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ExecutionPage from '../../src/features/execution/ExecutionPage.js';
import { apiClient } from '../../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('ExecutionPage actions', () => {
  test('does not expose a synthetic Pause All action and still cancels one supported Run', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      running: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
      waiting: [{ taskId: 'task-2', reason: { code: 'WAITING_FOR_CAPACITY', message: 'x' } }],
      blocked: [{ taskId: 'task-3', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'x' } }],
    });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: 'Отменить' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Приостановить всё' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отменить' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/runs/run-1/cancel', {}));
    expect(post).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  });

  test('does not display bulk controls for an empty queue', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ running: [], waiting: [], blocked: [] });

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByRole('region', { name: 'Активные запуски' })).toHaveTextContent('Активных запусков нет.');
    expect(screen.queryByRole('button', { name: 'Приостановить всё' })).not.toBeInTheDocument();
  });
});
