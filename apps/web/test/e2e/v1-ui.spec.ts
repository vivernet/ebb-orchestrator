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
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Approvals' })).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Execution' })).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Usage' })).toBeVisible();
  await expect(primaryNavigation.getByRole('link', { name: 'Settings' })).toBeVisible();
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
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(primaryNavigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await page.reload();

  await expect(primaryNavigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  expect(restores).toBe(1);
});

test('v1 UI bootstraps against the launched backend', async ({ page, request }) => {
  const health = await request.get('http://127.0.0.1:3001/api/v1/health');
  expect(health.ok()).toBe(true);

  await page.goto(`/tasks/missing-task#ebb-bootstrap=${encodeURIComponent(bootstrapToken())}`);
  const primaryNavigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const breadcrumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(primaryNavigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(breadcrumbs).toContainText('Task missing-task');
  await expect(page.getByRole('heading', { name: 'Task: missing-task' })).toBeVisible();

  await page.reload();

  await expect(primaryNavigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(breadcrumbs).toContainText('Task missing-task');
  await expect(page.getByRole('heading', { name: 'Task: missing-task' })).toBeVisible();

  await page.goto('/');
  await expect(primaryNavigation.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('No running agents.')).toBeVisible();

  await page.goto('/projects/missing-project');
  await expect(page.getByRole('heading', { name: 'Project: missing-project' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Project not found.' })).toBeVisible();

  await page.goto('/epics/missing-epic');
  await expect(page.getByRole('heading', { name: 'Epic: missing-epic' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Epic not found.' })).toBeVisible();

  await page.goto('/tasks/missing-task');
  await expect(page.getByRole('heading', { name: 'Task: missing-task' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Task not found.' })).toBeVisible();

  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: 'Approval Inbox' })).toBeVisible();
  await expect(page.getByText('No pending approvals.')).toBeVisible();

  await page.goto('/execution');
  await expect(page.getByRole('heading', { name: 'Execution monitor' })).toBeVisible();
  await expect(page.getByText('No active, waiting, or blocked work.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause All' })).toHaveCount(0);

  await page.goto('/runs/missing-run');
  await expect(page.getByText('Unable to load Agent Run:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Usage' })).toBeVisible();
  await expect(page.getByText('No usage records are available.')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Global' })).toBeVisible();
  await expect(page.getByText(/Unavailable/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Save|Edit|Update/ })).toHaveCount(0);

  await page.goto('/projects/new');
  await expect(page.getByRole('heading', { name: 'Project onboarding' })).toBeVisible();

  await page.goto('/projects/test-id');
  await expect(page.getByRole('heading', { name: 'Project: test-id' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const dashboard = primaryNavigation.getByRole('link', { name: 'Dashboard' });
  const projects = primaryNavigation.getByRole('link', { name: 'Projects' });
  await expect(primaryNavigation).toBeVisible();
  await dashboard.focus();
  await expect(dashboard).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(projects).toBeFocused();
  await expect(projects).toBeVisible();

  await page.keyboard.press('Enter');

  await expect(page.getByRole('heading', { name: 'Project onboarding' })).toBeVisible();
  await expect(primaryNavigation).toBeVisible();
  await expect(projects).toHaveAttribute('aria-current', 'page');
});
