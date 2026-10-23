import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AgentRunPage from '../../src/features/runs/AgentRunPage.js';
import * as queryModule from '../../src/state/use-query.js';

const queryMeta = { key: '/api/v1/runs/run-1', updatedAt: null, isStale: false };

function useQueryMock(status: 'success' | 'loading' | 'error', data?: unknown) {
  return {
    status,
    data,
    error: status === 'error' ? new Error('boom') : null,
    ...queryMeta,
    refetch: vi.fn(),
  };
}

describe('AgentRunPage: run selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('показывает durable providerSelection с именем провайдера из каталога', async () => {
    vi.spyOn(queryModule, 'useQuery').mockReturnValue(useQueryMock('success', {
      id: 'run-1',
      role: 'developer',
      runtime: 'node',
      model: 'default',
      status: 'COMPLETED',
      triggerReason: 'Разработка',
      taskId: null,
      epicId: null,
      startedAt: '2026-01-15T10:00:00Z',
      endedAt: '2026-01-15T10:45:00Z',
      usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50, cost: 0.001 },
      providerSelection: { providerId: 'openai', modelId: 'gpt-4o', authMethodId: 'api-key', configRevision: 3 },
    }));
    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Запуск агента: run-1')).toBeInTheDocument());
    const details = screen.getByRole('region', { name: 'Сведения о запуске' });
    expect(details).toHaveTextContent('gpt-4o');
    expect(details).toHaveTextContent('OpenAI');
    expect(details).toHaveTextContent('ревизия 3');
  });

  test('запуск без providerSelection не показывает durable-блок', async () => {
    vi.spyOn(queryModule, 'useQuery').mockReturnValue(useQueryMock('success', {
      id: 'run-2',
      role: 'developer',
      runtime: 'node',
      model: 'gpt-4o',
      status: 'COMPLETED',
      triggerReason: 'Разработка',
      taskId: null,
      epicId: null,
      startedAt: '2026-01-15T10:00:00Z',
      endedAt: '2026-01-15T10:45:00Z',
      usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50, cost: 0.001 },
      providerSelection: null,
    }));
    render(<MemoryRouter><AgentRunPage id="run-2" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Запуск агента: run-2')).toBeInTheDocument());
    const details = screen.getByRole('region', { name: 'Сведения о запуске' });
    expect(details).not.toHaveTextContent('durable');
  });
});
