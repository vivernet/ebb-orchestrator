import { describe, test, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

    expect(await screen.findByText('Ожидается согласование.')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /task-1/ })).not.toHaveTextContent('WAITING_FOR_APPROVAL');
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/execution', expect.objectContaining({ signal: expect.any(AbortSignal) })));
    vi.restoreAllMocks();
  });

  test('renders distinct coded waiting and blocking reasons safely without raw codes', async () => {
    const reasons = [
      ['WAITING_FOR_CAPACITY', 'Ожидается доступная мощность планировщика.'],
      ['WAITING_FOR_ROLE_CAPACITY', 'Ожидается доступная мощность для роли.'],
      ['WAITING_FOR_RESOURCE_LOCK', 'Ожидается освобождение ресурса.'],
      ['WAITING_FOR_BUDGET', 'Ожидается бюджет проекта.'],
      ['WAITING_FOR_DEPENDENCY', 'Ожидается выполнение зависимости.'],
      ['APPROVAL', 'Ожидается согласование.'],
      ['DEPENDENCY', 'Ожидается выполнение зависимости.'],
      ['BLOCKED_BY_WORKFLOW', 'Заблокировано рабочим процессом.'],
      ['BLOCKED_BY_PROJECT_STATE', 'Заблокировано состоянием проекта.'],
      ['PROJECT_NOT_ACTIVE', 'Проект не активен.'],
      ['ONBOARDING_NOT_ACTIVE', 'Онбординг проекта не активирован.'],
      ['BLOCKED', 'Заблокировано рабочим процессом или политикой.'],
      ['PAUSED', 'Приостановлено пользователем.'],
      ['FUTURE_REASON', 'Причина ожидания недоступна.'],
    ] as const;
    vi.spyOn(apiClient, 'get').mockResolvedValue({ running: [], waiting: reasons.map(([code], index) => ({ taskId: `task-${index}`, reason: { code, message: 'Secret backend English detail' } })), blocked: [] });
    render(<MemoryRouter><ExecutionPage /></MemoryRouter>);
    await screen.findByRole('link', { name: 'task-0' });
    reasons.forEach(([code, label], index) => {
      const row = screen.getByRole('link', { name: `task-${index}` }).closest('tr');
      expect(row).toHaveTextContent(label);
      expect(row).not.toHaveTextContent(code);
      expect(row).not.toHaveTextContent('Secret backend English detail');
    });
    vi.restoreAllMocks();
  });

  test('refresh button refetches execution through the query store', async () => {
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('temporary outage')).mockResolvedValueOnce({ running: [], waiting: [], blocked: [] });
    render(<ExecutionPage />);

    expect(await screen.findByText('Не удалось загрузить очередь выполнения: Не удалось выполнить запрос.')).toBeInTheDocument();
    get.mockResolvedValueOnce({ running: [], waiting: [], blocked: [] });
    // Refresh is rendered only in the successful page shell, so retry first restores it.
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }));
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

    const button = await screen.findByRole('button', { name: 'Отменить' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    resolveCancel({});
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отменить' })).not.toBeDisabled());
    vi.restoreAllMocks();
  });
});

