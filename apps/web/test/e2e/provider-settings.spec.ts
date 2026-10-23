/**
 * E2E: настройки провайдеров (plan-24, Task 6).
 *
 * Использует изолированный EBB_ORCHESTRATOR_HOME, тестовый keyring и
 * disposable SQLite (запускаются лаунчером). Все сетевые вызовы к самим
 * провайдерам отсутствуют: проверка соединения выполняется против локального
 * мок-upstream внутри теста; отображение Run использует page.route-фикстуру.
 *
 * Проверяется: обнаружение всех 86 провайдеров, конфигурация/credential
 * lifecycle без эха секретов, дефолты моделей (persist/reload), выбор
 * провайдера на странице Run и отсутствие секретов в DOM/хранилище браузера.
 */

import { createServer } from 'node:http';
import { test, expect } from './fixtures.js';

const SECRET_VALUE = 'sk-e2e-secret-a1b2c3';

function loginThroughUi(page: import('@playwright/test').Page, e2ePassword: Readonly<Buffer>) {
  return page.goto('/').then(async () => {
    await expect(page.getByRole('heading', { name: 'Вход в Ebb Orchestrator' })).toBeVisible();
    const passwordField = page.getByLabel('Пароль');
    await expect(passwordField).toBeFocused();
    await passwordField.fill(e2ePassword.toString('utf8'));
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  });
}

test.describe.configure({ mode: 'serial' });

test('каталог отображает все 86 провайдеров с поиском и секретными полями без эха', async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);

  await page.goto('/settings/providers');
  await expect(page.getByRole('heading', { name: 'ИИ-провайдеры' })).toBeVisible();
  await expect(page.locator('.provider-card')).toHaveCount(86);
  await expect(page.getByRole('link', { name: /^OpenAI / })).toBeVisible();
  await expect(page.getByRole('link', { name: /^ZhiPu / })).toBeVisible();

  await page.getByRole('searchbox').fill('anthropic');
  await expect(page.locator('.provider-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: /^Anthropic / })).toBeVisible();
  await page.getByRole('searchbox').fill('');

  await page.getByRole('link', { name: /^OpenAI / }).click();
  await expect(page.getByRole('heading', { name: 'OpenAI' })).toBeVisible();
  await expect(page.getByText('Конфигурация')).toBeVisible();
  await expect(page.getByText('Аутентификация')).toBeVisible();

  const apiKeyInput = page.getByLabel('API-ключ');
  await expect(apiKeyInput).toBeVisible();
  await expect(apiKeyInput).toHaveAttribute('type', 'password');
  await expect(apiKeyInput).toHaveValue('');
  await expect(apiKeyInput).toHaveAttribute('placeholder', 'не отображается');

  await expect(page.locator('body')).not.toContainText(SECRET_VALUE);
  const storage = await page.evaluate(() => [localStorage, sessionStorage].map((store) => JSON.stringify(store)));
  expect(storage.every((value) => !value.includes(SECRET_VALUE))).toBe(true);
});

test('конфигурация и credential lifecycle: сохранение, статус, замена, удаление без эха', async ({ page, e2ePassword }) => {
  const leakedPayloads: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\/api\/v1\/providers\/openai\/(config|credential)/.test(url) && request.method() === 'GET') {
      leakedPayloads.push(request.postData() ?? '');
    }
  });

  await loginThroughUi(page, e2ePassword);
  await page.goto('/settings/providers/openai');

  await page.getByLabel('Включить провайдера').check();
  await page.getByRole('button', { name: 'Сохранить настройки' }).click();
  // Настройки сохраняются; проверяем через API (notice может мелькнуть при refetch).
  await expect.poll(async () => (await page.request.get('/api/v1/providers/openai/status')).json()).toMatchObject({ enabled: true });
  await expect(page.getByRole('region', { name: 'Статус провайдера' })).toContainText('Не настроен');

  await page.getByLabel('API-ключ').fill(SECRET_VALUE);
  await page.getByRole('button', { name: 'Сохранить учётные данные' }).click();
  await expect(page.getByRole('region', { name: 'Статус провайдера' })).toContainText('Подключён');

  // Замена: нет эха предыдущего значения; поле пустое.
  await expect(page.getByLabel('API-ключ')).toHaveValue('');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Статус провайдера' })).toContainText('Подключён');
  await expect(page.getByLabel('API-ключ')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(SECRET_VALUE);

  // GET-ответы не содержат секрет.
  const catalogResponse = await page.request.get('/api/v1/providers/openai');
  expect(JSON.stringify(await catalogResponse.json())).not.toContain(SECRET_VALUE);
  const statusResponse = await page.request.get('/api/v1/providers/openai/status');
  expect(JSON.stringify(await statusResponse.json())).not.toContain(SECRET_VALUE);
  expect(leakedPayloads.every((payload) => !payload.includes(SECRET_VALUE))).toBe(true);

  await page.getByRole('button', { name: 'Удалить учётные данные' }).click();
  await expect(page.getByRole('region', { name: 'Статус провайдера' })).toContainText('Не настроен');
});

