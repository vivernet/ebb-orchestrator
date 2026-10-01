import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect } from 'node:net';
import { test, expect } from './fixtures.js';

function controlRequest(command: 'restart' | 'stop' | 'start') {
  const endpoint = process.env.EBB_E2E_CONTROL_CHANNEL;
  if (!endpoint) throw Object.assign(new Error('MISSING_ENDPOINT'), { code: 'MISSING_ENDPOINT' });
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint);
  if (!match || Number(match[1]) > 65535) throw Object.assign(new Error('MALFORMED_ENDPOINT'), { code: 'MALFORMED_ENDPOINT' });
  const requestId = randomUUID();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(match[1]) });
    let body = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('CONTROL_TIMEOUT'), { code: 'CONTROL_TIMEOUT' }));
    }, 5_000);
    socket.once('connect', () => socket.write(`${JSON.stringify({ command, requestId })}\n`));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { body += chunk; });
    socket.once('end', () => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(body.trim()) as Record<string, unknown>;
        if (result.requestId !== requestId) throw new Error('CONTROL_REQUEST_MISMATCH');
        resolve(result);
      } catch (error) { reject(error); }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function restartE2EBackend() {
  return controlRequest('restart');
}

async function assertHealth(request: import('@playwright/test').APIRequestContext, page: import('@playwright/test').Page) {
  const response = await request.get('/api/v1/health');
  expect(response.status()).toBe(200);
  await expect(response).toBeOK();
  expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
  expect(await response.json()).toEqual({ status: 'ok', lifecycle: 'READY' });
}

async function loginThroughUi(page: import('@playwright/test').Page, e2ePassword: Readonly<Buffer>) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Вход в Ebb Orchestrator' })).toBeVisible();
  const passwordField = page.getByLabel('Пароль');
  await expect(passwordField).toBeFocused();
  await passwordField.fill(e2ePassword.toString('utf8'));
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
}

async function assertNoBootstrapArtifacts(page: import('@playwright/test').Page) {
  const location = await page.evaluate(() => ({ hash: window.location.hash, search: window.location.search, href: window.location.href }));
  expect(location.hash).toBe('');
  expect(location.search).toBe('');
  expect(location.href).not.toMatch(/bootstrap|token/i);
  expect(existsSync(resolve(import.meta.dirname, '.playwright', ['bootstrap', 'json'].join('.')))).toBe(false);
  const storage = await page.evaluate(() => [localStorage, sessionStorage].map((store) => JSON.stringify(store)));
  expect(storage.every((value) => !/(bearer|password|csrf.?token|session.?token|bootstrap)/i.test(value))).toBe(true);
}

test('real browser login and logout use cookie auth and keyboard-accessible Russian navigation', async ({ page, e2ePassword }) => {
  const restore = await page.request.get('/api/v1/session');
  expect(restore.status()).toBe(401);
  await expect(page.context().cookies()).resolves.toEqual([]);

  await loginThroughUi(page, e2ePassword);
  await assertNoBootstrapArtifacts(page);
  await assertHealth(page.request, page);

  const navigation = page.getByRole('navigation', { name: 'Основная навигация' });
  for (const label of ['Обзор', 'Проекты', 'Согласования', 'Выполнение', 'Использование', 'Настройки']) {
    await expect(navigation.getByRole('link', { name: label })).toBeVisible();
  }
  await expect(page.getByRole('navigation', { name: 'Навигационная цепочка' })).toContainText('Обзор');
  const dashboard = navigation.getByRole('link', { name: 'Обзор' });
  const projects = navigation.getByRole('link', { name: 'Проекты' });
  await page.getByRole('button', { name: 'Выйти' }).focus();
  await page.keyboard.press('Tab');
  await expect(dashboard).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(projects).toBeFocused();

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('heading', { name: 'Вход в Ebb Orchestrator' })).toBeVisible();
  expect((await page.request.get('/api/v1/session')).status()).toBe(401);
  await assertNoBootstrapArtifacts(page);
});

