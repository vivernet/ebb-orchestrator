import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import AgentRunPage from '../../src/features/runs/AgentRunPage.js';
import { apiClient } from '../../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

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

const eventsProjection = {
  items: [{ id: 'ev-1', type: 'Начат вызов инструмента', createdAt: '2026-10-24T05:41:18.000Z', payload: {} }],
  nextCursor: null,
};

const terminalProjection = {
  availability: 'available',
  entries: [{ seq: 0, text: '[tool] factory check', at: '2026-10-24T05:41:19.000Z' }],
};

function mockRunApis({ failDetail = false }: { failDetail?: boolean } = {}) {
  return vi.spyOn(apiClient, 'get').mockImplementation(async (path: string) => {
    if (path === '/runs/run-841') {
      if (failDetail) throw new Error('secret: run db');
      return runProjection;
    }
    if (path === '/runs/run-841/events') return eventsProjection;
    if (path === '/runs/run-841/terminal') return terminalProjection;
    throw new Error(`unexpected path: ${path}`);
  });
}

describe('AgentRunPage (reference 10)', () => {
  test('рендерит метрики, события и панели запуска без сырых payload-кодов', async () => {
    const get = mockRunApis();
    render(<MemoryRouter><AgentRunPage id="run-841" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'run-841 · Senior Developer' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/runs/run-841', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(get).toHaveBeenCalledWith('/runs/run-841/events', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(get).toHaveBeenCalledWith('/runs/run-841/terminal', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Начат вызов инструмента')).toBeInTheDocument();
    expect(screen.getByText('Вывод терминала')).toBeInTheDocument();
    expect(screen.getByText('Цель запуска')).toBeInTheDocument();
    expect(screen.getAllByText('Среда выполнения').length).toBeGreaterThan(0);
    expect(screen.getByText('Решения по разрешениям')).toBeInTheDocument();
    expect(screen.getByText('недоступно (источник решений недоступен в текущей проекции)')).toBeInTheDocument();
    expect(screen.getAllByText('Использование').length).toBeGreaterThan(0);
    expect(screen.getByText('Сигналы восстановления')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать контрольную точку' })).toBeInTheDocument();
    expect(screen.queryByText(/ALLOW|DENY/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private ui prompt|sentinel/)).not.toBeInTheDocument();
  });

  test('ошибка загрузки локализована и повторяема', async () => {
    const get = mockRunApis({ failDetail: true });
    render(<MemoryRouter><AgentRunPage id="run-841" /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить запуск агента: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
    get.mockImplementation(async (path: string) => {
      if (path === '/runs/run-841') return runProjection;
      if (path === '/runs/run-841/events') return eventsProjection;
      if (path === '/runs/run-841/terminal') return terminalProjection;
      throw new Error(`unexpected path: ${path}`);
    });
    const retry = screen.getByRole('button', { name: 'Повторить' });
    retry.click();
    expect(await screen.findByRole('heading', { name: 'run-841 · Senior Developer' })).toBeInTheDocument();
  });
});
