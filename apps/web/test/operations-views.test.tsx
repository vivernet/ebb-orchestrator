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

    expect(screen.getByText(maliciousText)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  test('strips ANSI/OSC terminal sequences outside allowlist', () => {
    const rawOutput = '\x1b[31mRed text\x1b[0m and \x1b]0;Title\x07title';
    render(<SanitizedTerminal logs={[rawOutput]} />);

    expect(screen.getByText('Red text and title')).toBeInTheDocument();
  });

  test('allows safe ANSI color codes', () => {
    const coloredOutput = '\x1b[32mSuccess\x1b[0m';
    render(<SanitizedTerminal logs={[coloredOutput]} />);

    expect(screen.getByText('Success')).toBeInTheDocument();
  });
});

describe('Reference execution queue', () => {
  const queueProjection = {
    running: [{ runId: 'run-841', role: 'Senior Developer', taskId: 'task-425', status: 'IN_PROGRESS' }],
    waiting: [{ taskId: 'task-424', reason: { code: 'WAITING_FOR_ROLE_CAPACITY', message: 'Secret backend English detail' } }],
    blocked: [{ taskId: 'task-508', reason: { code: 'BLOCKED_BY_WORKFLOW', message: 'Secret backend English detail' } }],
    capacity: { configured: 4, used: 3 }, locks: [], recentEvents: [], dispatchState: { paused: false, updatedAt: null },
  };

  test('рендерит очередь без сырых кодов причин', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(queueProjection);
    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Очередь выполнения' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/execution', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Senior Developer · RUN-841')).toBeInTheDocument();
    expect(screen.getByText('Очередь ожидания')).toBeInTheDocument();
    expect(screen.queryByText(/WAITING_FOR_ROLE_CAPACITY|BLOCKED_BY_WORKFLOW/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Secret backend English detail/)).not.toBeInTheDocument();
  });

  test('ошибка загрузки очереди локализована и повторяема', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValueOnce(queueProjection);
    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить очередь выполнения: Не удалось выполнить запрос.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Очередь выполнения' })).toBeInTheDocument();
  });
});

describe('Reference agent run', () => {
  const runProjection = {
    id: 'run-841', role: 'Senior Developer', runtime: 'Hermes', model: 'terra', status: 'IN_PROGRESS',
    taskId: 'task-425', epicId: null, sessionId: 'dev-425', attempt: 2, triggerReason: 'REVIEW_REWORK',
    startedAt: '2026-10-24T05:41:18.000Z', endedAt: null, exitCode: null,
    usage: {
      inputTokens: { availability: 'available', value: 63400 },
      cachedInputTokens: { availability: 'available', value: 42100 },
      outputTokens: { availability: 'available', value: 10800 },
      effectiveCost: { availability: 'available', value: 0.78 },
    },
    control: { state: 'ACTIVE', version: 1, updatedAt: '2026-10-24T05:41:20.000Z', checkpointId: null },
  };

  test('рендерит детали запуска и панели без утечки payload', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(runProjection);
    render(<MemoryRouter><AgentRunPage id="run-841" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'RUN-841 · Senior Developer' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/runs/run-841', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Вывод терминала')).toBeInTheDocument();
    expect(screen.getByText('Среда выполнения')).toBeInTheDocument();
    expect(screen.queryByText(/private ui prompt|sentinel/)).not.toBeInTheDocument();
  });
});
