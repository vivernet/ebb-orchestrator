---
id: plan-15-09
kind: plan
status: completed
title: Atomic auth v2 prerequisite remediation
created: 2026-09-25
updated: 2026-09-27
depends_on:
  - plan-15-01
  - plan-15-02
  - plan-15-03
specs:
  - ../specs/01-system-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - apps/server/src/platform/security/auth-ports.ts
  - apps/server/src/platform/security/auth-repository.ts
  - apps/server/src/platform/security/auth-service.ts
  - apps/server/test/helpers/auth.ts
  - apps/server/test/platform/security/auth-onboarding-contract.test.ts
  - apps/server/test/platform/security/auth-repository.test.ts
  - apps/server/test/platform/security/auth-repository.concurrency.test.ts
  - apps/server/test/platform/security/auth-service-red.test.ts
---

# 15-09. Atomic auth v2 prerequisite remediation

**Результат:** до route work `AUTH_PORT_CONTRACT_VERSION=2` является фактически реализованным и проверенным internal server contract: каждая authorized mutation выполняет ровно один `authenticateCsrfAndTouch` вызов, который в одном repository `BEGIN IMMEDIATE` transaction классифицирует session/CSRF и условно touch-ит строку. Отдельный `validateCsrf` отсутствует только в owned ports/repository/service/fake/contract seams; removal of route-adapter references in `create-app.ts` is exclusively 15-04 work.

## Причина и ownership

`15-01`–`15-03` остаются completed/PASS historical tasks: они зафиксировали public contract, durable schema/repository boundary и wizard/startup gate. Однако current source still exposes `AUTH_PORT_CONTRACT_VERSION=1` and `validateCsrf`, so their intended v2 authorized-mutation contract is not usable by `15-04`. This task is the sole remediation owner for the internal v2 auth ports, repository, service, contract tests and fakes. Its ownership excludes `apps/server/src/app/create-app.ts` and every route adapter/reference there; 15-04 is the sole owner for those removals. It must finish and be independently verified before `15-04` changes route composition.

## Files and exact interfaces

- **Modify** `apps/server/src/platform/security/auth-ports.ts`, `auth-repository.ts` and `auth-service.ts`. Export `AUTH_PORT_CONTRACT_VERSION = 2 as const`. `AuthRepository.authenticateCsrfAndTouch(rawSessionToken: Readonly<RawSecretBytes>, rawCsrfToken: Readonly<RawSecretBytes> | null, now: UtcTimestamp): Promise<AuthSessionRecord | "INVALID_SESSION" | "CSRF_INVALID">` and `AuthService.authenticateCsrfAndTouch(rawSessionToken: Readonly<RawSecretBytes>, rawCsrfToken: Readonly<RawSecretBytes> | null): Promise<{ ok: true; value: AuthSessionRecord } | { ok: false; code: "SESSION_INVALID" | "CSRF_INVALID" | "UNAVAILABLE" }>` are the only authorized-mutation seam. Remove every declaration, implementation, cast, optional feature detection and call of `validateCsrf`.
- **Modify** `SqliteAuthRepository.authenticateCsrfAndTouch`. It opens exactly one existing `Database.transaction`/`BEGIN IMMEDIATE` boundary, digests raw inputs inside the repository, selects by session digest, evaluates `revoked_at IS NULL AND $now < idle_expires_at AND $now < absolute_expires_at`, evaluates the current CSRF digest only for an active row, and performs one conditional update of `last_seen_at` and `idle_expires_at`. It returns `INVALID_SESSION` without inspecting CSRF for null, malformed, unknown, revoked, idle-expired or absolute-expired session; returns `CSRF_INVALID` without any write for null, malformed, stale or wrong CSRF on an active row; returns a touched `AuthSessionRecord` only when the conditional update changes exactly one row. It must not call `authenticateAndTouch`, `authenticateAndRotateCsrf`, `revokeByToken`, or a prior validation method.
- **Modify** `LocalAuthService`/`createAuthService`. Construct only as `new LocalAuthService(repository: AuthRepository, passwordHasher: PasswordHasher, clock: AuthClock)` or `createAuthService(repository, passwordHasher, clock)`. It delegates exactly once to repository `authenticateCsrfAndTouch` and maps classifications; it opens no transaction and owns no random/digest port.
- **Modify** `apps/server/test/helpers/auth.ts`, `auth-onboarding-contract.test.ts` and `auth-service-red.test.ts`. Every fake implements the exact v2 service/repository signature. A fake must throw if a caller attempts a second auth operation, so route work can prove one atomic operation rather than validate-plus-touch. The 15-09 source-absence assertion is limited to `auth-ports.ts`, `auth-repository.ts`, `auth-service.ts`, `test/helpers/auth.ts`, `auth-onboarding-contract.test.ts` and `auth-service-red.test.ts`; it fails on `validateCsrf` only in those owned files and must neither read nor assert anything about `create-app.ts` or route tests. Type/value assertions require version `2` and reject the v1 surface.

