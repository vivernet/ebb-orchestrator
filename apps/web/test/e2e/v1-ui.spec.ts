import { test, expect } from '@playwright/test';
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

test('v1 UI renders a completed task and approves a pending merge', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/session/bootstrap')) {
      await route.fulfill({ json: { sessionToken: 'session', csrfToken: 'csrf', origin: 'http://127.0.0.1:4173' } });
      return;
    }
    if (url.pathname.endsWith('/tasks/task-1')) {
      await route.fulfill({ json: {
        task: { title: 'Add health endpoint', display_id: 'TASK-1', status: 'DONE' },
        contract: { goal: 'Add GET /health' },
        lifecycle: { status: 'DONE', stage: 'DONE' }, runs: [], findings: [], defects: [],
        dependencies: [], events: [], approvals: [], git: { branch: 'master', repositoryPath: '/fixture' },
        waitReason: null, usage: { totalTokens: 0, cost: 0 },
      } });
      return;
    }
    if (url.pathname.endsWith('/approvals')) {
      await route.fulfill({
        json: {
          approvals: [{
            id: 'approval-1',
            type: 'FINAL_MERGE',
            subject_type: 'task',
            subject_id: 'task-1',
            status: 'PENDING',
            requested_by: 'orchestrator',
            resolved_by: null,
            resolution_note: '',
            created_at: new Date().toISOString(),
            resolved_at: null
          }]
        }
      });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/approve')) {
      await route.fulfill({ json: { status: 'approved' } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto('/tasks/task-1#ebb-bootstrap=session-bootstrap');
  await expect(page.getByRole('heading', { name: 'Task: Add health endpoint' })).toBeVisible();
  await expect(page.getByText('Status: DONE')).toBeVisible();
  await page.getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByText('FINAL_MERGE')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
});
