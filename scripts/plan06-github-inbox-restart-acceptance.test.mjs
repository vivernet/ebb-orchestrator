import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);

test("Plan 06 GitHub inbox acceptance isolates production polling and proves durable dedupe", async () => {
  const harness = await readFile(new URL("scripts/plan06-github-inbox-restart-acceptance.mjs", root), "utf8");
  const transport = await readFile(new URL("scripts/fixtures/plan06-github-http-transport.mjs", root), "utf8");

  assert.match(harness, /apps\/server\/dist\/main\.js/);
  assert.match(harness, /spawn\(process\.execPath,[\s\S]*?shell:\s*false/);
  assert.match(harness, /mkdtemp\(join\(tmpdir\(\)/);
  assert.match(harness, /EBB_ORCHESTRATOR_HOME/);
  assert.match(harness, /\/api\/v1\/projects\/\$\{[^}]+\}\/github\/sync/);
  assert.match(harness, /after-restart/);
  assert.match(harness, /human_feedback/);
  assert.match(harness, /github_feedback_deliveries/);
  assert.match(harness, /waitForWorkflowQuiescence/);
  assert.match(harness, /const pollSideEffectTables = new Set\(\["github_feedback_deliveries", "human_feedback"\]\)/);
  assert.doesNotMatch(harness, /projectScopedPollAccountingSnapshot|pollAccountingTables|assertPollAccountingUnchanged/);
  assert.match(harness, /const nonWorkflowInfrastructureTables = new Set\(\["auth_sessions", "local_users", "secrets"\]\)/);
  assert.match(harness, /const authoritativeTables = tableNames\.filter\(\(name\) => !pollSideEffectTables\.has\(name\) && !nonWorkflowInfrastructureTables\.has\(name\)\)/);
  assert.match(harness, /assertSecretMetadataUnchanged\(activeSession, secretMetadataBeforePolling, "first poll"\)/);
  assert.match(harness, /assertSecretMetadataUnchanged\(activeSession, secretMetadataBeforePolling, "duplicate poll"\)/);
  assert.match(harness, /assertSecretMetadataUnchanged\(activeSession, secretMetadataAfterRestart, "after-restart poll"\)/);
  assert.match(harness, /assertWorkflowSnapshotUnchanged\(workflowBeforePolling, activeServer\.databasePath, "first poll"\)/);
  assert.match(harness, /assertWorkflowSnapshotUnchanged\(workflowBeforePolling, activeServer\.databasePath, "duplicate poll"\)/);
  assert.match(harness, /assertWorkflowSnapshotUnchanged\(workflowAfterRestartBeforePolling, activeServer\.databasePath, "after-restart poll"\)/);
  assert.match(harness, /PRAGMA query_only = ON[\s\S]*?database\.exec\("BEGIN"\)/);
  assert.match(harness, /"dependencies", "proposals", "decisions"/);
  assert.doesNotMatch(harness, /workflowTablePattern/);
  assert.doesNotMatch(harness, /privateKeyPem\s*=\s*["']/);
  assert.match(harness, /assertWorkflowSnapshotUnchanged/);
  assert.match(harness, /child\.send\(\{ type: "plan06-graceful-shutdown" \},/);
  assert.match(harness, /stdio: \[bootstrap \? "pipe" : "ignore", "pipe", "pipe", "ipc"\]/);
  assert.match(harness, /assertIsolatedKeyringStatus\(server\.statusPath, \{[^\n]*closed: true \}\)/);
  assert.match(harness, /forbiddenWriteRequests/);
  assert.match(harness, /revokeTemporaryGithubSecrets/);
  assert.match(harness, /cleanupOwnedTemporaryRoot/);
  assert.match(harness, /apps\/server\/dist\/main\.js/);
  assert.match(harness, /for \(const key of \["GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "NODE_PATH", "OPENAI_API_KEY", "INCEPTION_API_KEY"\]\) delete env\[key\]/);
  assert.doesNotMatch(harness, /env\.(?:GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY|INCEPTION_API_KEY)\s*=/);

  assert.match(transport, /https:\/\/api\.github\.com/);
  assert.match(transport, /PLAN06_GITHUB_FIXTURE_URL/);
  assert.match(transport, /Module\._load/);
  assert.match(transport, /memoryKeyring/);
  assert.match(transport, /process\.once\("exit"/);
  assert.match(transport, /plan06-graceful-shutdown/);
  assert.match(transport, /process\.emit\("SIGINT"\)/);
  assert.match(transport, /fill\(0\)/);
  assert.match(transport, /blocked external fetch/);
  assert.doesNotMatch(transport, /console\.(?:log|info|debug)\(/);
});
