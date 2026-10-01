#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.EBB_RUN_HERMES_SESSION_TAG_ACCEPTANCE !== "1") {
  process.stderr.write("HERMES_SESSION_TAG_ACCEPTANCE=NOT RUN; set EBB_RUN_HERMES_SESSION_TAG_ACCEPTANCE=1 to authorize the provider-backed acceptance.\n");
  process.exit(2);
}

const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
const result = spawnSync(process.execPath, [
  vitestCli,
  "run",
  "test/e2e/hermes-session-tag-proof.acceptance.test.ts",
  "--pool=forks",
  "--maxWorkers=1",
  "--disableConsoleIntercept",
], {
  cwd: resolve(repositoryRoot, "apps/server"),
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