describe('Agent Run detail', () => {
  test('renders run-scoped artifact metadata without requesting or exposing contents', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-1/artifacts') return [{
        id: 'artifact-1',
        type: 'test-report',
        contentType: 'text/plain',
        sizeBytes: 42,
        sha256: 'a'.repeat(64),
        status: 'ACTIVE',
        createdAt: '2026-09-30T00:00:00.000Z',
      }] as never;
      if (path === '/runs/run-1/context-manifests') return {
        availability: 'available', id: 'manifest-1', runId: 'run-1', subject: { type: 'TASK', id: 'task-1' }, role: 'developer',
        contractRequestDigest: 'a'.repeat(64), items: [{ id: 'guideline-1', version: 3, digest: 'b'.repeat(64) }, { id: 'decision-2', version: null, digest: null }],
        promptHash: 'c'.repeat(64), contextHash: 'd'.repeat(64), contextBuilderVersion: 'builder-v2', initialTokenSize: 23,
      } as never;
      if (path === '/settings') return { securitySettings: { localModeEnabled: true } } as never;
      if (path === '/runs/run-1/events' || path === '/runs/run-1/permissions') return [] as never;
      if (path === '/runs/run-1/tools') return { tools: [] } as never;
      if (path === '/runs/run-1/recovery') return { runId: 'run-1', taskId: null, runStatus: 'DONE', recovery: null } as never;
      return {
        id: 'run-1', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'DONE', taskId: 'task-1', epicId: null,
        triggerReason: 'DEVELOPMENT', startedAt: null, endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      } as never;
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Артефакты запуска' })).toBeInTheDocument();
    const item = within(screen.getByRole('region', { name: 'Артефакты запуска' })).getByRole('listitem');
    expect(item).toHaveTextContent('test-report');
    expect(item).toHaveTextContent('text/plain');
    expect(item).toHaveTextContent('42 Б');
    expect(item).toHaveTextContent('a'.repeat(64));
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('guideline-1');
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('Задача · task-1');
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('b'.repeat(64));
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('a'.repeat(64));
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('c'.repeat(64));
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('d'.repeat(64));
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('23');
    expect(screen.getByRole('region', { name: 'Манифест контекста' })).toHaveTextContent('builder-v2');
    expect(screen.getByRole('note', { name: 'Предупреждение Local Mode' })).toHaveTextContent('не является OS sandbox');
    expect(get).toHaveBeenCalledWith('/runs/run-1/artifacts');
    expect(get).toHaveBeenCalledWith('/runs/run-1/context-manifests');
    expect(get).toHaveBeenCalledWith('/settings');
    expect(screen.queryByText(/private|contents|raw output/i)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('uses the run projection and requests its supported read subresources', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({
      id: 'run-1', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'IN_PROGRESS', taskId: 'task-1', epicId: null,
      triggerReason: 'DEVELOPMENT', startedAt: '2026-09-20T00:00:00.000Z', endedAt: null,
      usage: { inputTokens: 1, cachedTokens: 2, outputTokens: 3, cost: 0.42 },
    });

    render(<MemoryRouter><AgentRunPage id="run-1" /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Запуск агента: run-1' })).toBeInTheDocument();
    expect(screen.getByText('Разработка')).toBeInTheDocument();
    expect(screen.queryByText('DEVELOPMENT')).not.toBeInTheDocument();
    expect(screen.getByText('$0.4200')).toBeInTheDocument();
    // Page makes calls for run, events, tools, permissions, recovery, artifacts, and context manifests.
    expect(get.mock.calls.filter(([path]) => path.startsWith('/runs/run-1'))).toHaveLength(7);
    expect(get).toHaveBeenCalledWith('/runs/run-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.restoreAllMocks();
  });

  test('requests and displays explicit unavailable provenance for a request-bound run', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-2/context-manifests') return { availability: 'unavailable', runId: 'run-2', subject: { type: 'REQUEST', id: 'request-2' }, role: 'coordinator', reason: 'LEGACY_PROVENANCE_UNAVAILABLE' } as never;
      if (path === '/runs/run-2/artifacts' || path === '/runs/run-2/events' || path === '/runs/run-2/permissions') return [] as never;
      if (path === '/runs/run-2/tools') return { tools: [] } as never;
      if (path === '/runs/run-2/recovery') return { runId: 'run-2', taskId: null, runStatus: 'DONE', recovery: null } as never;
      return {
        id: 'run-2', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'DONE', taskId: null, epicId: null,
        triggerReason: 'REQUESTED', startedAt: null, endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      } as never;
    });

    render(<MemoryRouter><AgentRunPage id="run-2" /></MemoryRouter>);

    const manifest = await screen.findByRole('region', { name: 'Манифест контекста' });
    expect(manifest).toHaveTextContent('Запрос · request-2');
    expect(manifest).toHaveTextContent('request-2');
    expect(manifest).toHaveTextContent('Для этой исторической записи provenance не сохранялась.');
    expect(get).toHaveBeenCalledWith('/runs/run-2/context-manifests');
    expect(get).not.toHaveBeenCalledWith('/settings');
    expect(screen.queryByRole('note', { name: 'Предупреждение Local Mode' })).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  test('does not synthesize a manifest when a task-bound run has no persisted row', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-3/context-manifests') return { availability: 'unavailable', runId: 'run-3', subject: { type: 'TASK', id: 'task-3' }, role: 'developer', reason: 'LEGACY_PROVENANCE_UNAVAILABLE' } as never;
      if (path === '/runs/run-3/artifacts' || path === '/runs/run-3/events' || path === '/runs/run-3/permissions') return [] as never;
      if (path === '/runs/run-3/tools') return { tools: [] } as never;
      if (path === '/runs/run-3/recovery') return { runId: 'run-3', taskId: 'task-3', runStatus: 'DONE', recovery: null } as never;
      if (path === '/settings') return { securitySettings: { localModeEnabled: false } } as never;
      return {
        id: 'run-3', role: 'Developer', runtime: 'hermes', model: 'gpt', status: 'DONE', taskId: 'task-3', epicId: null,
        triggerReason: 'REQUESTED', startedAt: null, endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      } as never;
    });

    render(<MemoryRouter><AgentRunPage id="run-3" /></MemoryRouter>);

    const manifest = await screen.findByRole('region', { name: 'Манифест контекста' });
    expect(manifest).toHaveTextContent('Для этой исторической записи provenance не сохранялась.');
    expect(get).toHaveBeenCalledWith('/runs/run-3/context-manifests');
    expect(manifest).not.toHaveTextContent('task-v');
    vi.restoreAllMocks();
  });

  test('renders Epic binding and keeps unknown availability explicit', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-epic/context-manifests') return { availability: 'future-state', runId: 'run-epic', subject: { type: 'EPIC', id: 'epic-7' }, role: 'architect', prompt: 'private ui prompt sentinel', runtimeInstructions: 'hidden ui prompt sentinel' } as never;
      if (path === '/runs/run-epic/artifacts' || path === '/runs/run-epic/events' || path === '/runs/run-epic/permissions') return [] as never;
      if (path === '/runs/run-epic/tools') return { tools: [] } as never;
      if (path === '/runs/run-epic/recovery') return { runId: 'run-epic', taskId: null, runStatus: 'DONE', recovery: null } as never;
      if (path === '/settings') return { securitySettings: { localModeEnabled: false } } as never;
      return {
        id: 'run-epic', role: 'Architect', runtime: 'hermes', model: 'gpt', status: 'DONE', taskId: null, epicId: 'epic-7',
        triggerReason: 'REQUESTED', startedAt: null, endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      } as never;
    });

    render(<MemoryRouter><AgentRunPage id="run-epic" /></MemoryRouter>);

    const manifest = await screen.findByRole('region', { name: 'Манифест контекста' });
    expect(manifest).toHaveTextContent('Эпик · epic-7');
    expect(manifest).toHaveTextContent('epic-7');
    expect(manifest).toHaveTextContent('Неизвестный статус манифеста');
    expect(manifest).not.toHaveTextContent('future-state');
    expect(manifest).not.toHaveTextContent('private ui prompt sentinel');
    expect(manifest).not.toHaveTextContent('hidden ui prompt sentinel');
    expect(get).toHaveBeenCalledWith('/runs/run-epic/context-manifests');
    vi.restoreAllMocks();
  });

  test('renders available Epic provenance metadata', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-epic-available/context-manifests') return {
        availability: 'available', id: 'manifest-epic', runId: 'run-epic-available',
        subject: { type: 'EPIC', id: 'epic-available' }, role: 'architect',
        contractRequestDigest: 'a'.repeat(64),
        items: [{ id: 'epic-guideline', version: 4, digest: 'b'.repeat(64) }],
        promptHash: 'c'.repeat(64), contextHash: 'd'.repeat(64), contextBuilderVersion: 'builder-epic-v2', initialTokenSize: 321,
      } as never;
      if (path === '/runs/run-epic-available/artifacts' || path === '/runs/run-epic-available/events' || path === '/runs/run-epic-available/permissions') return [] as never;
      if (path === '/runs/run-epic-available/tools') return { tools: [] } as never;
      if (path === '/runs/run-epic-available/recovery') return { runId: 'run-epic-available', taskId: null, runStatus: 'DONE', recovery: null } as never;
      if (path === '/settings') return { securitySettings: { localModeEnabled: false } } as never;
      return {
        id: 'run-epic-available', role: 'Architect', runtime: 'hermes', model: 'gpt', status: 'DONE', taskId: null, epicId: 'epic-available',
        triggerReason: 'REQUESTED', startedAt: null, endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      } as never;
    });

    render(<MemoryRouter><AgentRunPage id="run-epic-available" /></MemoryRouter>);

    const manifest = await screen.findByRole('region', { name: 'Манифест контекста' });
    expect(manifest).toHaveTextContent('Сохранённая provenance доступна.');
    expect(manifest).toHaveTextContent('run-epic-available');
    expect(manifest).toHaveTextContent('Эпик · epic-available');
    expect(manifest).toHaveTextContent('manifest-epic');
    expect(manifest).toHaveTextContent('architect');
    expect(manifest).toHaveTextContent('epic-guideline');
    expect(manifest).toHaveTextContent('4');
    expect(manifest).toHaveTextContent('b'.repeat(64));
    expect(manifest).toHaveTextContent('a'.repeat(64));
    expect(manifest).toHaveTextContent('c'.repeat(64));
    expect(manifest).toHaveTextContent('d'.repeat(64));
    expect(manifest).toHaveTextContent('builder-epic-v2');
    expect(manifest).toHaveTextContent('Точный размер контекста: 321');
    expect(get).toHaveBeenCalledWith('/runs/run-epic-available/context-manifests');
    vi.restoreAllMocks();
  });

  test('renders valid-empty Request provenance separately from unknown token size', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (path) => {
      if (path === '/runs/run-request/context-manifests') return {
        availability: 'available', id: 'manifest-request', runId: 'run-request', subject: { type: 'REQUEST', id: 'request-9' }, role: 'product_manager',
        contractRequestDigest: null, items: [], promptHash: 'a'.repeat(64), contextHash: 'b'.repeat(64), contextBuilderVersion: 'builder-v9', initialTokenSize: null,
      } as never;
      if (path === '/runs/run-request/artifacts' || path === '/runs/run-request/events' || path === '/runs/run-request/permissions') return [] as never;
      if (path === '/runs/run-request/tools') return { tools: [] } as never;
      if (path === '/runs/run-request/recovery') return { runId: 'run-request', taskId: null, runStatus: 'DONE', recovery: null } as never;
      return {
        id: 'run-request', role: 'Product Manager', runtime: 'hermes', model: 'gpt', status: 'DONE', taskId: null, epicId: null,
        triggerReason: 'REQUESTED', startedAt: null, endedAt: null,
        usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 },
      } as never;
    });

    render(<MemoryRouter><AgentRunPage id="run-request" /></MemoryRouter>);

    const manifest = await screen.findByRole('region', { name: 'Манифест контекста' });
    expect(manifest).toHaveTextContent('Запрос · request-9');
    expect(manifest).toHaveTextContent('Выбранных элементов контекста нет.');
    expect(manifest).toHaveTextContent('Не измерен');
    expect(manifest).not.toHaveTextContent('private prompt sentinel');
    expect(get).toHaveBeenCalledWith('/runs/run-request/context-manifests');
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

    const button = await screen.findByRole('button', { name: 'Отменить запуск' });
    fireEvent.click(button);
    expect(await screen.findByText('Не удалось отменить запуск: Не удалось выполнить запрос.')).toBeInTheDocument();
    expect(button).not.toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
