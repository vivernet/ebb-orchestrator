import { test as base } from "@playwright/test";
import { readE2EPasswordFromChannel } from "./credential-channel.mjs";

import { Buffer } from "node:buffer";

export type E2EWorkerFixtures = { e2ePassword: Readonly<Buffer> };

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, E2EWorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern
  e2ePassword: [async ({}, use) => {
    const password = await readE2EPasswordFromChannel(process.env.EBB_E2E_PASSWORD_CHANNEL);
    try {
      await use(password);
    } finally {
      password.fill(0);
    }
  }, { scope: "worker" }],
});

export { expect } from "@playwright/test";

/**
 * Собирает console/network-ошибки страницы, игнорируя документированное
 * браузерное отключение SSE-потока (`/api/v1/events`, ERR_ABORTED): оно
 * возникает при навигации/teardown и не является дефектом приложения.
 */
export function collectPageErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    const url = request.url();
    const isSseAbort = /\/api\/v1\/events$/.test(url) && failure?.errorText === "net::ERR_ABORTED";
    if (!isSseAbort) errors.push(`requestfailed: ${url} ${failure?.errorText ?? ""}`);
  });
  return errors;
}
