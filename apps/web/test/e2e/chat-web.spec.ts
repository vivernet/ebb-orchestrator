/**
 * Web E2E чата координатора и ключевых экранов (plan-25 Task 7).
 *
 * Работает против РЕАЛЬНОГО production-бэкенда, который поднимается
 * `chat-run-e2e.mjs` (EBB_E2E_CHAT_FULLSTACK=1 + EBB_E2E_ATTACH_*).
 * Без fullstack-окружения весь describe пропускается, чтобы штатный
 * `pnpm test:e2e` оставался зелёным.
 *
 * Сценарии:
 *  - Dashboard: чат с историей и cursor-пагинация («Загрузить раньше»);
 *  - отправка текста через Composer → пузырь пользователя;
 *  - планирование → зеркало RECEIVED («Принято») через SSE + восстановление
 *    после reload (реконнект);
 *  - полная прогрессия до MATERIALIZED (opt-in, реальный Hermes);
 *  - ключевые экраны: Settings-редактирование, вкладки TaskPage.
 */
import { test, expect } from "./fixtures.js";

const fullstack = process.env.EBB_E2E_CHAT_FULLSTACK === "1";
const liveMarker = process.env.EBB_RUN_CHAT_HERMES_ACCEPTANCE === "I_UNDERSTAND_THIS_SENDS_REAL_PROVIDER_REQUESTS";

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

async function cancelPlanningJob(requestId: string): Promise<void> {
  const dbPath = process.env.EBB_E2E_CHAT_BACKEND_DB;
  if (!dbPath) return;
  const { createSqliteDatabase } = await import('../../../server/dist/platform/database/sqlite-database.js');
  const database = createSqliteDatabase(dbPath);
  try {
    database.run(
      `UPDATE background_jobs SET status='CANCELLED', updated_at=$now
       WHERE type='coordinator.planning' AND payload_json LIKE $match AND status IN ('QUEUED','RETRY_WAIT')`,
      { match: `%${requestId}%`, now: new Date().toISOString() },
    );
  } finally {
    database.close();
  }
}

test.describe.configure({ mode: 'serial' });

