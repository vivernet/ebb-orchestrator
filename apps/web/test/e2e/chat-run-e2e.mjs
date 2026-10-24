#!/usr/bin/env node
/**
 * Запуск web E2E чата (plan-25 Task 7) против РЕАЛЬНОГО production-бэкенда.
 *
 * Отличие от run-e2e.mjs: вместо stubbed-фикстуры (web-e2e-server.mjs)
 * поднимается настоящий сервер (apps/server/dist/main.js) с изолированным
 * EBB_ORCHESTRATOR_HOME, реальной локальной сессией пользователя, активным
 * проектом с одобренным онбордингом, беседой с историей (для cursor-пагинации)
 * и задачей (для UI-вкладок). Затем исполняется штатный run-e2e.mjs в режиме
 * EBB_E2E_ATTACH_BACKEND_URL + EBB_E2E_ATTACH_PASSWORD.
 *
 * Использование (из корня репозитория):
 *   node apps/web/test/e2e/chat-run-e2e.mjs -- apps/web/test/e2e/chat-web.spec.ts
 */
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { spawnManagedChild, waitForChildExit } from "./child-lifecycle.mjs";

const webRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(webRoot, "../..");
const serverMain = resolve(repoRoot, "apps/server/dist/main.js");
const migrationDir = resolve(repoRoot, "apps/server/dist/platform/database/migrations");
const runE2E = resolve(import.meta.dirname, "run-e2e.mjs");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const buildCommand = process.platform === "win32" ? "cmd.exe" : pnpmCommand;
const buildArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm.cmd run server:build"] : ["run", "server:build"];
const ENV_ALLOWLIST = [
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "HERMES_DATA_DIR_SUFFIX", "HERMES_RUNTIME_DIR", "HERMES_HOME", "HERMES_CONFIG", "HERMES_PROFILE", "HERMES_MODEL",
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function runBuild() {
  return new Promise((resolveBuild, reject) => {
    const child = spawnManagedChild(buildCommand, buildArgs, { cwd: repoRoot, env: process.env, shell: false, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolveBuild() : reject(new Error(`server:build failed (${code})`))));
  });
}

async function reservePort() {
  const server = createServer();
  const port = await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("port unavailable"));
      resolvePort(address.port);
    });
  });
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return port;
}

async function waitForReady(origin, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("backend exited before ready");
    const response = await globalThis.fetch(`${origin}/api/v1/health`).catch(() => undefined);
    if (response?.ok) {
      const body = await response.json();
      if (body.lifecycle === "READY") return;
    }
    await wait(100);
  }
  throw new Error("backend READY timeout");
}

async function seedFixtures(home, password, repository) {
  const { createSqliteDatabase } = await import("../../../server/dist/platform/database/sqlite-database.js");
  const { runMigrations } = await import("../../../server/dist/platform/database/migrator.js");
  const { seedE2ELocalUser } = await import("../../../server/test/e2e/fixtures/auth-fixture.mjs");
  const { ApprovalService } = await import("../../../server/dist/modules/approvals/approval-service.js");
  const { OnboardingService } = await import("../../../server/dist/modules/projects/onboarding-service.js");
  const { ChatRepository } = await import("../../../server/dist/modules/chat/chat-repository.js");
  const { ProjectConfigRepository } = await import("../../../server/dist/modules/projects/project-config-repository.js");
  const { ProjectConfigService } = await import("../../../server/dist/modules/projects/project-config-service.js");
  const { parseProjectConfigYaml } = await import("../../../server/dist/platform/config/project-config.js");
  const { createHash } = await import("node:crypto");

  const migrations = readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).map((f) => {
    const m = /^(\d+)_([^.]*)\.sql$/.exec(f);
    return { version: Number(m[1]), name: m[2], sql: readFileSync(join(migrationDir, f), "utf8") };
  });

  const database = createSqliteDatabase(join(home, "ebb-orchestrator.db"));
  try {
    runMigrations(database, migrations);
    const hasher = (await import("../../../server/dist/platform/security/password-hasher.js")).createArgon2PasswordHasher();
    await seedE2ELocalUser({ database, passwordHasher: hasher, password, now: new Date().toISOString() });

    const approvals = new ApprovalService(database);
    const onboarding = new OnboardingService(database, approvals);
    const draft = await onboarding.discoverAndCreateDraft(repository);
    onboarding.requestApproval(draft.projectId, {
      defaultBranch: "master", workflow: "standard", roles: ["developer"], guidelines: ["chat web E2E only"],
    });
    onboarding.approve(draft.projectId);
    onboarding.activate(draft.projectId);

    // Approved Project Config (требуется RunContextAssembler).
    const projectYaml = "schema_version: 1\nproject:\n  name: test-project\n  default_branch: master\n";
    const sourceFiles = { ".ebb-orchestrator/project.yaml": Buffer.from(projectYaml, "utf8").toString("base64") };
    const manifestJson = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: createHash("sha256").update(projectYaml, "utf8").digest("hex") }] });
    const manifestHash = createHash("sha256").update("ebb-project-config-manifest-v1\0", "utf8").update(manifestJson, "utf8").digest("hex");
    const sortValue = (value) => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, entry]) => [key, sortValue(entry)]))
      : value;
    const payload = { project: parseProjectConfigYaml(projectYaml), files: sourceFiles };
    const candidate = new ProjectConfigRepository(database).capture({
      projectId: draft.projectId, sourceHead: "a".repeat(40), manifestJson, manifestHash,
      sourceFilesJson: JSON.stringify(sourceFiles), normalizedPayloadJson: JSON.stringify(sortValue(payload)), schemaVersion: 1,
    });
    new ProjectConfigService(database, approvals).approve(draft.projectId, candidate.candidate_id, candidate.manifest_hash);

    // Беседа с историей (>50 сообщений) для cursor-пагинации в UI.
    const chat = new ChatRepository(database);
    const conversation = chat.createConversation(draft.projectId, null);
    for (let index = 0; index < 60; index += 1) {
      chat.appendMessage({ conversationId: conversation.id, role: "user", kind: "text", content: `история ${index}` });
    }

    // Задача для проверки вкладок TaskPage.
    const taskId = randomUUID();
    database.run(
      `INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at)
       VALUES($id,$projectId,'TASK-E2E-1','E2E задача','DRAFT',$contract,1,$now,$now)`,
      {
        id: taskId, projectId: draft.projectId, now: new Date().toISOString(),
        contract: JSON.stringify({
          version: 1, goal: "goal", context: "context", requirements: [], acceptanceCriteria: ["done"],
          dependencies: [], nonGoals: [], definitionOfDone: ["done"],
        }),
      },
    );

    return { projectId: draft.projectId, conversationId: conversation.id, taskId };
  } finally {
    database.close();
  }
}

