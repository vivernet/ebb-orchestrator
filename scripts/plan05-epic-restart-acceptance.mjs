#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
const acceptanceTest = "test/e2e/epic-restart-production.acceptance.test.ts";
const result = spawnSync(process.execPath, [vitestCli, "run", acceptanceTest, "--pool=forks", "--maxWorkers=1", "--disableConsoleIntercept"], {
  cwd: resolve(repositoryRoot, "apps/server"),
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
