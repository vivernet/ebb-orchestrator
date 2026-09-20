import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app/create-app.js';
import { createSqliteDatabase } from '../../src/platform/database/sqlite-database.js';
import type { SchedulerService } from '../../src/modules/scheduler/scheduler-service.js';

describe('web UI assets', () => {
  it('serves the built UI and its SPA routes without exposing paths outside the bundle', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'ebb-web-assets-'));
    const db = createSqliteDatabase(':memory:');
    try {
      writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Ebb UI</title>');
      writeFileSync(join(webRoot, 'app.js'), 'console.log("ui")');
      const app = createApp({
        db,
        scheduler: {} as SchedulerService,
        runService: { cancelRun: async () => {} },
        webRoot,
      });

      await expect(app.inject({ method: 'GET', url: '/' })).resolves.toMatchObject({
        statusCode: 200,
        body: expect.stringContaining('Ebb UI'),
      });
      await expect(app.inject({ method: 'GET', url: '/tasks/task-1' })).resolves.toMatchObject({
        statusCode: 200,
        body: expect.stringContaining('Ebb UI'),
      });
      await expect(app.inject({ method: 'GET', url: '/..%2Foutside.txt' })).resolves.toMatchObject({ statusCode: 404 });
      await app.close();
    } finally {
      db.close();
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
});
