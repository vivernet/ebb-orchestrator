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
