---
id: plan-15-08
kind: plan
roadmap: 01
stage: 13
status: planned
title: Verification, security evidence и independent plan review
created: 2026-09-25
updated: 2026-09-25
depends_on:
  - plan-15-03
  - plan-15-09
  - plan-15-04
  - plan-15-05
  - plan-15-06
  - plan-15-07
specs:
  - ../specs/01-system-design.md
  - ../specs/02-web-ui-recovery-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - package.json
  - apps/server/package.json
  - apps/web/package.json
  - apps/server/src/main.ts
  - apps/server/test/e2e/transport-origin.test.ts
  - apps/web/vite.config.ts
  - apps/web/playwright.config.ts
  - apps/web/test/e2e/run-e2e.mjs
  - apps/web/test/e2e/web-e2e-server.mjs
  - scripts/docs-governance.test.mjs
  - scripts/roadmap-generator-cli.mjs
  - docs/roadmap/01-roadmap.md
---

# 15-08. Verification, governance reconciliation и independent plan review

**Результат:** claims backed by exact focused, full, real HTTP and real browser output; docs/governance are reconciled through the repository’s actual scripts; plan cannot be marked complete on mocks or stale completion files.

## Verification order

1. Focused server auth/migration/wizard/security/onboarding/scheduler tests, including the server-owned `apps/server/test/platform/security/auth-onboarding-contract.test.ts`; the contracts package typecheck/test covers only serializable shared values. Run focused Web client/auth/SSE/onboarding/localization/accessibility tests. Every behavior change must show RED before implementation and GREEN after.
2. Real HTTP security matrix using `apps/server/test/e2e/transport-origin.test.ts`: seeded user, login with exact Origin exception, exact Set-Cookie directives, cookie restore after backend restart, CSRF rotation, 30-minute idle, 24-hour absolute expiry, idempotent logout, wrong/missing user safe `401`, missing/revoked session `401`, bad Origin/CSRF `403`, no bootstrap/query/local fallback, SSE 401 behavior.
3. Run the existing root `server:build` before browser E2E and require exit code 0; `apps/web/test/e2e/run-e2e.mjs` enforces the same ordering. Then run `pnpm --filter @ebb-orchestrator/web test:e2e`: create a fresh OS-temp `EBB_ORCHESTRATOR_HOME`, assert the exact database `<home>/ebb-orchestrator.db`, seed the singleton user before any HTTP listener through the one matching IPC `{ type: "seed-password", requestId, password }` / `{ type: "seeded", requestId }` exchange, require health `200` JSON `{ status: "ok", lifecycle: "READY" }`, and pass only the non-secret `EBB_E2E_PASSWORD_CHANNEL` and `EBB_E2E_CONTROL_CHANNEL` endpoints to Playwright. The real browser test logs in, captures the cookie-backed `expiresAt`, performs `restart` over the control channel, waits for the `ready` acknowledgement, reloads and proves the same session is restored from the same SQLite file, then performs acknowledged `stop` and `start` and repeats the assertion. The control channel accepts one JSON-line command per connection and serializes restart; all stop acknowledgements require app/worker/database/listener/lock cleanup, and every start acknowledgement requires the exact health response. The final assertion proves `orchestrator.lock` is absent, the database can be reopened after stop, no `-wal`/`-shm` handle remains, and the isolated home is removed. The run also covers expiry/logout redirect, no privileged bearer in browser storage/JS, Russian accessible names/focus, full discovery→draft→review→approval→approve→activation, draft scheduler block across every named dispatch path, and no bootstrap artifacts after teardown.
The browser lifecycle is launcher-owned and singular: before children, `run-e2e.mjs` allocates `backendPort` and `frontendPort` by binding loopback `:0` probes, closes each probe, retries on `EADDRINUSE`, starts backend with the allocated port, passes `EBB_E2E_BACKEND_URL=http://127.0.0.1:${backendPort}` to Vite and `EBB_E2E_BASE_URL=http://127.0.0.1:${frontendPort}` to Playwright, then waits for backend health `200 {"status":"ok","lifecycle":"READY"}` and frontend `200` at the injected base URL before starting Playwright with `EBB_E2E_SERVERS_STARTED=1`. `vite.config.ts` validates the backend origin and uses it for the `/api` proxy; `playwright.config.ts` validates the base URL and has no competing `webServer`, fixed URL/port, bootstrap path or second process. `v1-ui.spec.ts` uses relative URLs only. On readiness failure or early child exit it fails non-zero and tears down in reverse order (Playwright → Vite → backend), awaiting acknowledgements and verifying child/lock/SQLite/home cleanup. `web-e2e-server.mjs` owns backend only. This exact dynamic lifecycle is the only supported browser E2E path.

