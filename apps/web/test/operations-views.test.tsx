import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    
    // Should render the text content, not as an img element
    expect(screen.getByText(maliciousText)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  test('strips ANSI/OSC terminal sequences outside allowlist', () => {
    const rawOutput = '\x1b[31mRed text\x1b[0m and \x1b]0;Title\x07title';
    render(<SanitizedTerminal logs={[rawOutput]} />);
    
    // Should strip ANSI/OSC sequences and show plain text
    expect(screen.getByText('Red text and title')).toBeInTheDocument();
  });

  test('allows safe ANSI color codes', () => {
    const coloredOutput = '\x1b[32mSuccess\x1b[0m';
    render(<SanitizedTerminal logs={[coloredOutput]} />);
    
    // Should strip ANSI and show the text
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

    render(<ExecutionPage />);

    expect(await screen.findByText('Waiting for final merge approval')).toBeInTheDocument();
    expect(screen.getByText('WAITING_FOR_APPROVAL')).toBeInTheDocument();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/execution'));
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

    render(<AgentRunPage id="run-1" />);

    expect(await screen.findByRole('heading', { name: 'Agent Run: run-1' })).toBeInTheDocument();
    expect(screen.getByText('DEVELOPMENT')).toBeInTheDocument();
    expect(screen.getByText('$0.4200')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/runs/run-1');
    vi.restoreAllMocks();
  });
});
