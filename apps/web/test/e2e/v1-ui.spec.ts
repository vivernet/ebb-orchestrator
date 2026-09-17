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
