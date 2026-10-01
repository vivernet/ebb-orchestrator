import { defineConfig, devices } from '@playwright/test';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function launcherBaseUrl() {
  const value = process.env.EBB_E2E_BASE_URL;
  if (process.env.EBB_E2E_SERVERS_STARTED !== '1' || !value || !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value)) {
    throw new Error('Playwright E2E requires launcher-provided loopback servers and base URL');
  }
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (port > 65535) throw new Error('Playwright E2E base URL port is outside the TCP range');
  return value;
}

function launcherOutputDir() {
  const home = process.env.EBB_E2E_HOME;
  const outputDir = process.env.EBB_E2E_PLAYWRIGHT_OUTPUT_DIR;
  if (!home || !outputDir || !isAbsolute(home) || !isAbsolute(outputDir)) {
    throw new Error('Playwright E2E requires a launcher-owned output directory inside its isolated home');
  }
  const relativeOutput = relative(resolve(home), resolve(outputDir));
  if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) {
    throw new Error('Playwright E2E output directory must be a child of its isolated home');
  }
  return resolve(outputDir);
}

export default defineConfig({
  testDir: './test/e2e',
  testIgnore: ['**/credential-handoff.test.mjs'],
  outputDir: launcherOutputDir(),
  retries: 0,
  use: { baseURL: launcherBaseUrl(), ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: undefined,
});
