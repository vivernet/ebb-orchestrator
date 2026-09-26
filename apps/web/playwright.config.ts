import { defineConfig, devices } from '@playwright/test';

function launcherBaseUrl() {
  const value = process.env.EBB_E2E_BASE_URL;
  if (process.env.EBB_E2E_SERVERS_STARTED !== '1' || !value || !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value)) {
    throw new Error('Playwright E2E requires launcher-provided loopback servers and base URL');
  }
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (port > 65535) throw new Error('Playwright E2E base URL port is outside the TCP range');
  return value;
}

export default defineConfig({
  testDir: './test/e2e',
  testIgnore: ['**/credential-handoff.test.mjs'],
  retries: 0,
  use: { baseURL: launcherBaseUrl(), ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: undefined,
});