## RED → GREEN proof

1. Before implementation, add/replace focused assertions in the existing listed tests and run the direct command below. RED must name the current v1 version, missing/incompatible atomic signature, remaining `validateCsrf` source/fake seam, or failing race assertion; do not report only a package-wrapper failure.
2. Implement the v2 port/service/repository change without route edits. Keep `authenticateAndTouch` for safe GET/session restoration only; it is not an authorized mutation substitute.
3. Extend `apps/server/test/platform/security/auth-repository.concurrency.test.ts` with a deterministic two-worker/barrier harness over two independent file-backed SQLite handles. For each race family and each explicit order, each worker first opens its own handle, signals `ready(workerId)`, then blocks. The coordinator waits until both readiness acknowledgements are recorded, releases only the designated first worker, waits for that worker's `acquired BEGIN IMMEDIATE` acknowledgement before releasing the second worker, and waits for the first completion/commit acknowledgement before taking a durable snapshot; it then waits for both completions and takes a second durable snapshot. Run `authenticateCsrfAndTouch(oldSession, oldCsrf, now)` against `authenticateAndRotateCsrf(oldSession, now)` in both orders: authorization-first and rotation-first. Capture the durable pre-race row. The authorized mutation either commits fully before rotation or returns `CSRF_INVALID` with no touch; it never touches after a successful rotation. Assert the final row has exactly the rotation-selected CSRF digest; if authorization loses, `last_seen_at` and `idle_expires_at` equal the pre-race row; if it wins first, the first-completion snapshot records its touch as the only permitted timestamp change before rotation, the final snapshot records the rotation-selected digest, and absolute expiry remains unchanged. The harness must fail on missing/duplicate readiness, release, acquisition or completion acknowledgement rather than infer order from worker launch. Also assert no worker protocol, 15-09-owned source scan or fake contains `validateCsrf`.
4. Preserve the existing touch-vs-logout race under the same deterministic two-worker/barrier protocol in both orders: touch-first and logout-first. Capture durable snapshots before the race, after the controlled first completion and after both completions. Its assertions compare `revoked_at`, `last_seen_at`, `idle_expires_at` and `csrf_token_hash`: once logout wins, every later touch or rotation returns invalid and changes none of those fields; when touch wins first, only its permitted timestamps may differ in the first-completion snapshot before logout revokes the row. A wrong-CSRF authorized mutation returns `CSRF_INVALID` and leaves the complete durable row unchanged.
5. GREEN requires the exact direct command to pass, then server typecheck. The scoped independent review must verify that source absence, type-level contract, fake behavior, one-transaction implementation and both race families all hold. Only then may the controller mark `15-09` DONE/PASS and make `15-04` READY.

## Commands / Expected

- **RED:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/security/auth-onboarding-contract.test.ts test/platform/security/auth-repository.test.ts test/platform/security/auth-repository.concurrency.test.ts test/platform/security/auth-service-red.test.ts` — exits non-zero before remediation and identifies v1/`validateCsrf`/atomic-race evidence.
- **GREEN:** the same direct Vitest command — exit 0; every named file passes, including source absence, v2 signatures/fakes, one-transaction authorized mutation, touch-vs-logout in both orders, and rotation-vs-authorized-mutation in both orders with durable-row assertions.
- `pnpm --filter @ebb-orchestrator/server typecheck` — exit 0; no cast or optional v1 seam remains.
- `pnpm docs:check && pnpm docs:test && git diff --check` — exit 0; documentation graph and formatting remain valid.

**Depends on:** 15-01–15-03. **Unblocks:** 15-04 only after verified DONE/PASS.
