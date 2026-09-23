import { describe, test, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import SanitizedTerminal from '../src/components/SanitizedTerminal.js';
import ExecutionPage from '../src/features/execution/ExecutionPage.js';
import AgentRunPage from '../src/features/runs/AgentRunPage.js';
import { apiClient } from '../src/api/client.js';

describe('SanitizedTerminal', () => {
  test('renders plain text safely', () => {
    render(<SanitizedTerminal logs={['hello world']} />);
    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  test('renders agent text with <img onerror=...> as text, not DOM node', () => {
    const maliciousText = 'Agent response: <img onerror="alert(1)" src="x">';
    render(<SanitizedTerminal logs={[maliciousText]} />);
    
    // Должен отображаться текст, а не элемент img.
    expect(screen.getByText(maliciousText)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  test('strips ANSI/OSC terminal sequences outside allowlist', () => {
    const rawOutput = '\x1b[31mRed text\x1b[0m and \x1b]0;Title\x07title';
    render(<SanitizedTerminal logs={[rawOutput]} />);
    
    // ANSI/OSC-последовательности должны удаляться, остаётся обычный текст.
    expect(screen.getByText('Red text and title')).toBeInTheDocument();
  });

  test('allows safe ANSI color codes', () => {
    const coloredOutput = '\x1b[32mSuccess\x1b[0m';
    render(<SanitizedTerminal logs={[coloredOutput]} />);
    
    // ANSI-последовательности должны удаляться, текст должен отображаться.
    expect(screen.getByText('Success')).toBeInTheDocument();
  });
});

describe('Queue row wait reason', () => {
  test('shows the exact blocking reason from the execution projection', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      running: [],
      waiting: [{ taskId: 'task-1', reason: { code: 'WAITING_FOR_APPROVAL', message: 'Waiting for final merge approval' } }],
      blocked: [],
    });

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByText('Waiting for final merge approval')).toBeInTheDocument();
    expect(screen.getByText('WAITING_FOR_APPROVAL')).toBeInTheDocument();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/execution', expect.objectContaining({ signal: expect.any(AbortSignal) })));
    vi.restoreAllMocks();
  });

  test('refresh button refetches execution through the query store', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValueOnce({ running: [], waiting: [], blocked: [] });
    render(<ExecutionPage />);

    expect(await screen.findByText('Unable to load execution queue: temporary outage')).toBeInTheDocument();
    get.mockResolvedValueOnce({ running: [], waiting: [], blocked: [] });
    // Refresh is rendered only in the successful page shell, so retry first restores it.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    vi.restoreAllMocks();
  });

  test('cancel uses one pending mutation and refetches the authoritative projection', async () => {
    let resolveCancel!: (value: unknown) => void;
    const cancel = new Promise((resolve) => { resolveCancel = resolve; });
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      running: [{ runId: 'run-1', role: 'Developer', taskId: 'task-1', status: 'IN_PROGRESS' }],
      waiting: [],
      blocked: [],
    });
    const post = vi.spyOn(apiClient, 'post').mockReturnValue(cancel);

    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    const button = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    resolveCancel({});
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled());
    vi.restoreAllMocks();
  });
});

describe('Agent Run detail', () => {
  test('uses the supported run detail projection and does not request unavailable subresources', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      id: 'run-1', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'IN_PROGRESS', taskId: 'task-1', epicId: null,
      triggerReason: 'DEVELOPMENT', startedAt: '2026-09-20T00:00:00.000Z', endedAt: null,
      usage: { inputTokens: 1, cachedTokens: 2, outputTokens: 3, cost: 0.42 },
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Agent Run: run-1' })).toBeInTheDocument();
    expect(screen.getByText('DEVELOPMENT')).toBeInTheDocument();
    expect(screen.getByText('$0.4200')).toBeInTheDocument();
    // Page makes multiple calls: run, events, tools, permissions, recovery
    expect(get.mock.calls.filter(([path]) => path.startsWith('/runs/run-1'))).toHaveLength(5);
    expect(get).toHaveBeenCalledWith('/runs/run-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('links present run task and epic IDs with encoded routes', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      id: 'run/1', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'IN_PROGRESS', taskId: 'task/1', epicId: 'epic/1',
      triggerReason: 'DEVELOPMENT', startedAt: null, endedAt: null,
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
    });
    render(<MemoryRouter><AgentRunPage id="run/1" /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: 'task/1' })).toHaveAttribute('href', '/tasks/task%2F1');
    expect(screen.getByRole('link', { name: 'epic/1' })).toHaveAttribute('href', '/epics/epic%2F1');
    vi.restoreAllMocks();
  });

  test('refetches execution and run projections after SSE reconnect', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => path === '/execution'
      ? { running: [], waiting: [], blocked: [] }
      : { id: 'run-1', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'DONE', taskId: null, epicId: null, triggerReason: null, startedAt: null, endedAt: null, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 } });
    render(<MemoryRouter><><ExecutionPage /><AgentRunPage id="run-1" /></></MemoryRouter>);

    await waitFor(() => {
      expect(get.mock.calls.filter(([path]) => path === '/execution')).toHaveLength(1);
      expect(get.mock.calls.filter(([path]) => path === '/runs/run-1')).toHaveLength(1);
    });
    window.dispatchEvent(new CustomEvent('sse-reconnect'));
    await waitFor(() => {
      expect(get.mock.calls.filter(([path]) => path === '/execution')).toHaveLength(2);
      expect(get.mock.calls.filter(([path]) => path === '/runs/run-1')).toHaveLength(2);
    });
    vi.restoreAllMocks();
  });

  test('renders cancel failure and re-enables the mutation', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      id: 'run-1', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'IN_PROGRESS', taskId: null, epicId: null,
      triggerReason: null, startedAt: null, endedAt: null,
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
    });
    const post = vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('cancel rejected'));
    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    const button = await screen.findByRole('button', { name: 'Cancel Run' });
    fireEvent.click(button);
    expect(await screen.findByText('Unable to cancel run: cancel rejected')).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