test('localized route errors, loading and empty states render through the dynamic frontend baseURL', async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  await assertHealth(page.request, page);

  await page.goto('/missing-route-for-e2e');
  await expect(page.getByRole('heading', { name: 'Страница не найдена' })).toBeVisible();
  await expect(page.getByText('Запрошенный маршрут отсутствует в этой системе управления.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Вернуться к обзору' })).toBeVisible();

  await page.route('**/api/v1/dashboard', async (route) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    await route.fulfill({ json: { projects: [] } });
  });
  await page.goto('/projects');
  await expect(page.getByRole('status').filter({ hasText: 'Загрузка проектов…' })).toBeVisible();
  await expect(page.getByText('Проектов пока нет.')).toBeVisible();

  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({ json: { projects: {} } });
  });
  await page.goto('/projects');
  await expect(page.getByText('Ошибка маршрута')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Не удалось безопасно отобразить эту страницу.' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/api/v1/dashboard');

  const projectResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/projects/missing-project'));
  await page.goto('/projects/missing-project');
  const projectResponse = await projectResponsePromise;
  expect(projectResponse.status()).toBe(200);
  expect((await projectResponse.json()).project).toBeNull();
  await expect(page.getByRole('heading', { name: 'Проект: missing-project' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Проект не найден.' })).toBeVisible();
  await assertNoBootstrapArtifacts(page);
});

test('authenticated browser shows empty Dashboard, Approvals, Execution and the real missing-run error', async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  await assertHealth(page.request, page);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Работающие агенты' })).toContainText('Нет работающих агентов.');
  await expect(page.getByRole('region', { name: 'Активная работа' })).toContainText('Нет активной работы.');
  await expect(page.getByRole('region', { name: 'Очередь' })).toContainText('Очередь пуста.');

  const missingEpicResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/epics/missing-epic'));
  await page.goto('/epics/missing-epic');
  expect((await missingEpicResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Эпик: missing-epic' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Эпик не найден.' })).toBeVisible();

  const missingTaskResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/tasks/missing-task'));
  await page.goto('/tasks/missing-task');
  expect((await missingTaskResponse).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Задача: missing-task' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Задача не найдена.' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Навигационная цепочка' })).toContainText('Задача missing-task');
  await expect(page.getByRole('alert').filter({ hasText: 'Задача не найдена.' })).toBeVisible();

  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: 'Входящие согласования' })).toBeVisible();
  await expect(page.getByText('Нет согласований, ожидающих решения.')).toBeVisible();

  await page.goto('/execution');
  await expect(page.getByRole('heading', { name: 'Монитор выполнения' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Очередь выполнения' })).toContainText('Нет активных, ожидающих или заблокированных задач.');
  await expect(page.getByRole('button', { name: /Приостановить всё|Pause All/ })).toHaveCount(0);

  const missingRunResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/runs/missing-run'));
  await page.goto('/runs/missing-run');
  expect((await missingRunResponse).status()).toBe(404);
  await expect(page.getByText(/Не удалось загрузить запуск агента:/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();

  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Использование' })).toBeVisible();
  await expect(page.getByText('Нет данных об использовании, лимитов бюджета или активных резервирований.')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Глобально' })).toBeVisible();
  await expect(page.getByText(/Недоступно:/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Сохранить|Изменить|Обновить/ })).toHaveCount(0);
  await assertNoBootstrapArtifacts(page);
});

test('authenticated Chromium renders all populated Agent Run sections from run projections', async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  await assertHealth(page.request, page);
  expect((await page.request.get('/api/v1/session')).status()).toBe(200);

  const runId = 'run-123';
  const runPath = `/api/v1/runs/${runId}`;
  const requested = new Set<string>();
  const projections: Record<string, unknown> = {
    [runPath]: {
      id: runId, role: 'Code Reviewer', runtime: 'node', model: 'gpt-4.1', status: 'COMPLETED',
      triggerReason: 'Pull request review', taskId: 'task-456', epicId: null,
      startedAt: '2026-01-15T10:00:00Z', endedAt: '2026-01-15T10:45:00Z',
      usage: { inputTokens: 5000, cachedTokens: 1000, outputTokens: 2000, cost: 0.0125 },
    },
    [`${runPath}/events`]: [
      { id: 'evt-1', type: 'run_started', createdAt: '2026-01-15T10:00:00Z' },
      { id: 'evt-2', type: 'tool_used', createdAt: '2026-01-15T10:15:00Z' },
    ],
    [`${runPath}/tools`]: { runId, tools: ['git', 'file_read', 'code_review'] },
    [`${runPath}/permissions`]: [
      { id: 'aud-1', action: 'read_code', actor: 'system', aggregateType: 'AgentRun', aggregateId: runId, createdAt: '2026-01-15T10:10:00Z', details: {} },
    ],
    [`${runPath}/recovery`]: {
      runId, taskId: 'task-456', runStatus: 'COMPLETED', recovery: {
        attempts: [{ id: 'rec-1', roleLevel: 'level-2', failureType: 'timeout', attemptCount: 1, timestamp: '2026-01-15T10:20:00Z', fingerprint: null }],
        schedulerRequests: [],
        state: { id: 'rec-state-1', status: 'resolved', reason: 'recovered after timeout', createdAt: '2026-01-15T10:21:00Z', updatedAt: '2026-01-15T10:25:00Z' },
      },
    },
    [`${runPath}/artifacts`]: [
      {
        id: 'artifact-1', type: 'test-report', contentType: 'text/plain', sizeBytes: 128,
        sha256: 'a'.repeat(64), status: 'ACTIVE', createdAt: '2026-01-15T10:30:00Z',
      },
    ],
    [`${runPath}/context-manifests`]: {
        availability: 'available', id: 'manifest-1', runId, subject: { type: 'TASK', id: 'task-456' }, role: 'developer',
        contractRequestDigest: 'b'.repeat(64), items: [{ id: 'guideline-1', version: 3, digest: 'c'.repeat(64) }],
        promptHash: 'd'.repeat(64), contextHash: 'e'.repeat(64), contextBuilderVersion: 'builder-v2', initialTokenSize: null,
    },
  };
  // The launcher has no run-seeding API: only the run read projections are supplied here.
  // Auth, session restoration, UI delivery and unrelated API requests still use the live backend.
  await page.route(/\/api\/v1\/runs\/run-123(?:\/(?:events|tools|permissions|recovery|artifacts|context-manifests))?$/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!Object.hasOwn(projections, pathname)) return route.continue();
    requested.add(pathname);
    await route.fulfill({ json: projections[pathname] });
  });
  await page.route(/\/api\/v1\/settings$/, async (route) => route.fulfill({
    json: { securitySettings: { localModeEnabled: true } },
  }));

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('heading', { name: `Запуск агента: ${runId}` })).toBeVisible();
  const details = page.getByRole('region', { name: 'Сведения о запуске' });
  await expect(details).toContainText('Code Reviewer');
  await expect(details).toContainText('gpt-4.1');
  await expect(page.getByRole('note', { name: 'Предупреждение Local Mode' })).toContainText('не является OS sandbox');
  await expect(page.getByRole('region', { name: 'Артефакты запуска' })).toContainText('test-report');
  const contextManifest = page.getByRole('region', { name: 'Манифест контекста' });
  await expect(contextManifest).toContainText('guideline-1');
  await expect(contextManifest).toContainText('Задача · task-456');
  await expect(contextManifest).toContainText('Не измерен');
  await expect(contextManifest).toContainText('builder-v2');
  await expect(page.getByRole('region', { name: 'Время запуска' })).toContainText('Завершение:');
  await expect(page.getByRole('region', { name: 'Использование запуска' })).toContainText('5000');
  await expect(page.getByRole('region', { name: 'События' })).toContainText('Запуск начат');
  await expect(page.getByRole('region', { name: 'Инструменты' })).toContainText('git');
  await expect(page.getByRole('region', { name: 'Разрешения' })).toContainText('Чтение кода');
  const recovery = page.getByRole('region', { name: 'Восстановление' });
  await expect(recovery.getByRole('heading', { name: 'Попытки восстановления' })).toBeVisible();
  await expect(recovery).toContainText('Тип ошибки недоступен');
  await expect(recovery).toContainText('Причина восстановления недоступна');
  await expect(recovery).not.toContainText('recovered after timeout');
  expect([...requested].sort()).toEqual(Object.keys(projections).sort());
  await assertNoBootstrapArtifacts(page);
});