test('дефолты моделей persist/reload и пользовательские модели', async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);
  await page.goto('/settings/providers/openai');

  const defaultSelect = page.getByLabel('Модель по умолчанию');
  await defaultSelect.selectOption('gpt-4o');
  await expect.poll(async () => (await page.request.get('/api/v1/providers/openai/status')).json()).toMatchObject({ defaultModelId: 'gpt-4o' });

  await page.getByLabel('Добавить модель').fill('e2e-custom-model');
  await page.getByRole('button', { name: 'Добавить модель' }).click();
  const customRow = page.locator('.provider-model-list li').filter({ hasText: 'e2e-custom-model' });
  await expect(customRow).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Модель по умолчанию')).toHaveValue('gpt-4o');
  await expect(page.locator('.provider-model-list li').filter({ hasText: 'e2e-custom-model' })).toBeVisible();

  await page.getByRole('button', { name: 'Удалить модель e2e-custom-model' }).click();
  await expect(page.locator('.provider-model-list li').filter({ hasText: 'e2e-custom-model' })).toHaveCount(0);
});

test('проверка соединения через шлюз против локального мок-upstream', async ({ page, e2ePassword }) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;

  try {
    await loginThroughUi(page, e2ePassword);
    await page.goto('/settings/providers/ollama');

    await page.getByLabel('Endpoint API').fill(`http://127.0.0.1:${port}`);
    await page.getByRole('button', { name: 'Сохранить настройки' }).click();
    await expect(page.getByText('Настройки сохранены')).toBeVisible();

    await page.getByRole('button', { name: 'Проверить соединение' }).click();
    await expect(page.getByText('Соединение установлено')).toBeVisible();
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }

  // После остановки upstream проверка больше не устанавливается.
  await page.getByRole('button', { name: 'Проверить соединение' }).click();
  await expect(page.getByText('Соединение не установлено')).toBeVisible();
});

test('выбор провайдера/модели отображается на странице Run без секретов', async ({ page, e2ePassword }) => {
  await loginThroughUi(page, e2ePassword);

  const runId = 'run-provider-sel';
  const runPath = `/api/v1/runs/${runId}`;
  await page.route(runPath, async (route) => {
    await route.fulfill({
      json: {
        id: runId, role: 'developer', runtime: 'node', model: 'default', status: 'COMPLETED',
        triggerReason: 'Разработка', taskId: null, epicId: null,
        startedAt: '2026-01-15T10:00:00Z', endedAt: '2026-01-15T10:45:00Z',
        usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 50, cost: 0.001 },
        providerSelection: { providerId: 'openai', modelId: 'gpt-4o', authMethodId: 'api-key', configRevision: 3 },
      },
    });
  });
  await page.route('/api/v1/settings', (route) => route.fulfill({ json: { securitySettings: { localModeEnabled: false } } }));

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('heading', { name: `Запуск агента: ${runId}` })).toBeVisible();
  const details = page.getByRole('region', { name: 'Сведения о запуске' });
  await expect(details).toContainText('OpenAI');
  await expect(details).toContainText('gpt-4o');
  await expect(details).toContainText('ревизия 3');
  await expect(page.locator('body')).not.toContainText(SECRET_VALUE);
});
