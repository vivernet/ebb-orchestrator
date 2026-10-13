import { test, expect } from './fixtures.js';

const acceptedRuns = process.env.EBB_E2E_ACCEPTED_RUNS_JSON;

if (acceptedRuns) {
  test('renders the accepted production Run manifests from the live API after restart', async ({ page, e2ePassword }) => {
    const runs = JSON.parse(acceptedRuns) as Record<string, string>;
    const labels = Object.keys(runs).sort();
    expect(labels).toHaveLength(18);
    expect(new Set(Object.values(runs)).size).toBe(18);

    await page.goto('/');
    await page.getByLabel('Пароль').fill(e2ePassword.toString('utf8'));
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('heading', { name: 'Обзор' })).toBeVisible();

    for (const [label, runId] of Object.entries(runs)) {
      const manifestResponse = await page.request.get(`/api/v1/runs/${encodeURIComponent(runId)}/context-manifests`);
      expect(manifestResponse.status(), `${label} live API response`).toBe(200);
      const manifest = await manifestResponse.json() as {
        availability: string;
        runId: string;
        subject: { type: string; id: string };
        role: string;
      };
      expect(manifest).toMatchObject({ availability: 'available', runId });

      await page.goto(`/runs/${encodeURIComponent(runId)}`);
      await expect(page.getByRole('heading', { name: `Запуск агента: ${runId}` })).toBeVisible();
      const renderedManifest = page.getByRole('region', { name: 'Манифест контекста' });
      await expect(renderedManifest).toContainText(runId);
      await expect(renderedManifest).toContainText(manifest.subject.id);
      await expect(renderedManifest).toContainText(manifest.role);
    }
  });
}
