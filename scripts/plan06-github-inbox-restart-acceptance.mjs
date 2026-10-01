#!/usr/bin/env node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { finished } from "node:stream/promises";
import { clearTimeout, setTimeout } from "node:timers";
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { URL, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const serverEntrypoint = resolve(root, "apps/server/dist/main.js");
const transportEntrypoint = resolve(root, "scripts/fixtures/plan06-github-http-transport.mjs");
const readinessTimeoutMs = 90_000;
const shutdownTimeoutMs = 15_000;
const outputLimitBytes = 128 * 1024;
const repository = "plan06-owner/inbox-acceptance";
const issueNumber = 17;
const commentId = 777100;
const appId = "731906";
const installationId = "864209";
const fixtureToken = "plan06-local-installation-token";
const commentsPath = `/repos/${repository}/issues/comments?per_page=100&page=1`;
const issuesPath = `/repos/${repository}/issues?state=all&per_page=100&page=1`;
const tokenPath = `/app/installations/${installationId}/access_tokens`;
// Из полного workflow snapshot исключаются только inbox rows и их delivery receipts: они проверяются точными assertions отдельно.
const pollSideEffectTables = new Set(["github_feedback_deliveries", "human_feedback"]);
// Служебные таблицы исключены из workflow/domain snapshot; secrets metadata сверяется через API ниже.
const nonWorkflowInfrastructureTables = new Set(["auth_sessions", "local_users", "secrets"]);

/** Доказывает production GitHub Issue polling, receipt dedupe и SQLite recovery без внешнего GitHub. */
async function runAcceptance() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ebb-plan06-github-inbox-"));
  const passwordBytes = randomBytes(32);
  const password = passwordBytes.toString("base64url");
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" });
  const privateKeyBytes = Buffer.from(privateKeyPem, "utf8");
  let activeServer;
  let activeSession;
  let fixture;
  let acceptanceError;
  let cleanupError;

  try {
    assertPathWithin(await realpath(tmpdir()), await realpath(temporaryRoot), "private acceptance root");
    fixture = await startGithubFixture({ publicKeyPem });
    const productionHome = join(temporaryRoot, "production-home");
    await mkdir(productionHome, { recursive: true });
    activeServer = await startProductionServer({ home: productionHome, fixtureOrigin: fixture.origin, statusPath: join(temporaryRoot, "first-keyring-status.json"), password, privateKeyPem, bootstrap: true }, (server) => { activeServer = server; });
    activeSession = await login(activeServer, password);
    assertIsolatedKeyringStatus(activeServer.statusPath, { minimumEntryConstructions: 0, entries: 0 });

    const project = await createActiveProject(activeSession, join(temporaryRoot, "project"));
    await storeTemporaryGithubSecrets(activeSession, privateKeyPem);
    assertIsolatedKeyringStatus(activeServer.statusPath, { minimumEntryConstructions: 4, entries: 3 });
    const storedSecrets = await requestJson(activeSession, "GET", "/api/v1/secrets/github", undefined, 200);
    assert.deepEqual(storedSecrets.secrets.map((item) => item.name).sort(), ["app-id", "installation-id", "private-key"]);
    const secretMetadataBeforePolling = normalizeSecretMetadata(storedSecrets.secrets);

    const mapped = await requestJson(activeSession, "PUT", `/api/v1/projects/${project.projectId}/github/mapping`, { repository }, 200);
    assert.equal(mapped.repository, repository);
    const persistedMapping = await requestJson(activeSession, "GET", `/api/v1/projects/${project.projectId}/github/mapping`, undefined, 200);
    assert.equal(persistedMapping.repository, repository);
    const workflowBeforePolling = await waitForWorkflowQuiescence(activeServer.databasePath);

    let callStart = fixture.requests.length;
    await syncNow(activeSession, project.projectId);
    assertFixtureCallGroup(fixture, callStart, "first poll", [["POST", tokenPath], ["GET", issuesPath], ["GET", commentsPath]]);
    await assertInboxAndReceipt(activeSession, activeServer.databasePath, project.projectId, "first poll");
    await assertSecretMetadataUnchanged(activeSession, secretMetadataBeforePolling, "first poll");
    assertWorkflowSnapshotUnchanged(workflowBeforePolling, activeServer.databasePath, "first poll");

    callStart = fixture.requests.length;
    await syncNow(activeSession, project.projectId);
    assertFixtureCallGroup(fixture, callStart, "duplicate poll", [["GET", issuesPath], ["GET", commentsPath]]);
    await assertInboxAndReceipt(activeSession, activeServer.databasePath, project.projectId, "duplicate poll");
    await assertSecretMetadataUnchanged(activeSession, secretMetadataBeforePolling, "duplicate poll");
    assertWorkflowSnapshotUnchanged(workflowBeforePolling, activeServer.databasePath, "duplicate poll");

    await revokeTemporaryGithubSecrets(activeSession);
    assertIsolatedKeyringStatus(activeServer.statusPath, { minimumEntryConstructions: 7, minimumDeletes: 3, entries: 0 });
    assert.deepEqual((await requestJson(activeSession, "GET", "/api/v1/secrets/github", undefined, 200)).secrets, []);
    const databasePath = activeServer.databasePath;
    const firstProcessId = activeServer.child.pid;
    await terminateAndRemoveStaleLock(activeServer, [password, privateKeyPem]);
    activeServer = undefined;
    activeSession = undefined;

    activeServer = await startProductionServer({ home: productionHome, fixtureOrigin: fixture.origin, statusPath: join(temporaryRoot, "second-keyring-status.json"), password, privateKeyPem, bootstrap: false }, (server) => { activeServer = server; });
    assert.notEqual(activeServer.child.pid, firstProcessId, "restart acceptance did not start a new production process");
    assert.equal(activeServer.databasePath, databasePath, "restart acceptance changed the disposable production database path");
    activeSession = await login(activeServer, password);
    assertIsolatedKeyringStatus(activeServer.statusPath, { minimumEntryConstructions: 0, entries: 0 });
    const restartedMapping = await requestJson(activeSession, "GET", `/api/v1/projects/${project.projectId}/github/mapping`, undefined, 200);
    assert.equal(restartedMapping.repository, repository, "production restart lost GitHub project mapping");
    const revokedSecretsAfterRestart = await requestJson(activeSession, "GET", "/api/v1/secrets/github", undefined, 200);
    assert.deepEqual(normalizeSecretMetadata(revokedSecretsAfterRestart.secrets), [], "production restart restored revoked GitHub secret metadata");
    await assertInboxAndReceipt(activeSession, activeServer.databasePath, project.projectId, "before post-restart poll");
    const workflowAfterRestartBeforePolling = await waitForWorkflowQuiescence(activeServer.databasePath);

    // The test-only keyring is process-local. Re-enter the same generated disposable credentials through the API.
    await storeTemporaryGithubSecrets(activeSession, privateKeyPem);
    const postRestartSecrets = await requestJson(activeSession, "GET", "/api/v1/secrets/github", undefined, 200);
    const secretMetadataAfterRestart = normalizeSecretMetadata(postRestartSecrets.secrets);
    assert.deepEqual(secretMetadataAfterRestart.map((secret) => secret.name), ["app-id", "installation-id", "private-key"]);
    callStart = fixture.requests.length;
    await syncNow(activeSession, project.projectId);
    assertFixtureCallGroup(fixture, callStart, "after-restart poll", [["POST", tokenPath], ["GET", issuesPath], ["GET", commentsPath]]);
    await assertInboxAndReceipt(activeSession, activeServer.databasePath, project.projectId, "after-restart poll");
    await assertSecretMetadataUnchanged(activeSession, secretMetadataAfterRestart, "after-restart poll");
    assertWorkflowSnapshotUnchanged(workflowAfterRestartBeforePolling, activeServer.databasePath, "after-restart poll");
    assertNoFixtureWrites(fixture);
    assert.equal(fixture.requests.length, 8, "acceptance observed an unexpected extra production poll or GitHub API call");
    assert.equal(fixture.tokenExchangeCount, 2, "fresh production processes must each obtain exactly one fixture installation token");

    await revokeTemporaryGithubSecrets(activeSession);
    assertIsolatedKeyringStatus(activeServer.statusPath, { minimumEntryConstructions: 4, minimumDeletes: 3, entries: 0 });
    assert.deepEqual((await requestJson(activeSession, "GET", "/api/v1/secrets/github", undefined, 200)).secrets, []);
    await stopProductionServerGracefully(activeServer, [password, privateKeyPem]);
    assertIsolatedKeyringStatus(activeServer.statusPath, { minimumEntryConstructions: 4, entries: 0, closed: true });
    activeServer = undefined;
    activeSession = undefined;
  } catch (error) {
    acceptanceError = error;
  } finally {
    passwordBytes.fill(0);
    privateKeyBytes.fill(0);
    try {
      if (activeServer && activeSession) await revokeTemporaryGithubSecrets(activeSession).catch(() => undefined);
      await cleanupOwnedTemporaryRoot(activeServer, [password, privateKeyPem], temporaryRoot);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await fixture?.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (acceptanceError) {
    if (cleanupError) console.error(`ACCEPTANCE_CLEANUP_SECONDARY_FAILURE=${safeErrorMessage(cleanupError, [password, privateKeyPem])}`);
    const sanitized = safeErrorMessage(acceptanceError, [password, privateKeyPem]);
    throw new Error(sanitized);
  }
  if (cleanupError) {
    const sanitized = safeErrorMessage(cleanupError, [password, privateKeyPem]);
    throw new Error(sanitized);
  }
  console.log("PLAN06_GITHUB_INBOX_RESTART_ACCEPTANCE=PASS");
  console.log("Verified: production dist/main.js polled a local GitHub HTTP fixture twice, then after a real production process restart; exactly one durable inbox row and DELIVERED receipt survived; workflow tables were unchanged; the fixture rejected all unapproved hosts, paths, and write requests. Test-only keyring buffers were wiped by secret revocation before each child teardown; the shim also wipes on normal Node exit. This is not OS keyring evidence.");
}

async function startGithubFixture({ publicKeyPem }) {
  const fixture = {
    requests: [],
    rejectedRequests: [],
    forbiddenWriteRequests: [],
    tokenExchangeCount: 0,
    publicKey: createPublicKey(publicKeyPem),
  };
  const server = createHttpServer((request, response) => {
    void handleFixtureRequest(fixture, request, response).catch(() => sendJson(response, 500, { error: "fixture failure" }));
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  fixture.server = server;
  fixture.origin = `http://127.0.0.1:${address.port}`;
  fixture.close = async () => {
    server.closeAllConnections();
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  };
  return fixture;
}

async function handleFixtureRequest(fixture, request, response) {
  const method = request.method ?? "";
  const requestUrl = new URL(request.url ?? "/", fixture.origin);
  const path = `${requestUrl.pathname}${requestUrl.search}`;
  const requestRecord = { method, path, allowed: false };
  fixture.requests.push(requestRecord);
  request.resume();

  const tokenEndpoint = method === "POST" && path === tokenPath;
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    if (!tokenEndpoint) fixture.forbiddenWriteRequests.push(`${method} ${path}`);
  }
  if (request.headers.host !== new URL(fixture.origin).host) {
    fixture.rejectedRequests.push(`${method} ${path}`);
    return sendJson(response, 403, { error: "fixture rejected host" });
  }
  if (tokenEndpoint) {
    const verified = verifyAppJwt(request.headers.authorization, fixture.publicKey);
    if (!verified) {
      fixture.rejectedRequests.push(`${method} ${path}`);
      return sendJson(response, 401, { error: "fixture rejected app token" });
    }
    requestRecord.allowed = true;
    fixture.tokenExchangeCount += 1;
    return sendJson(response, 201, { token: fixtureToken, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
  }
  const authorized = request.headers.authorization === `Bearer ${fixtureToken}`;
  if (method === "GET" && path === issuesPath && authorized) {
    requestRecord.allowed = true;
    return sendJson(response, 200, [
      { number: issueNumber, title: "Disposable inbox issue", state: "open" },
      { number: 18, title: "Disposable pull request", state: "open", pull_request: { url: `https://api.github.com/repos/${repository}/pulls/18` } },
    ]);
  }
  if (method === "GET" && path === commentsPath && authorized) {
    requestRecord.allowed = true;
    return sendJson(response, 200, [
      commentRecord(commentId, issueNumber, "Please keep the documented behavior.", { type: "User", login: "local-reviewer" }),
      commentRecord(commentId + 1, issueNumber, "Bot feedback must not enter the inbox.", { type: "Bot", login: "fixture-bot" }),
      commentRecord(commentId + 2, issueNumber, "ORCHESTRATOR: automated status marker.", { type: "User", login: "local-reviewer" }),
      commentRecord(commentId + 3, 18, "Pull request discussion is not an Issue comment.", { type: "User", login: "local-reviewer" }),
    ]);
  }
  fixture.rejectedRequests.push(`${method} ${path}`);
  return sendJson(response, authorized ? 404 : 401, { error: "fixture rejected request" });
}

function verifyAppJwt(authorization, publicKey) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (header.alg !== "RS256" || claims.iss !== appId || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp <= claims.iat) return false;
    return verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  } catch {
    return false;
  }
}

function commentRecord(id, number, body, user) {
  return {
    id,
    issue_url: `https://api.github.com/repos/${repository}/issues/${number}`,
    html_url: `https://github.com/${repository}/issues/${number}#issuecomment-${id}`,
    created_at: "2026-09-30T08:00:00Z",
    updated_at: "2026-09-30T08:00:00Z",
    body,
    user,
  };
}

function sendJson(response, statusCode, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function assertFixtureCallGroup(fixture, start, label, expected) {
  const actual = fixture.requests.slice(start).map((item) => [item.method, item.path]);
  assert.deepEqual(actual, expected, `${label} made a different local GitHub request sequence`);
  assert.equal(fixture.requests.slice(start).every((item) => item.allowed), true, `${label} had a request rejected by the local GitHub fixture`);
  assertNoFixtureWrites(fixture);
}

function assertNoFixtureWrites(fixture) {
  assert.deepEqual(fixture.forbiddenWriteRequests, [], "production poll attempted a GitHub workflow, PR comment, review, or other write");
  assert.deepEqual(fixture.rejectedRequests, [], "production poll attempted an unapproved GitHub host/path/method or invalid token");
  assert.ok(fixture.requests.every((item) => item.allowed), "local fixture observed an unapproved request");
}

async function createActiveProject(session, repositoryPath) {
  await createRepository(repositoryPath);
  const discovered = await requestJson(session, "POST", "/api/v1/onboarding/discover", { repositoryPath }, 201);
  assert.equal(typeof discovered.projectId, "string");
  const proposal = { defaultBranch: "main", workflow: "local-default", roles: [], guidelines: [] };
  await requestJson(session, "POST", `/api/v1/onboarding/${discovered.projectId}/approval`, { proposed: proposal }, 201);
  await requestJson(session, "POST", `/api/v1/onboarding/${discovered.projectId}/approve`, {}, 200);
  await requestJson(session, "POST", `/api/v1/onboarding/${discovered.projectId}/activate`, {}, 200);
  return { projectId: discovered.projectId };
}

async function storeTemporaryGithubSecrets(session, privateKeyPem) {
  for (const secret of [
    { name: "app-id", value: appId },
    { name: "private-key", value: privateKeyPem },
    { name: "installation-id", value: installationId },
  ]) {
    await requestJson(session, "POST", "/api/v1/secrets", { service: "github", ...secret }, 201);
  }
}

async function revokeTemporaryGithubSecrets(session) {
  for (const name of ["private-key", "installation-id", "app-id"]) {
    await requestJson(session, "DELETE", `/api/v1/secrets/github/${name}`, {}, 204);
  }
}

function normalizeSecretMetadata(secrets) {
  return secrets.map(({ name, referenceId, createdAt, updatedAt }) => ({ name, referenceId, createdAt, updatedAt }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function assertSecretMetadataUnchanged(session, expected, label) {
  const response = await requestJson(session, "GET", "/api/v1/secrets/github", undefined, 200);
  assert.deepEqual(normalizeSecretMetadata(response.secrets), expected, `${label} changed GitHub secret metadata`);
}

async function syncNow(session, projectId) {
  const result = await requestJson(session, "POST", `/api/v1/projects/${projectId}/github/sync`, {}, 200);
  assert.equal(result.status, "SYNCED", "production sync worker did not complete the Issue comment poll");
}

async function assertInboxAndReceipt(session, databasePath, projectId, label) {
  const page = await requestJson(session, "GET", `/api/v1/projects/${projectId}/human-feedback?status=UNTRIAGED`, undefined, 200);
  assert.equal(page.items.length, 1, `${label} must expose exactly one human Issue comment in the inbox`);
  assert.equal(page.items[0].sourceCommentId, commentId);
  assert.equal(page.items[0].sourceIssueNumber, issueNumber);
  assert.equal(page.items[0].sourceRepository, repository);
  assert.equal(page.items[0].body, "Please keep the documented behavior.");
  assert.equal(page.items[0].status, "UNTRIAGED");
  assert.equal(page.items[0].taskId, null);
  assert.equal(page.items[0].epicId, null);
  assert.equal(page.nextCursor, null);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const feedbackRows = database.prepare("SELECT * FROM human_feedback ORDER BY source_comment_id").all();
    assert.equal(feedbackRows.length, 1, `${label} must persist exactly one inbox row`);
    assert.equal(feedbackRows[0].project_id, projectId);
    assert.equal(feedbackRows[0].source_key, `github.com:${repository}:issue-comment:${commentId}`);
    assert.equal(feedbackRows[0].source_repository, repository);
    assert.equal(feedbackRows[0].source_issue_number, issueNumber);
    assert.equal(feedbackRows[0].source_comment_id, commentId);
    assert.equal(feedbackRows[0].status, "UNTRIAGED");
    assert.equal(feedbackRows[0].task_id, null);
    assert.equal(feedbackRows[0].epic_id, null);

    const receipts = database.prepare("SELECT * FROM github_feedback_deliveries ORDER BY comment_id").all();
    assert.equal(receipts.length, 1, `${label} must persist exactly one delivery receipt`);
    assert.equal(receipts[0].repository, repository);
    assert.equal(receipts[0].comment_id, commentId);
    assert.equal(receipts[0].issue_number, issueNumber);
    assert.equal(receipts[0].status, "DELIVERED");
    assert.equal(typeof receipts[0].created_at, "string");
    assert.equal(typeof receipts[0].delivered_at, "string");
    assert.ok(receipts[0].delivered_at.length > 0);
  } finally {
    database.close();
  }
}

function workflowSnapshot(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA query_only = ON");
    database.exec("BEGIN");
    try {
      const tableNames = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
      const authoritativeTables = tableNames.filter((name) => !pollSideEffectTables.has(name) && !nonWorkflowInfrastructureTables.has(name));
      for (const required of ["projects", "tasks", "epics", "dependencies", "proposals", "decisions", "approvals", "agent_runs", "git_operations", "branches", "worktrees", "merge_conflicts", "planning_requests", "planning_plans", "epic_orchestrations", "github_sync_records"]) {
        assert.ok(authoritativeTables.includes(required), `workflow mutation evidence omitted table ${required}`);
      }
      const snapshot = {};
      for (const table of authoritativeTables) {
        const identifier = `"${table.replaceAll('"', '""')}"`;
        const rows = database.prepare(`SELECT * FROM ${identifier}`).all();
        snapshot[table] = rows.map((row) => JSON.stringify(row)).sort();
      }
      database.exec("COMMIT");
      return snapshot;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

async function waitForWorkflowQuiescence(databasePath) {
  const deadline = Date.now() + 20_000;
  let previous;
  let stableSince;
  while (Date.now() < deadline) {
    const current = workflowSnapshot(databasePath);
    const pendingOutbox = countPendingOutbox(databasePath);
    const now = Date.now();
    if (pendingOutbox === 0 && previous && JSON.stringify(previous) === JSON.stringify(current)) {
      stableSince ??= now;
      if (now - stableSince >= 5_500) return current;
    } else {
      stableSince = pendingOutbox === 0 ? now : undefined;
    }
    previous = current;
    await delay(250);
  }
  throw new Error("production workflow tables did not settle before GitHub polling");
}

function countPendingOutbox(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE processed_at IS NULL").get().count;
  } finally {
    database.close();
  }
}

function assertWorkflowSnapshotUnchanged(expected, databasePath, label) {
  const actual = workflowSnapshot(databasePath);
  const tables = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const changed = [...tables].filter((table) => JSON.stringify(expected[table]) !== JSON.stringify(actual[table]));
  assert.deepEqual(changed, [], `${label} changed full workflow tables: ${changed.join(", ")}`);
}

function assertIsolatedKeyringStatus(statusPath, { minimumEntryConstructions, minimumDeletes = 0, entries, closed = false }) {
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(status.version, 1);
  assert.equal(status.moduleIntercepted, true, "production child did not intercept the native OS keyring module");
  assert.ok(status.entryConstructions >= minimumEntryConstructions, `production child used ${status.entryConstructions} in-memory keyring entries; expected at least ${minimumEntryConstructions}`);
  assert.ok(status.deleteCount >= minimumDeletes, `test-only keyring deleted ${status.deleteCount} values; expected at least ${minimumDeletes}`);
  assert.equal(status.entries, entries, `in-memory test keyring has ${status.entries} credentials; expected ${entries}`);
  assert.equal(status.closed, closed, `test-only keyring cleanup state is ${status.closed}; expected ${closed}`);
}

async function requestJson(session, method, path, body, expectedStatus) {
  const mutating = method !== "GET" && method !== "HEAD";
  const headers = { cookie: session.cookie };
  if (mutating) {
    headers.origin = session.origin;
    headers["x-csrf-token"] = session.csrfToken;
    headers["content-type"] = "application/json";
  }
  const response = await globalThis.fetch(`${session.origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  const errorCode = typeof payload?.error === "string" ? payload.error : typeof payload?.error?.code === "string" ? payload.error.code : undefined;
  assert.equal(response.status, expectedStatus, `${method} ${path} returned HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`);
  return payload;
}

async function login(server, password) {
  const response = await globalThis.fetch(`${server.origin}/api/v1/session/login`, {
    method: "POST",
    headers: { origin: server.origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, 200, "production local-session login failed");
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "production login did not issue its local session cookie");
  assert.match(payload?.csrfToken ?? "", /^[A-Za-z0-9_-]{43}$/);
  return { origin: server.origin, cookie: setCookie.split(";", 1)[0], csrfToken: payload.csrfToken };
}

async function startProductionServer({ home, fixtureOrigin, statusPath, password, privateKeyPem, bootstrap }, onChild) {
  await mkdir(home, { recursive: true });
  assertPathWithin(await realpath(tmpdir()), await realpath(home), "disposable production home");
  const port = await reservePort();
  const args = ["--import", pathToFileURL(transportEntrypoint).href, serverEntrypoint, ...(bootstrap ? ["--bootstrap-local-user-stdin"] : [])];
  const env = { ...process.env, EBB_ORCHESTRATOR_HOME: home, PORT: String(port), PLAN06_GITHUB_FIXTURE_URL: fixtureOrigin, PLAN06_GITHUB_ACCEPTANCE_ROOT: resolve(home, ".."), PLAN06_GITHUB_KEYRING_STATUS: statusPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith("EBB_HERMES_") || key.startsWith("INFISICAL_") || key.startsWith("EBB_SECRET_")) delete env[key];
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "NODE_PATH", "OPENAI_API_KEY", "INCEPTION_API_KEY"]) delete env[key];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    shell: false,
    stdio: [bootstrap ? "pipe" : "ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const output = captureOutput(child, [password, privateKeyPem]);
  child.outputCapture = output;
  const server = { child, output, origin: `http://127.0.0.1:${port}`, home, databasePath: join(home, "ebb-orchestrator.db"), statusPath, secretsToRedact: [password, privateKeyPem] };
  onChild(server);
  if (bootstrap) await writeBootstrapPassword(child, password);
  await waitForReady(server);
  assertIsolatedKeyringStatus(statusPath, { minimumEntryConstructions: 0, entries: 0 });
  assert.equal(output.secretLeak, false, "a disposable secret appeared in production child output");
  return server;
}

function captureOutput(child, secrets) {
  const output = { stdout: "", stderr: "", overflow: false, secretLeak: false };
  const tails = { stdout: "", stderr: "" };
  const append = (stream, chunk) => {
    const text = String(chunk);
    const combined = tails[stream] + text;
    if (secrets.some((secret) => secret && combined.includes(secret))) output.secretLeak = true;
    tails[stream] = combined.slice(-Math.max(0, ...secrets.map((secret) => (secret?.length ?? 0) - 1)));
    if (Buffer.byteLength(output[stream] + text, "utf8") > outputLimitBytes) {
      output.overflow = true;
      return;
    }
    output[stream] += text;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  return output;
}

async function writeBootstrapPassword(child, password) {
  const payload = Buffer.from(`${password}\n${password}\n`, "utf8");
  const completion = finished(child.stdin, { cleanup: true, readable: false });
  try {
    child.stdin.end(payload);
    await completion;
  } finally {
    payload.fill(0);
  }
}

async function waitForReady(server) {
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    const { child, output } = server;
    if (child.exitCode !== null || child.signalCode !== null) {
      const startupOutput = output.secretLeak ? "[startup output omitted because it contained a disposable secret]" : `${output.stderr}\n${output.stdout}`.trim().slice(-1200);
      throw new Error(`production dist/main.js exited before READY (code=${child.exitCode}, signal=${child.signalCode}); sanitized output=${JSON.stringify(startupOutput)}`);
    }
    const response = await globalThis.fetch(`${server.origin}/api/v1/health`, { signal: globalThis.AbortSignal.timeout(500) }).catch(() => undefined);
    if (response?.ok) {
      const health = await response.json();
      assert.equal(health.lifecycle, "READY");
      assert.match(output.stdout, /status: READY/);
      assert.equal(output.overflow, false, "production child output exceeded its bounded capture limit");
      return;
    }
    await delay(100);
  }
  throw new Error("production server did not reach READY within the bounded timeout");
}

async function terminateAndRemoveStaleLock(server, secrets) {
  await terminateProductionProcess(server, secrets);
  const lockPath = join(server.home, "orchestrator.lock");
  const lockRecord = await readFile(lockPath, "utf8");
  const match = /^v1:(\d+):[a-f0-9]{32}\r?\n$/.exec(lockRecord);
  assert.ok(match, "terminated production process left an invalid lock record");
  assert.equal(Number(match[1]), server.child.pid, "stale lock did not belong to the owned production child");
  await unlink(lockPath);
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
}

async function terminateProductionProcess(server, secrets) {
  assert.equal(server.child.exitCode, null, "production process exited before forced termination");
  assert.equal(server.child.signalCode, null, "production process was already signaled");
  await terminateOwnedProcess(server.child);
  assert.ok(server.child.exitCode !== null || server.child.signalCode !== null, "owned production process remained alive after termination");
  assert.equal(server.output.secretLeak, false, "a disposable secret appeared in production child output");
  assert.equal(server.output.overflow, false, "production child output exceeded its bounded capture limit");
  assert.equal(secrets.some((secret) => secret && `${server.output.stdout}\n${server.output.stderr}`.includes(secret)), false);
}

async function stopProductionServerGracefully(server, secrets) {
  assert.equal(server.child.exitCode, null, "production process exited before graceful shutdown");
  assert.equal(server.child.signalCode, null, "production process was already signaled");
  assert.equal(server.child.connected, true, "production child lost its test-only shutdown channel");
  await new Promise((resolveSend, rejectSend) => server.child.send({ type: "plan06-graceful-shutdown" }, (error) => error ? rejectSend(error) : resolveSend()));
  await waitForExit(server.child, shutdownTimeoutMs);
  assert.equal(server.child.exitCode, 0, "production process did not complete graceful shutdown with exit code 0");
  assert.equal(server.child.signalCode, null, "production process was terminated by an OS signal instead of graceful shutdown");
  assertIsolatedKeyringStatus(server.statusPath, { minimumEntryConstructions: 0, entries: 0, closed: true });
  assert.equal(server.output.secretLeak, false, "a disposable secret appeared in production child output");
  assert.equal(server.output.overflow, false, "production child output exceeded its bounded capture limit");
  assert.equal(secrets.some((secret) => secret && `${server.output.stdout}\n${server.output.stderr}`.includes(secret)), false);
}

async function cleanupOwnedTemporaryRoot(server, secrets, temporaryRoot) {
  let stopError;
  try {
    if (server && (server.child.exitCode === null && server.child.signalCode === null)) {
      await terminateProductionProcess(server, secrets);
    }
  } catch (error) {
    stopError = error;
  }
  const childExited = !server || server.child.exitCode !== null || server.child.signalCode !== null;
  let rootError;
  if (childExited) {
    try {
      await removeOwnedTemporaryRoot(temporaryRoot);
    } catch (error) {
      rootError = error;
    }
  } else {
    rootError = new Error(`temporary root was preserved because its child is still running: ${temporaryRoot}`);
  }
  if (stopError && rootError) throw new AggregateError([stopError, rootError], "owned process cleanup failed");
  if (stopError) throw stopError;
  if (rootError) throw rootError;
}

async function terminateOwnedProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    assert.equal(child.kill("SIGTERM"), true, "could not terminate the owned production process");
  } else {
    process.kill(-child.pid, "SIGKILL");
  }
  await waitForExit(child, shutdownTimeoutMs);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit, reject) => {
    const onExit = (code, signal) => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onError); resolveExit({ code, signal }); };
    const onError = (error) => { clearTimeout(timer); child.off("exit", onExit); child.off("error", onError); reject(error); };
    const timer = setTimeout(() => { child.off("exit", onExit); child.off("error", onError); reject(new Error("production process did not exit within the bounded timeout")); }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function createRepository(repositoryPath) {
  await mkdir(repositoryPath, { recursive: true });
  const hooks = join(repositoryPath, "acceptance-empty-hooks");
  await mkdir(hooks);
  await writeFile(join(repositoryPath, "README.md"), "Disposable GitHub inbox acceptance repository.\n", "utf8");
  git(repositoryPath, ["-c", "init.defaultBranch=main", "init", "--quiet"]);
  git(repositoryPath, ["config", "--local", "user.name", "Ebb Plan 06 Acceptance"]);
  git(repositoryPath, ["config", "--local", "user.email", "plan06-acceptance@example.invalid"]);
  git(repositoryPath, ["-c", `core.hooksPath=${hooks}`, "add", "README.md"]);
  git(repositoryPath, ["-c", `core.hooksPath=${hooks}`, "commit", "--quiet", "-m", "acceptance fixture"]);
}

function git(repositoryPath, args) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    encoding: "utf8",
  }).trim();
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function removeOwnedTemporaryRoot(temporaryRoot) {
  const tempRoot = await realpath(tmpdir());
  const target = await realpath(temporaryRoot);
  assertPathWithin(tempRoot, target, "temporary acceptance root");
  await rm(target, { recursive: true, force: false });
  await assert.rejects(realpath(target));
}

function assertPathWithin(parent, child, label) {
  const path = relative(parent, child);
  assert.notEqual(path, "", `${label} must be a child of the owned parent`);
  assert.notEqual(path, "..", `${label} escaped its owned parent`);
  assert.equal(path.startsWith(`..${sep}`) || isAbsolute(path), false, `${label} escaped its owned parent`);
}

function safeErrorMessage(error, secrets) {
  const messages = error instanceof AggregateError
    ? [...error.errors].map((item) => safeErrorMessage(item, secrets))
    : [error instanceof Error ? error.message : "unknown acceptance failure"];
  return sanitize(messages.join("; ").replaceAll("\r", " ").replaceAll("\n", " "), secrets);
}

function sanitize(value, secrets) {
  let safe = value;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) safe = safe.replaceAll(secret, "[REDACTED]");
    if (Buffer.isBuffer(secret) && secret.length > 0) safe = safe.replaceAll(secret.toString("utf8"), "[REDACTED]");
  }
  return safe.slice(0, 1_200);
}

function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

await runAcceptance();
