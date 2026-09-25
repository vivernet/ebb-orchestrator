---
id: plan-15-03
kind: plan
roadmap: 01
stage: 13
status: completed
title: First-run CLI wizard и startup composition
created: 2026-09-25
updated: 2026-09-25
depends_on:
  - plan-15-02
specs:
  - ../specs/01-system-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - apps/server/src/main.ts
  - apps/server/src/bin/ebb-orchestrator-mcp.ts
  - apps/server/test/platform/process/startup.test.ts
  - scripts/run-server.js
  - start.bat
---

# 15-03. First-run CLI wizard и startup composition

**Результат:** первый запуск без singleton user останавливается на безопасном TTY wizard; после успешной записи hash сервер продолжает штатный `STARTING → RECOVERING → READY`.

## Files and symbols

- Create `apps/server/src/platform/security/local-user-wizard.ts` exporting `runLocalUserWizard(input, output, authRepository, options)`. It must require `input.isTTY === true` and `output.isTTY === true`, read password and confirmation from the TTY without argv/env/file values, disable/restore terminal echo safely, never print the password/hash, and return only success/failure status. A non-TTY is an actionable fail-closed error before listener/worker/READY.
- Modify `apps/server/src/main.ts` top-level startup composition around `runMigrations`, auth repository construction, `createApp`, `startSystem`, `app.listen`: after migrations and before services become READY, call `hasLocalUser`; if absent, run the wizard; if present, never prompt. This task does not construct `AuthService`, add `authService` to `AppDeps`, or pass it to `createApp`; the final auth-service/createApp composition is owned by `15-04` after this wizard boundary is complete. `SecretStore` remains separately composed for external credentials.
- `apps/server/package.json`: expose no password-taking command. The supported start path is `pnpm start`, which invokes the built `dist/main.js`; no additional password-taking bin/script is created. Reuse `readline` precedent from `apps/server/src/bin/ebb-orchestrator-mcp.ts`.
- Production `main.ts` must not import anything under `apps/server/test/`; no `EBB_DISABLE_AUTH` branch, test password, fixture adapter or test-only environment switch may influence production composition.

The `15-03` implementation boundary is intentionally narrow: it may modify the wizard and the startup gate in `main.ts`, but it must not modify `create-app.ts`, add `AppDeps.authService`, construct `LocalAuthService`, or pass an auth service into `createApp`. `15-04` consumes the repository/wizard composition and owns the final `main.ts` auth-service construction plus `createApp({ authService })` call. The startup tests in this task use the repository/wizard boundary only and must not assert an undocumented `AuthService` dependency.

## RED → GREEN

1. Add tests to the new `apps/server/test/platform/security/local-user-wizard.test.ts` and extend `apps/server/test/platform/process/startup.test.ts`:
   - non-TTY returns actionable error and does not create user;
   - first prompt plus mismatched confirmation returns failure and no user;
   - matching password creates exactly one user and stores only a versioned hash;
   - second startup with an existing user makes zero prompt calls;
   - input/output adapters cannot receive password in logs; terminal echo restoration runs on success, mismatch and thrown IO error;
   - DB/migration failure prevents `app.listen` and worker start; lock/DB cleanup remains idempotent.
2. Run focused wizard/startup tests before implementation; expected RED because no wizard/auth composition exists.
3. Implement module and startup injection; expected GREEN for all cases.
4. Add `scripts/verify-local-startup.mjs`, a cross-platform Node harness using `spawn(process.execPath, args, { cwd: repositoryRoot, env: isolatedEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] })`, `fs.mkdtemp`, `fs.rm` and an OS-temporary isolated home. The harness runs the built server once with no user and a pipe, asserts the non-TTY fail-closed exit before listener/worker/READY, runs the module-level TTY adapter test for successful user creation, then starts the same built server against the persisted DB and asserts health/readiness, no password prompt, no bootstrap file and clean termination. The harness never puts a password in argv, environment, files or logs; the real TTY success contract remains in `local-user-wizard.test.ts`.

## Startup / recovery policy

Wizard is after migration and before listener/READY. Failure is fail-closed: no anonymous mode, no default password, no worker. Re-run start interactively to recover. There is no v1 password recovery/reset command; add it only after a separate approval. The old bootstrap file and fragment are not migration inputs and must not be read.

## Commands / Expected

- `pnpm --filter @ebb-orchestrator/server test -- local-user-wizard.test.ts startup.test.ts` — PASS; non-TTY and mismatch are safe failures, successful first run persists one user.
- `pnpm --filter @ebb-orchestrator/server typecheck` — PASS.
- `pnpm server:build && node scripts/verify-local-startup.mjs` — PASS; the pipe-driven production process fails closed before listening without a TTY, the TTY adapter test persists exactly one user, the second isolated-home process reaches READY without prompting, and teardown removes the lock/database handles without creating a bootstrap artifact.

**Depends on:** 15-02. **Unblocks:** 15-04 and real E2E fixture work.
