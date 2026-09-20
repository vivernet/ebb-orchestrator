# Production readiness hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use \`superpowers:executing-plans\` to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Сделать утверждённый local-first v1 безопасным и доказуемо готовым к production: без потери dirty worktree, ложного сохранения секретов, unwired local paths и ложноположительных E2E.

**Architecture:** Исправления остаются в existing modular monolith. Git cleanup становится fail-closed и path-confined; SecretStore получает явный защищённый backend; \`main.ts\` становится composition root с validated home paths. Browser tests отделяют mocked UI от настоящего backend E2E.

**Tech Stack:** TypeScript, Node.js, Fastify, Vitest, Playwright, SQLite, native Git CLI, pnpm.

**Spec:** \`docs/architecture/specs/2026-09-20-production-readiness-hardening-design.md\`

## Global Constraints

- Не расширять v1: без Infisical Cloud, network-dependent secrets backend, новых workflow и approval semantics.
- Git operations используют \`shell:false\`, hooks disabled; final merge остаётся под явным approval.
- SQLite не содержит plaintext secrets; error не возвращает secret value.
- Любой destructive cleanup требует path confinement и подтверждённо clean worktree.
- Все production paths происходят из \`resolveOrchestratorHome\`.
- Комментарии/JSDoc и commit messages — на русском языке.
- Не push, не merge и не удалять worktree/ветки без отдельного разрешения пользователя.

## Review Focus

- Dirty managed worktree при ошибке \`git worktree remove\` остаётся на диске и в DB — Task 1 test \`keeps a dirty managed worktree when git removal fails\`.
- Path вне configured managed root никогда не удаляется fallback-логикой — Task 1 test \`rejects fallback cleanup outside managed root\`.
- Недоступный keyring возвращает controlled service-unavailable error и не создаёт metadata row — Task 2 tests \`rejects store when backend is unavailable\` и route test.
- Ошибка SQLite после успешной keyring-записи компенсируется delete — Task 2 test \`compensates keyring entry when metadata persistence fails\`.
- E2E при недоступном backend завершается ошибкой — Task 4 \`health endpoint is served by the launched backend\`.

---

## File Structure

- \`apps/server/src/modules/git/worktree-manager.ts\` — fail-closed removal and confinement helper.
- \`apps/server/src/modules/git/integration-service.ts\` — integration cleanup uses integration-worktree status.
- \`apps/server/test/modules/git/worktree-manager.test.ts\`, \`integration-service.test.ts\` — real temporary Git regressions.
- \`apps/server/src/platform/security/keyring-secret-store.ts\` — injected keyring port, availability error, compensating store.
- \`apps/server/src/platform/security/secret-store.ts\`, \`apps/server/src/app/routes/secrets.ts\`, \`create-app.ts\` — typed store dependency and safe HTTP error mapping.
- \`apps/server/test/platform/security/secret-store.test.ts\`, \`apps/server/test/app/security.test.ts\` — no partial store / no plaintext response.
- \`apps/server/src/main.ts\`, \`hermes-runtime-adapter.ts\`, \`apps/server/test/main.test.ts\` — pure production composition and home-bound paths.
- \`apps/web/playwright.config.ts\`, \`apps/web/test/e2e/v1-ui.spec.ts\`, \`README.md\` — controlled backend E2E and operator docs.

### Task 1: Безопасное удаление worktree и integration worktree

**Files:**
- Modify: \`apps/server/src/modules/git/worktree-manager.ts\`
- Modify: \`apps/server/src/modules/git/integration-service.ts\`
- Modify: \`apps/server/test/modules/git/worktree-manager.test.ts\`
- Modify: \`apps/server/test/modules/git/integration-service.test.ts\`

**Interfaces:**
- Consumes: \`GitCli.run(cwd, args)\`, \`WorktreeRepository.findById/remove\`.
- Produces: \`removeWorkspace(id): Promise<void>\` and \`cleanupIntegration(attempt): Promise<void>\` that reject without deleting a dirty or out-of-root directory.

- [ ] **Step 1: Write failing worktree regressions**

Add a real temporary repository case:

\`\`\`ts
it("keeps a dirty managed worktree when git removal fails", async () => {
  const worktree = await manager.createTaskWorkspace("dirty", repoPath, "master");
  writeFileSync(join(worktree.path, "uncommitted.txt"), "keep me");
  await expect(manager.removeWorkspace(worktree.id)).rejects.toThrow("Cannot remove dirty worktree");
  expect(existsSync(join(worktree.path, "uncommitted.txt"))).toBe(true);
});
\`\`\`

Also inject a Git failure after clean status and assert fallback rejects a path outside the configured root.

- [ ] **Step 2: Verify RED**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/modules/git/worktree-manager.test.ts\`

Expected: FAIL because current implementation checks \`repoPath\` and deletes the dirty worktree.

- [ ] **Step 3: Write failing integration cleanup regression**

Prepare integration, write an uncommitted file in \`attempt.worktreePath\`, invoke cleanup and assert the file remains with a dirty-worktree error.

- [ ] **Step 4: Verify RED**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/modules/git/integration-service.test.ts\`

Expected: FAIL because cleanup checks \`attempt.repoPath\` then recursively deletes \`attempt.worktreePath\`.

- [ ] **Step 5: Implement minimal fail-closed cleanup**

Check status in the actual worktree, reject non-empty porcelain output, constrain the path to its configured managed root, and use \`git worktree remove\`. Filesystem fallback is permitted only for a clean, confined orphan and must re-check status/confinement immediately before deletion. It never runs after dirty-status or general Git error.

- [ ] **Step 6: Verify GREEN**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/modules/git/worktree-manager.test.ts test/modules/git/integration-service.test.ts\`

Expected: PASS with dirty artifacts preserved.

- [ ] **Step 7: Commit**

\`\`\`bash
git add apps/server/src/modules/git/worktree-manager.ts apps/server/src/modules/git/integration-service.ts apps/server/test/modules/git/worktree-manager.test.ts apps/server/test/modules/git/integration-service.test.ts
git commit -m "Исправить безопасную очистку Git worktree"
\`\`\`

### Task 2: Fail-closed KeyringSecretStore

**Files:**
- Modify: \`apps/server/src/platform/security/keyring-secret-store.ts\`, \`secret-store.ts\`
- Modify: \`apps/server/src/app/routes/secrets.ts\`, \`apps/server/src/app/create-app.ts\`
- Modify: \`apps/server/test/platform/security/secret-store.test.ts\`, \`apps/server/test/app/security.test.ts\`
- Modify: \`apps/server/package.json\`, \`pnpm-lock.yaml\` only if a verified production keyring package is required.

**Interfaces:**
- Consumes: narrow \`KeyringBackend\` (\`setPassword/getPassword/deletePassword\`) and \`Database.run\`.
- Produces: \`SecretStoreUnavailableError\`, compensating \`store\`, and HTTP \`503\` without plaintext.

- [ ] **Step 1: Write failing SecretStore tests**

\`\`\`ts
it("rejects store when backend is unavailable", async () => {
  const store = new KeyringSecretStore(sqliteDb, { backend: undefined });
  await expect(store.store("svc", "name", "secret")).rejects.toThrow("Secret storage is unavailable");
  expect(await store.listMetadata("svc")).toEqual([]);
});
\`\`\`

Add a fake backend where \`setPassword\` succeeds but SQLite insert throws; assert \`deletePassword\` is called once.

- [ ] **Step 2: Verify RED**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/platform/security/secret-store.test.ts\`

Expected: FAIL because current code reports success without keyring and has no compensation.

- [ ] **Step 3: Write failing authenticated route test**

Inject unavailable SecretStore through \`createApp\`; POST with valid session/origin/CSRF and assert \`503\`, generic error and no metadata row.

- [ ] **Step 4: Verify RED**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/app/security.test.ts\`

Expected: FAIL because the route creates a hidden store and returns \`201\`.

- [ ] **Step 5: Implement minimal backend port and error boundary**

Make availability explicit, write keyring before metadata, compensate keyring on metadata failure, and retain metadata when backend revoke fails. Inject Store through route deps and map only unavailable error to \`503\`. No response/log contains a secret value.

- [ ] **Step 6: Install a production keyring dependency only if verified compatible**

Use the lockfile and verify runtime import on Windows. If compatibility cannot be proven, do not silently add a dependency: production startup exposes unavailable storage and docs name the prerequisite.

- [ ] **Step 7: Verify GREEN**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/platform/security/secret-store.test.ts test/app/security.test.ts\`

Expected: PASS; no partial metadata or plaintext response.

- [ ] **Step 8: Commit**

\`\`\`bash
git add apps/server/src/platform/security apps/server/src/app/routes/secrets.ts apps/server/src/app/create-app.ts apps/server/test/platform/security/secret-store.test.ts apps/server/test/app/security.test.ts apps/server/package.json pnpm-lock.yaml
git commit -m "Сделать хранилище секретов отказоустойчивым"
\`\`\`

### Task 3: Production composition и единое Orchestrator home

**Files:**
- Modify: \`apps/server/src/main.ts\`, \`apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts\`
- Modify: \`apps/server/src/platform/home/orchestrator-home.ts\` only if a named path is missing.
- Create or modify: \`apps/server/test/main.test.ts\`

**Interfaces:**
- Consumes: \`OrchestratorHomePaths\`, \`ProcessExecutor\`, existing Git/runtime services.
- Produces: pure composition factory used by \`main.ts\`; runtime artifacts under \`home.runtime\`, worktrees under \`home.worktrees\`.

- [ ] **Step 1: Write failing composition/path test**

Supply temporary \`EBB_ORCHESTRATOR_HOME\`, build dependencies without listen/spawn and assert worktree, integration, Hermes results and checkpoints begin under it.

- [ ] **Step 2: Verify RED**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/main.test.ts\`

Expected: FAIL because production does not compose Git services and Hermes defaults use OS temp/home.

- [ ] **Step 3: Implement a pure composition root**

Construct shared \`WorktreeManager({ worktreeDir: home.worktrees })\`, \`IntegrationService({ worktreeDir: join(home.worktrees, "integration"), database })\`, configured Hermes adapter and reconciliation callbacks after migrations, before listen. Route code keeps service dependencies; it does not get shell/Git access.

- [ ] **Step 4: Verify GREEN**

Run: \`pnpm --filter @ebb-orchestrator/server test -- test/main.test.ts\`

Expected: PASS without listener, external command or host mutation outside test home.

- [ ] **Step 5: Commit**

\`\`\`bash
git add apps/server/src/main.ts apps/server/src/modules/runtime/hermes/hermes-runtime-adapter.ts apps/server/src/platform/home apps/server/test/main.test.ts
git commit -m "Собрать production composition из Orchestrator home"
\`\`\`

### Task 4: Настоящий backend E2E и operator documentation

**Files:**
- Modify: \`apps/web/playwright.config.ts\`, \`apps/web/test/e2e/v1-ui.spec.ts\`
- Modify: \`apps/web/package.json\` only for a composed script.
- Modify: \`README.md\`

**Interfaces:**
- Consumes: server start command, Vite proxy environment, one-shot bootstrap endpoint.
- Produces: E2E command launches isolated backend+web and fails on transport failure.

- [ ] **Step 1: Write failing backend-backed E2E smoke test**

Replace blanket \`/api/v1/**\` fulfillment with real \`/api/v1/health\` and actual browser session bootstrap. Keep mocked tests only when explicitly named browser-contract tests.

- [ ] **Step 2: Verify RED**

Run: \`pnpm --filter @ebb-orchestrator/web test:e2e\`

Expected: FAIL with connection refusal because current config launches only Vite.

- [ ] **Step 3: Implement controlled dual-server harness**

Configure Playwright \`webServer\` entries for server with disposable \`EBB_ORCHESTRATOR_HOME\` and Vite proxy target. Test a non-mocked health response. Never use developer production home.

- [ ] **Step 4: Verify GREEN**

Run: \`pnpm --filter @ebb-orchestrator/web test:e2e\`

Expected: PASS with no \`ECONNREFUSED\`; health and bootstrap come from launched backend.

- [ ] **Step 5: Update operator documentation**

Document keyring prerequisite and \`503\` behaviour, \`EBB_ORCHESTRATOR_HOME\` layout, backup boundaries, launch command and verification commands. Do not document Infisical as current dependency.

- [ ] **Step 6: Commit**

\`\`\`bash
git add apps/web/playwright.config.ts apps/web/test/e2e/v1-ui.spec.ts apps/web/package.json README.md
git commit -m "Проверить Web UI вместе с реальным backend"
\`\`\`

### Task 5: Финальная проверка и security review

**Files:**
- Modify only if verification identifies a defect; every such fix starts with a regression test.

**Interfaces:**
- Consumes: Tasks 1–4 and repository quality scripts.
- Produces: release-readiness evidence; no push or merge.

- [ ] **Step 1: Run complete quality gate**

\`\`\`bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @ebb-orchestrator/web build
pnpm --filter @ebb-orchestrator/web test:e2e
git diff --check
git status --short
\`\`\`

Expected: each command exits zero; worktree contains only intended committed changes or is clean.

- [ ] **Step 2: Run fresh security scan**

Use a new scan, never the failed scan ID. Missing scanner artifacts are a tooling failure, not a pass.

- [ ] **Step 3: Fresh whole-branch review**

Create review package versus implementation base. Critical/important review findings require one TDD fix pass and suite re-run.

- [ ] **Step 4: Commit review fixes if any**

\`\`\`bash
git add <only-reviewed-files>
git commit -m "Устранить замечания production review"
\`\`\`

## Self-Review

- Спецификация покрыта: Task 1 — cleanup; Task 2 — secrets; Task 3 — composition/paths; Task 4 — E2E/docs; Task 5 — verification/security review.
- Каждый Review Focus input закреплён конкретным тестом.
- Нет placeholder задач: все задачи содержат paths, interfaces, RED/GREEN commands и commit.
- Shared names согласованы: \`removeWorkspace\`, \`cleanupIntegration\`, \`KeyringSecretStore\`, \`OrchestratorHomePaths\`.