4. Repository gates from actual root scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm server:build`, `pnpm web:build`. Expected exit 0; current known lint error in `create-app.ts` must be resolved, not waived.

## Exact Run / Expected ledger contract

`15-08` must write the final repo-relative ledger only from captured command results; it may not claim a gate from plan text, a stale status file or a synthetic output. The ledger is not complete until it contains one row per command below with the exact command, exit code, concise non-secret stdout/stderr summary and PASS/BLOCKED result:

| Run | Expected and ledger assertion |
|---|---|
| `pnpm --filter @ebb-orchestrator/server test -- auth-repository.concurrency.test.ts` | exit `0`; both worker start orders, revoke idempotence, post-revoke immutability and CSRF final-digest assertions pass; no secret values in output |
| `pnpm --filter @ebb-orchestrator/server test -- transport-origin.test.ts v1-security.test.ts` | exit `0`; the complete logout Origin/session/CSRF matrix passes, including repository-state and cookie-clear assertions |
| `pnpm --filter @ebb-orchestrator/server test -- scheduler.test.ts resource-lock-service.test.ts runs-dispatch.test.ts run-event-handlers.test.ts epic-orchestrator.test.ts scheduler-projection.test.ts scheduler-fixture-inventory.test.ts` | exit `0`; every named scheduler guard boundary blocks missing/PROPOSED onboarding before run/phase/reservation writes, active onboarding remains dispatchable, all 20 fixture files select a mode, and immutable migration `013`/`014` inserts are excluded from runtime-source counts |
| `pnpm server:build` | exit `0`; built server exists before browser E2E |
| `pnpm --filter @ebb-orchestrator/web test:e2e` | exit `0`; launcher-selected loopback backend/frontend ports are handed off as non-secret URLs, exact backend/Vite readiness gates pass, Playwright uses the injected baseURL, real login/restart/stop/start/restore works, and no-bootstrap teardown plus isolated-home/lock/SQLite cleanup assertions pass |
| `node --test apps/web/test/e2e/credential-handoff.test.mjs` | exit `0`; no production fixture import, secret-bearing handoff, bootstrap artifact, fixed E2E port/baseURL or stale launcher assumption remains |
| `pnpm docs:check` (before roadmap generation) | exit `0`; all plan/ledger metadata is parser-valid |
| `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` | exit `0`; stdout is captured verbatim and names the repo-relative output plus plan count |
| `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` | exit `0`; stdout is captured verbatim as `Roadmap generated: docs/roadmap/01-roadmap.md` and `Plans included: <n>`; read-back finds exactly ten `plan-15` entries: parent plus nine children `15-01` through `15-09`; parent is `in_progress`, historical `15-01`–`15-03` are `completed`, and planned `15-09` plus `15-04`–`15-08` have valid dependencies and no duplicate IDs |
| `pnpm docs:check` (after generated roadmap) | exit `0`; the ledger records the exact second check output and the generated roadmap is canonical, not hand-edited |
| `pnpm docs:test` | exit `0`; this is the required final documentation gate on Windows and POSIX; any failure remains a ledger blocker |
| `git diff --check` | exit `0`; no whitespace errors after all documentation writes |

The final ledger must therefore include the exact `docs:check`/`docs:test`/`git diff --check` exit codes, the exact roadmap command stdout, the exact count and IDs/status/stage/dependency/no-duplicate verification, generated output path, no-bootstrap/no-secret verification result, and every unresolved blocker. It must contain no absolute host paths, password, raw session/CSRF token, hash/digest, credential-bearing URL, environment secret, external cache path or invented result. If any Run cannot execute, record `BLOCKED` with the real error and stop short of `APPROVED`; never replace it with an expected result.

## Explicit Create/Modify/Verify task scope

- **Create (owner: `15-08`):** `docs/architecture/plans/governance/evidence/05-plan-15-roadmap-reconciliation.md`. Its frontmatter must use only the parser-allowed values `id: ledger-05`, `kind: ledger`, `status: draft`, plus `title`, `created: 2026-09-25` and `updated: 2026-09-25`; do not use `kind: evidence`, an `evidence-*` ID or `status: planned`. The ledger must contain only non-secret, repo-relative evidence: the exact command lines, exit codes and stdout for the `docs:roadmap` dry-run/write, both `docs:check` runs and final `docs:test`; the generated output path; the exact count of matching `plan-15` entries; the verified IDs/status/stage/dependency/no-duplicate results; and any unresolved blocker. It must not contain absolute host paths, credentials, tokens, synthetic roadmap output or cache paths.
- **Verify (owner: `15-08`):** after the write command, read back both `docs/roadmap/01-roadmap.md` and the new `ledger-05` artifact; confirm the ledger records the real command output and exit codes, the canonical roadmap contains exactly ten `plan-15` entries (parent plus nine children `15-01`–`15-09`), parent `in_progress`, historical `15-01`–`15-03` `completed`, and planned `15-09` plus `15-04`–`15-08`, with valid dependencies and no duplicates; then confirm `pnpm docs:check` plus the required final `pnpm docs:test` pass. A failed or unrepresentable check remains an explicit blocker in the ledger and in the final review; it is never replaced by hand-edited/generated-looking evidence.

- **Verify (read-only):** existing `apps/server/test/e2e/transport-origin.test.ts`, `apps/web/vite.config.ts`, `apps/web/playwright.config.ts`, `apps/web/test/e2e/run-e2e.mjs`, `apps/web/test/e2e/web-e2e-server.mjs` and `apps/web/test/e2e/v1-ui.spec.ts` only to execute the ordered verification and capture results. Their implementation changes and the launcher-owned Vite lifecycle belong to `15-04`/`15-07`; `15-08` must not alter them.
- **Modify:** `scripts/docs-governance.test.mjs`, `scripts/roadmap-generator-cli.mjs` and generated `docs/roadmap/01-roadmap.md` only where the ordered governance verification requires it. The generated roadmap remains owned by `pnpm docs:roadmap`, not hand-edited.
- **Verify:** `apps/server/test/platform/security/auth-repository.concurrency.test.ts` only after `15-02` creates it; it is intentionally absent from this plan's frontmatter evidence because it is not currently verifiable.

## Cross-platform docs:test and governance reconciliation task

Before the final documentation gate, modify only the implementation-owned test helper `scripts/docs-governance.test.mjs` so its `writeGeneratedRoadmap` test creates a directory with Node's OS-temporary-directory API (`mkdtemp(join(tmpdir(), "ebb-docs-test-"))`), writes `join(tempDir, "roadmap-test.md")`, and removes that directory with `rm(..., { recursive: true, force: true })` in `finally`. It must not use a hard-coded host path, repository cache, user-home path or external artifact. This is the concrete fix for the observed Windows `ENOENT` and must be covered by the same test.

After README and plan metadata are factual, execute this governance task in this exact order:

1. `pnpm docs:check` — PASS with no new errors.
2. `pnpm docs:roadmap -- --dry-run --output=docs/roadmap/01-roadmap.md` — PASS; capture stdout and confirm it reports the collected plan count and the repo-relative output.
3. `pnpm docs:roadmap -- --output=docs/roadmap/01-roadmap.md` — use the actual root script `scripts/roadmap-generator-cli.mjs`, not a hand-edited table. Capture stdout exactly (`Roadmap generated: docs/roadmap/01-roadmap.md` and `Plans included: <n>`) in the repo-relative review record `docs/architecture/plans/governance/evidence/05-plan-15-roadmap-reconciliation.md`; read back `docs/roadmap/01-roadmap.md` and verify exactly ten matching `plan-15` entries (parent plus nine children `15-01` through `15-09`), parent `in_progress`, `15-01`–`15-03` `completed`, `15-09` plus `15-04`–`15-08` `planned`, stage/dependency graph and no duplicate IDs. Other plans collected by the actual generator are not counted as plan-15 entries.
4. Re-run `pnpm docs:check` after reconciliation and record the exact exit code/output in the same repo-relative evidence record. Do not claim governance completion if the actual generator cannot represent the required metadata; report that as a blocker instead of manually repairing generated output.
5. Run `pnpm docs:test` as the **required final documentation gate** after all roadmap/docs writes. It must PASS on Windows and POSIX; a failure is a remaining blocker and cannot be waived. Only after it passes run `git diff --check`.

No hard-coded host path, external cache artifact, synthetic roadmap response or stale `plan_summary.json`/`plan_verification_status.json` is an input. The canonical output is the checked-in `docs/roadmap/01-roadmap.md` produced by the named root command.

## Assigned recovery and startup acceptance

- Capture only non-secret evidence: command, exit code, test name/count, HTTP status, cookie attribute names, redacted paths and artifact absence. Never record password, raw session/CSRF token, hash bytes, credential-bearing remote URL or environment secret.
- `15-02` owns `apps/server/test/platform/database/backup-restore.test.ts` and the command `pnpm --filter @ebb-orchestrator/server test -- backup-restore.test.ts`; it must close the database before copying/restoring, prove the backup contains the user/onboarding rows, restore after an injected 026 failure, rerun forward migrations and assert no down migration or data loss.
- `15-02` owns migration rollback in `apps/server/test/platform/database/migrator.test.ts` and the command `pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts`; it must assert a failing migration leaves no schema_migrations row or partial table and prevents the startup path from reaching READY.
- `15-03` owns startup cleanup in `apps/server/test/platform/process/startup.test.ts` and `scripts/verify-local-startup.mjs`; the command `pnpm server:build && node scripts/verify-local-startup.mjs` must assert non-TTY first-run failure before listener/workers, successful TTY-adapter creation, second-start READY without prompting, idempotent worker/DB/lock cleanup, no orphan listener and no bootstrap artifact.
- `15-06` owns scheduler recovery assertions in `apps/server/test/modules/scheduler/scheduler.test.ts`: a PROPOSED or missing onboarding config produces `ONBOARDING_NOT_ACTIVE` before any run/phase/reservation row, and activation is required before dispatch.
- Verify restart reconciliation and no orphan lock/listener with `pnpm --filter @ebb-orchestrator/server test -- startup.test.ts scheduler.test.ts`; confirm old bootstrap files are not read or recreated.
- Verify no code path passes local password/session material to `SecretStore`; external SecretStore outage test remains independent.
- Verify scheduler cannot reserve/dispatch a PROPOSED or missing-onboarding project even if a client calls `POST /api/v1/tasks/:id/dispatch`, `RuntimeEventHandlers`, `EpicOrchestrator`, `startWorkflowRuns`, `dispatchTask`, `dispatchAgentRun` or `ResourceLockService.acquire` directly; activation requires the exact approved persisted config.

## Independent review gate

Run the loaded `ebb-review-plan` skill as a read-only independent review against the parent and all nine child plans: `15-auth-onboarding-ui-hardening.md`, `15-01-auth-contract-and-crypto.md`, `15-02-auth-persistence-and-repository.md`, `15-03-auth-cli-and-startup.md`, `15-09-atomic-auth-v2-remediation.md`, `15-04-server-security-boundary.md`, `15-05-web-auth-and-sse.md`, `15-06-onboarding-draft-and-scheduler-guard.md`, `15-07-russian-ui-and-artifact-cleanup.md`, and `15-08-verification-and-review.md`. Required review checklist: every approved criterion mapped, exact existing symbols/paths, dependency graph acyclic, no unavailable API/dependency invented, each behavior has RED → GREEN and concrete command/Expected, deterministic two-worker/barrier readiness/controlled-release/acquisition-acknowledgement snapshots for both 15-09 race orders, TTL/CSRF/rollback/trust boundary/draft guard/memory-only E2E fixture/docs:test/governance reconciliation explicit, and no hidden scope. Fix findings in a separate Plan Fixer round and re-review; maximum three rounds. Required verdict is `APPROVED`; `BLOCKER` or `IMPORTANT` leaves this plan unresolved.

## Final acceptance

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm server:build`, `pnpm web:build`, focused security suites, real HTTP and real browser E2E all pass.
- `pnpm docs:check` passes after roadmap reconciliation and `pnpm docs:test` is the final required docs gate with exit 0 on the supported platforms.
- No bootstrap query-token, `session/new?local=true`, browser bearer, raw credential or temporary bootstrap artifact remains in supported runtime/fixture paths; the test-only seed is explicit and production-inaccessible.
- README and canonical generated roadmap reconciliation are factual and cite actual repo-relative evidence; old completion claims are not silently trusted.
- `git diff --check` passes; no push/merge/master operation; any commit is outside this draft request.

**Depends on:** all implementation parts. **Unresolved blockers are reported separately until every gate above is actually run.**