import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

describe('AgentRunPage (reference 10)', () => {
  test('рендерит метрики, события и панели запуска без сырых payload-кодов', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue(runProjection);
    render(<MemoryRouter><AgentRunPage id="run-841" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'RUN-841 · Senior Developer' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/runs/run-841', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Начат вызов инструмента')).toBeInTheDocument();
    expect(screen.getByText('Вывод терминала')).toBeInTheDocument();
    expect(screen.getByText('Цель запуска')).toBeInTheDocument();
    expect(screen.getByText('Среда выполнения')).toBeInTheDocument();
    expect(screen.getByText('Решения по разрешениям')).toBeInTheDocument();
    expect(screen.getByText('Использование')).toBeInTheDocument();
    expect(screen.getByText('Сигналы восстановления')).toBeInTheDocument();
    expect(screen.getByText('Пакет контекста')).toBeInTheDocument();
    expect(screen.getByText('ALLOW')).toBeInTheDocument();
    expect(screen.queryByText(/private ui prompt|sentinel/)).not.toBeInTheDocument();
  });

  test('ошибка загрузки локализована и повторяема', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('secret: run db')).mockResolvedValueOnce(runProjection);
    render(<MemoryRouter><AgentRunPage id="run-841" /></MemoryRouter>);

    expect(await screen.findByText('Не удалось загрузить запуск агента: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(screen.queryByText(/secret:/)).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Повторить' });
    retry.click();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'RUN-841 · Senior Developer' })).toBeInTheDocument();
  });
});