const chatSuite = () => {
  let conversationId = '';
  let projectId = '';

  async function resolveChatIds(page: import('@playwright/test').Page): Promise<void> {
    if (projectId && conversationId) return;
    const dashboard = await page.request.get('/api/v1/dashboard');
    expect(dashboard.status()).toBe(200);
    const body = await dashboard.json() as { projects: Array<{ id: string }> };
    expect(body.projects.length).toBeGreaterThan(0);
    projectId = body.projects[0]!.id;
    const conversations = await (await page.request.get(`/api/v1/projects/${projectId}/conversations`)).json() as { conversations: Array<{ id: string }> };
    expect(conversations.conversations.length).toBeGreaterThan(0);
    conversationId = conversations.conversations[0]!.id;
  }

  test('Dashboard показывает чат с историей; cursor-пагинация по API покрывает всю историю', async ({ page, e2ePassword }) => {
    await loginThroughUi(page, e2ePassword);
    await resolveChatIds(page);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();
    const chat = page.locator('section.chat-panel');
    await expect(chat).toBeVisible();

    const log = chat.getByRole('log');
    await expect(log).toBeVisible();
    await expect(log.locator('.thread-msg').first()).toBeVisible();
    const count = await log.locator('.thread-msg').count();
    expect(count).toBe(50); // страница по умолчанию: 50 самых новых

    // cursor-пагинация через реальный API (тот же путь, что использует UI-фича).
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const suffix = cursor === null ? 'limit=50' : `limit=50&cursor=${encodeURIComponent(cursor)}&direction=older`;
      const response = await page.request.get(`/api/v1/conversations/${conversationId}/messages?${suffix}`);
      expect(response.status()).toBe(200);
      const body = await response.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      for (const item of body.items) collected.push(item.id);
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.length).toBe(60);
  });

  test('отправка текста через Composer добавляет пузырь пользователя', async ({ page, e2ePassword }) => {
    await loginThroughUi(page, e2ePassword);
    await page.goto('/');
    const chat = page.locator('section.chat-panel');
    await expect(chat.getByRole('log')).toBeVisible();

    await chat.getByLabel('Как запрос планирования').uncheck();
    await chat.getByLabel('Сообщение координатору…').fill('простой текст от пользователя');
    await chat.getByRole('button', { name: 'Отправить' }).click();

    const bubble = chat.getByRole('log').locator('.thread-msg--user').filter({ hasText: 'простой текст от пользователя' });
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveAttribute('data-role', 'user');
  });

  test('планирование: 202 с planning + зеркало RECEIVED через SSE и восстановление после реконнекта', async ({ page, e2ePassword }) => {
    await loginThroughUi(page, e2ePassword);
    await resolveChatIds(page);
    await page.goto('/');
    const chat = page.locator('section.chat-panel');
    await expect(chat.getByRole('log')).toBeVisible();

    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith(`/api/v1/conversations/${conversationId}/messages`) && response.request().method() === 'POST');
    await chat.getByLabel('Сообщение координатору…').fill('Спланируй эпик с двумя задачами для e2e');
    await chat.getByRole('button', { name: 'Отправить' }).click();

    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const sendBody = await response.json() as { message: { id: string }; planning?: { requestId: string; status: string } };
    expect(sendBody.message.id).toBeTruthy();
    expect(sendBody.planning?.status).toBe('RECEIVED');
    expect(sendBody.planning?.requestId).toBeTruthy();
    await cancelPlanningJob(sendBody.planning!.requestId);

    // Зеркало RECEIVED приходит из outbox→bus→SSE.
    const received = chat.getByRole('log').locator('.thread-status').filter({ hasText: 'Принято' }).first();
    await expect(received).toBeVisible({ timeout: 30_000 });

    // Реконнект (reload) восстанавливает историю из API.
    await page.reload();
    const chatAfterReload = page.locator('section.chat-panel');
    await expect(chatAfterReload.getByRole('log').locator('.thread-status').filter({ hasText: 'Принято' }).first()).toBeVisible();
  });

  test('Settings: редактирование глобального максимума планировщика', async ({ page, e2ePassword }) => {
    await loginThroughUi(page, e2ePassword);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();

    await page.getByRole('button', { name: 'Изменить' }).click();
    const globalMax = page.locator('#settings-global-max');
    await expect(globalMax).toBeVisible();
    await globalMax.fill('2');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Настройки сохранены' })).toBeVisible();

    // Пересохраняем проекцию: форма редактирования показывает сохранённое значение.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();
    await page.getByRole('button', { name: 'Изменить' }).click();
    await expect(page.locator('#settings-global-max')).toHaveValue('2');
  });

  test('TaskPage: вкладки задачи переключаются', async ({ page, e2ePassword }) => {
    await loginThroughUi(page, e2ePassword);
    await resolveChatIds(page);
    const project = await (await page.request.get(`/api/v1/projects/${projectId}`)).json() as { tasks: Array<{ id: string }> };
    expect(project.tasks.length).toBeGreaterThan(0);
    const taskId = project.tasks[0]!.id;

    await page.goto(`/tasks/${taskId}`);
    const tablist = page.getByRole('tablist', { name: 'Разделы задачи' });
    await expect(tablist).toBeVisible();

    for (const label of ['Обзор', 'Контракт', 'Запуски', 'Review', 'QA', 'Git', 'Использование']) {
      const tab = tablist.getByRole('tab', { name: label });
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
  });

  if (liveMarker) {
  test('полная прогрессия до MATERIALIZED: одобрение плана в чате (opt-in реальный Hermes)', async ({ page, e2ePassword }) => {
    await loginThroughUi(page, e2ePassword);
    await resolveChatIds(page);
    await page.goto('/');
      const chat = page.locator('section.chat-panel');
      await expect(chat.getByRole('log')).toBeVisible();

      const responsePromise = page.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/conversations/${conversationId}/messages`) && response.request().method() === 'POST');
      await chat.getByLabel('Сообщение координатору…').fill('Build an Epic with exactly two required Developer Tasks using standard workflow');
      await chat.getByRole('button', { name: 'Отправить' }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(202);

      // Ждём approval_request и одобряем в UI.
      const approveButton = chat.getByRole('button', { name: 'Одобрить' }).first();
      await expect(approveButton).toBeVisible({ timeout: 600_000 });
      await approveButton.click();

      const materialized = chat.getByRole('log').locator('.thread-status').filter({ hasText: 'Материализовано' }).first();
      await expect(materialized).toBeVisible({ timeout: 300_000 });
    });
  }
};

if (fullstack) {
  test.describe('чат и ключевые экраны (real production session + fullstack)', chatSuite);
} else {
  test.describe.skip('чат и ключевые экраны (fullstack окружение недоступно)', chatSuite);
}

