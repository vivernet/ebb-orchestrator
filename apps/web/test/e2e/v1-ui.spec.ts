import { test, expect } from '@playwright/test';
test('v1 UI exposes the persistent navigation shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Approvals' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Execution' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Usage' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
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
      await route.fulfill({ json: [{ id: 'approval-1', scope: 'task', action: 'FINAL_MERGE', description: 'Merge task-1', requestedBy: 'orchestrator', context: 'task-1', status: 'pending', createdAt: new Date().toISOString() }] });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname.endsWith('/approve')) {
      await route.fulfill({ json: { status: 'approved' } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await page.goto('/tasks/task-1');
  await expect(page.getByRole('heading', { name: 'Task: Add health endpoint' })).toBeVisible();
  await expect(page.getByText('Status: DONE')).toBeVisible();
  await page.goto('/approvals');
  await expect(page.getByText('FINAL_MERGE')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
});