async function main() {
  let root = "";
  let backend;
  let backendUrl;
  const playwrightArgs = process.argv.slice(2);
  if (playwrightArgs[0] === "--") playwrightArgs.shift();

  try {
    await runBuild();
    root = await mkdtemp(join(tmpdir(), "ebb-chat-web-e2e-"));
    const home = join(root, "home");
    const repository = join(root, "repository");
    await mkdir(home, { recursive: true });
    await mkdir(repository, { recursive: true });

    const { GitCli } = await import("../../../server/dist/modules/git/git-cli.js");
    const git = new GitCli();
    await git.run(repository, ["init", "--initial-branch=master"]);
    await git.run(repository, ["config", "user.email", "chat-web-e2e@example.invalid"]);
    await git.run(repository, ["config", "user.name", "Chat Web E2E"]);
    await writeFile(join(repository, "README.md"), "# chat web e2e\n");
    await git.run(repository, ["add", "README.md"]);
    await git.run(repository, ["commit", "-m", "init"]);

    const password = randomUUID();
    await seedFixtures(home, password, repository);

    const backendPort = await reservePort();
    backendUrl = `http://127.0.0.1:${backendPort}`;
    const env = {};
    for (const name of ENV_ALLOWLIST) {
      const inherited = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
      if (inherited && process.env[inherited] !== undefined) env[name] = process.env[inherited];
    }
    env.EBB_ORCHESTRATOR_HOME = home;
    env.PORT = String(backendPort);
    backend = spawnManagedChild(process.execPath, [serverMain], { cwd: repoRoot, env, shell: false, stdio: ["ignore", "inherit", "pipe"], windowsHide: true });
    await waitForReady(backendUrl, backend);

    const runnerEnv = {
      ...process.env,
      EBB_E2E_ATTACH_BACKEND_URL: backendUrl,
      EBB_E2E_ATTACH_PASSWORD: password,
      EBB_E2E_CHAT_FULLSTACK: "1",
      EBB_E2E_CHAT_BACKEND_DB: join(home, "ebb-orchestrator.db"),
    };
    if (process.env.EBB_RUN_CHAT_HERMES_ACCEPTANCE) runnerEnv.EBB_RUN_CHAT_HERMES_ACCEPTANCE = process.env.EBB_RUN_CHAT_HERMES_ACCEPTANCE;

    const runner = spawnManagedChild(process.execPath, [runE2E, ...(playwrightArgs.length > 0 ? ["--", ...playwrightArgs] : [])], {
      cwd: repoRoot, env: runnerEnv, shell: false, stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    });
    const exitCode = await new Promise((resolveExit, reject) => {
      runner.once("error", reject);
      runner.once("exit", (code) => resolveExit(code ?? 1));
    });

    if (exitCode !== 0) {
      console.error(`[chat-run-e2e] runner (${runE2E}) exited with code ${exitCode}`);
    }

    if (backend && (backend.exitCode === null) && (backend.signalCode === null)) {
      backend.kill("SIGTERM");
      await waitForChildExit(backend, 15_000).catch(() => undefined);
    }
    process.exitCode = exitCode;
  } finally {
    if (backend && backend.exitCode === null && backend.signalCode === null) {
      try { backend.kill("SIGTERM"); await waitForChildExit(backend, 10_000); } catch { /* ignore */ }
    }
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main().catch((error) => {
  console.error("[chat-run-e2e] fatal:", error);
  process.exit(1);
});
