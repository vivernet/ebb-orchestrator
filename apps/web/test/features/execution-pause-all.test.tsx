import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ExecutionPage from '../../src/features/execution/ExecutionPage.js';
import { apiClient } from '../../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('ExecutionPage Pause All', () => {
  test('pause-all приостанавливает каждую задачу очереди и перезагружает проекцию', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      running: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
      waiting: [{ taskId: 'task-2', reason: { code: 'WAITING_FOR_CAPACITY', message: 'x' } }],
      blocked: [{ taskId: 'task-3', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'x' } }],
    });
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    const pauseAll = await screen.findByRole('button', { name: 'Приостановить всё' });
    expect(pauseAll).not.toBeDisabled();
    fireEvent.click(pauseAll);

    await waitFor(() => expect(post).toHaveBeenCalledWith('/tasks/task-1/pause', {}));
    expect(post).toHaveBeenCalledWith('/tasks/task-2/pause', {});
    expect(post).toHaveBeenCalledWith('/tasks/task-3/pause', {});
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  });

  test('pause-all отключён при пустой очереди', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({ running: [], waiting: [], blocked: [] });

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    const pauseAll = await screen.findByRole('button', { name: 'Приостановить всё' });
    expect(pauseAll).toBeDisabled();
  });

  test('ошибка pause-all показывается безопасным сообщением', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      running: [], waiting: [{ taskId: 'task-1', reason: { code: 'WAITING_FOR_CAPACITY', message: 'x' } }], blocked: [],
    });
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('secret pause detail'));

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    const pauseAll = await screen.findByRole('button', { name: 'Приостановить всё' });
    fireEvent.click(pauseAll);

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось приостановить очередь: Не удалось выполнить запрос.');
    expect(screen.queryByText(/secret pause detail/)).not.toBeInTheDocument();
  });
});
