import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function bootstrapToken(): string {
  const path = resolve(import.meta.dirname, '.playwright', 'bootstrap.json');
  return JSON.parse(readFileSync(path, 'utf8')).bootstrapToken as string;
}
test('v1 UI exposes the persistent navigation shell', async ({ page }) => {
  await page.route('**/api/v1/session/bootstrap', async (route) => {
    await route.fulfill({ json: { sessionToken: 'session', csrfToken: 'csrf' } });
  });
  await page.goto('/#ebb-bootstrap=session-bootstrap');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Execution' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Usage' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
});

test('v1 UI restores its local session after a browser reload', async ({ page }) => {
  let restores = 0;
  await page.route('**/api/v1/session/bootstrap', async (route) => {
    await route.fulfill({ json: { sessionToken: 'session', csrfToken: 'csrf' } });
  });
  await page.route('**/api/v1/session', async (route) => {
    restores += 1;
    await route.fulfill({ json: { csrfToken: 'restored-csrf' } });
  });

  await page.goto('/#ebb-bootstrap=session-bootstrap');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await page.reload();

  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  expect(restores).toBe(1);
});

test('v1 UI bootstraps against the launched backend', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:3001/api/v1/health');
  expect(health.ok()).toBe(true);

  await page.goto(`/#ebb-bootstrap=${encodeURIComponent(bootstrapToken())}`);
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