async function assertAuthenticatedRestore(page: import('@playwright/test').Page) {
  const response = await page.request.get('/api/v1/session');
  expect(response.status()).toBe(200);
  const session = await response.json() as { csrfToken: string; expiresAt: string };
  expect(session.csrfToken).toBeTruthy();
  expect(Number.isNaN(Date.parse(session.expiresAt))).toBe(false);
  await page.goto('/');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  const storage = await page.evaluate(() => [localStorage, sessionStorage].map((store) => JSON.stringify(store)));
  expect(storage.every((value) => !/(bearer|password|csrf.?token|session.?token)/i.test(value))).toBe(true);
}

test('authenticated browser completes real onboarding and renders the populated Project view', async ({ page, e2ePassword }) => {
  const login = await page.request.post('/api/v1/session/login', {
    data: { password: e2ePassword.toString('utf8') },
  });
  expect(login.status()).toBe(200);
  await page.goto('/projects/new');

  await expect(page.getByRole('heading', { name: 'Настройка проекта' })).toBeVisible();
  await page.getByLabel('Путь к репозиторию').fill(resolve(process.cwd(), '../..'));
  const draftResponsePromise = page.waitForResponse((response) => response.url().includes('/api/v1/onboarding/discover') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Начать анализ' }).click();

  const draftResponse = await draftResponsePromise;
  expect(draftResponse.status()).toBe(201);
  const draft = await draftResponse.json();
  expect(draft.status).toBe('DRAFT');
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Черновик');
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText(draft.repository.path);
  expect((await (await page.request.get(`/api/v1/onboarding/${draft.projectId}`)).json()).status).toBe('DRAFT');

  const pendingResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/v1/onboarding/${draft.projectId}/approval`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Запросить согласование' }).click();
  const pending = await pendingResponsePromise;
  expect(pending.status()).toBe(201);
  const pendingProjection = await (await page.request.get(`/api/v1/onboarding/${draft.projectId}`)).json();
  expect(pendingProjection.status).toBe('APPROVAL_PENDING');
  expect(pendingProjection.approval.status).toBe('PENDING');
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Ожидает согласования');

  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: 'Входящие согласования' })).toBeVisible();
  const changesRequestedPromise = page.waitForResponse((response) => response.url().includes(`/api/v1/approvals/${pendingProjection.approval.id}/request-changes`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Запросить изменения' }).click();
  const changesRequested = await changesRequestedPromise;
  expect(changesRequested.status()).toBe(200);
  expect(await changesRequested.json()).toEqual({ status: 'CHANGES_REQUESTED' });
  await expect(page.getByText('Нет согласований, ожидающих решения.')).toBeVisible();
  await page.goto(`/onboarding/${draft.projectId}`);
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Черновик');
  expect((await (await page.request.get(`/api/v1/onboarding/${draft.projectId}`)).json()).status).toBe('DRAFT');
  const repeatedAfterChanges = page.waitForResponse((response) => response.url().includes(`/api/v1/onboarding/${draft.projectId}/approval`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Запросить согласование' }).click();
  const requestedAfterChanges = await repeatedAfterChanges;
  expect(requestedAfterChanges.status()).toBe(201);
  const projectionAfterChanges = await requestedAfterChanges.json();
  expect(projectionAfterChanges.approval.id).not.toBe(pendingProjection.approval.id);
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Ожидает согласования');

  await page.goto('/approvals');
  await page.getByRole('button', { name: 'Отклонить' }).click();
  await expect(page.getByText('Нет согласований, ожидающих решения.')).toBeVisible();
  await page.goto(`/onboarding/${draft.projectId}`);
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Черновик');
  expect((await (await page.request.get(`/api/v1/onboarding/${draft.projectId}`)).json()).status).toBe('DRAFT');
  const repeatedRequest = page.waitForResponse((response) => response.url().includes(`/api/v1/onboarding/${draft.projectId}/approval`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Запросить согласование' }).click();
  const requestedAfterRejection = await repeatedRequest;
  expect(requestedAfterRejection.status()).toBe(201);
  const projectionAfterRejection = await requestedAfterRejection.json();
  expect(projectionAfterRejection.approval.id).not.toBe(projectionAfterChanges.approval.id);
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Ожидает согласования');

  const approveResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/v1/onboarding/${draft.projectId}/approve`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Утвердить' }).click();
  const approved = await approveResponsePromise;
  expect(approved.status()).toBe(200);
  const approvedProjection = await (await page.request.get(`/api/v1/onboarding/${draft.projectId}`)).json();
  expect(approvedProjection.status).toBe('APPROVED');
  expect(approvedProjection.approval.status).toBe('APPROVED');
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Согласовано');

  const activateResponsePromise = page.waitForResponse((response) => response.url().includes(`/api/v1/onboarding/${draft.projectId}/activate`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Активировать' }).click();
  const activated = await activateResponsePromise;
  expect(activated.status()).toBe(200);
  const activeProjection = await (await page.request.get(`/api/v1/onboarding/${draft.projectId}`)).json();
  expect(activeProjection.status).toBe('ACTIVE');
  expect(activeProjection.approval.status).toBe('APPROVED');
  await expect(page.getByRole('region', { name: 'Результаты анализа' })).toContainText('Статус: Активно');

  const projectResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/v1/projects/${draft.projectId}`));
  await page.goto(`/projects/${encodeURIComponent(draft.projectId)}`);
  const projectResponse = await projectResponsePromise;
  expect(projectResponse.status()).toBe(200);
  const project = await projectResponse.json();
  expect(project.project).toMatchObject({ id: draft.projectId, status: 'ACTIVE' });
  expect(project.git.repositoryPath).toBe(resolve(process.cwd(), '../..'));

  await expect(page.getByRole('heading', { name: `Проект: ${project.project.displayName ?? project.project.name}` })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Сведения о проекте' })).toContainText('Активно');
  await expect(page.getByRole('region', { name: 'Репозиторий и GitHub' })).toContainText(project.git.repositoryPath);
  await expect(page.getByRole('region', { name: 'Эпики и задачи' })).toContainText('Эпиков нет.');
  await expect(page.getByRole('region', { name: 'Эпики и задачи' })).toContainText('Задач нет.');
  await expect(page.getByRole('navigation', { name: 'Навигационная цепочка' })).toContainText(project.project.id);
});

test('real cookie session survives backend restart and stop/start on the same durable database', async ({ page, e2ePassword }) => {
  const initialRestore = await page.request.get('/api/v1/session');
  expect(initialRestore.status()).toBe(401);
  await expect(page.context().cookies()).resolves.toEqual([]);

  const loginResponse = await page.request.post('/api/v1/session/login', {
    data: { password: e2ePassword.toString('utf8') },
  });
  expect(loginResponse.status()).toBe(200);
  const loginBody = await loginResponse.json() as { csrfToken: string; expiresAt: string };
  expect(loginBody.csrfToken).toBeTruthy();
  expect(Number.isNaN(Date.parse(loginBody.expiresAt))).toBe(false);
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'ebb_local_session' && cookie.httpOnly)).toBe(true);

  await page.goto('/');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await assertAuthenticatedRestore(page);
  await assertHealth(page.request, page);

  const restarted = await restartE2EBackend();
  expect(restarted.type).toBe('ready');
  await assertHealth(page.request, page);
  await page.reload();
  await assertAuthenticatedRestore(page);

  const stopped = await controlRequest('stop');
  expect(stopped.type).toBe('stopped');
  expect(stopped.lockAbsent).toBe(true);
  expect(typeof stopped.databasePath).toBe('string');
  const started = await controlRequest('start');
  expect(started.type).toBe('ready');
  expect(started.databasePath).toBe(stopped.databasePath);
  await assertHealth(page.request, page);
  await page.reload();
  await assertAuthenticatedRestore(page);
});
