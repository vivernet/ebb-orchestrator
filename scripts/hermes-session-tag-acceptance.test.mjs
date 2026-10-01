import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const acceptanceRunner = resolve(repositoryRoot, "scripts/hermes-session-tag-acceptance.mjs");

test("Hermes provider acceptance fails closed unless explicitly enabled", () => {
  const env = { ...process.env };
  delete env.EBB_RUN_HERMES_SESSION_TAG_ACCEPTANCE;
  const result = spawnSync(process.execPath, [acceptanceRunner], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /HERMES_SESSION_TAG_ACCEPTANCE=NOT RUN/u);
  assert.doesNotMatch(result.stdout, /\bRUN\s+v\d/u);
});
