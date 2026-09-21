import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const bootstrapFile = fileURLToPath(new URL('./test/e2e/.playwright/bootstrap.json', import.meta.url));
const managedByE2eLauncher = process.env.EBB_E2E_SERVERS_STARTED === '1';

export default defineConfig({
  testDir: './test/e2e',
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4173', ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome' ] } }],
  webServer: managedByE2eLauncher ? undefined : [
    {
      command: `node test/e2e/web-e2e-server.mjs --port 3001 --bootstrap-file ${bootstrapFile}`,
      url: 'http://127.0.0.1:3001/api/v1/health',
      reuseExistingServer: false,
    },
    {
      command: 'vite --mode e2e --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
  ],
});
