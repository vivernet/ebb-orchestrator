---
id: plan-15-04
kind: plan
roadmap: 01
stage: 13
status: completed
title: Server auth routes, CSRF и security boundary
created: 2026-09-25
updated: 2026-09-25
depends_on:
  - plan-15-01
  - plan-15-02
  - plan-15-03
  - plan-15-09
specs:
  - ../specs/01-system-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - apps/server/src/app/create-app.ts
  - apps/server/src/platform/security/auth-service.ts
  - apps/server/test/app/security.test.ts
  - apps/server/test/app/api.test.ts
  - apps/server/test/e2e/transport-origin.test.ts
  - apps/server/test/e2e/v1-security.test.ts
---

# 15-04. Server auth routes, CSRF и security boundary

**Результат:** после verified `15-09` один injected v2 `AuthService` владеет login/restore/logout/TTL/CSRF; Fastify preHandler композирует protected routes без bypass, in-memory token authority или validate-then-touch race. 15-04 is the exclusive owner for removing `validateCsrf` adapter references from `create-app.ts` and route tests; it does not alter the internal port/repository/service/fake source-absence scope owned by 15-09.

## Files and interfaces

- **Consume, do not redefine** `apps/server/src/platform/security/auth-service.ts` from verified `15-09`: its `AUTH_PORT_CONTRACT_VERSION=2` `authenticateCsrfAndTouch(rawSessionToken, rawCsrfToken)` is the only protected-mutation operation. This task must not add a service method, repository method, compatibility cast, feature detection or transaction. Route adapters zero each mutable raw-secret buffer in `finally` after the single atomic call and cookie/response serialization; the service retains none and never returns a password/hash/digest or raw CSRF outside the locked response boundary.
- Modify `apps/server/src/app/create-app.ts` `AppDeps`, `OrchestratorApp`, global `preHandler`, session route registration, `safeEquals`, `createSessionCookie`, `readCookie` and `LOCAL_SESSION_COOKIE`. Remove every `validateCsrf` adapter declaration, feature check and call in this file as part of composing the already-verified `authenticateCsrfAndTouch` port. `AppDeps.authService` is the only auth injection boundary; 15-04 is the sole owner of this `create-app.ts` cleanup.
- Modify `apps/server/src/main.ts` after the `15-03` migration/wizard gate to compose `createAuthRepository(database, passwordHasher, createNodeRandomTokenPort(), createNodeDigestPort())`, `createAuthService(repository, passwordHasher, clock)`, and pass exactly that service as `createApp({ authService, ... })`. This task owns only the auth-service fields and wiring; it must preserve the separate `onboardingService` composition owned by `15-06` and must not reintroduce a route-level onboarding database/approval dependency.
- Remove `bootstrapToken`, `sessionToken` and `csrfToken` from `OrchestratorApp` production authority. Tests inject a real repository-backed service or a narrowly scoped fake implementing the v2 auth port; they never set `EBB_DISABLE_AUTH`.
- Remove `EBB_DISABLE_AUTH` branch, query token parsing, `GET /api/v1/session/bootstrap`, and `POST /api/v1/session/new` from the server route boundary. `/api/v1/health` remains the only unauthenticated API route. Any legacy server path must be absent (`404`) and must not create a session. Browser launch/bootstrap artifacts, Web callers and E2E harness cleanup are explicitly pending work owned by 15-05/15-07 and are not 15-04 acceptance.
- Implement the exact 15-01 route/status matrix, including the login Origin-without-CSRF exception, idempotent invalid-session logout, `HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=86400; Expires=...`, omitted `Secure` on loopback HTTP, and no `Domain`. Login/password errors must not reveal whether a user exists.

### Logout evaluation precedence — normative matrix

`POST /api/v1/session/logout` evaluates inputs in this exact order, before any revocation or cookie mutation: **(1) Origin, (2) session classification, (3) CSRF only for an active session, (4) revocation and clearing**. Missing, malformed or non-exact Origin always returns `403 AUTH_ORIGIN_INVALID`, regardless of cookie or CSRF, and leaves the cookie untouched. With an exact Origin, a missing cookie or malformed/unknown/idle-expired/absolute-expired/revoked session is the idempotent invalid-session branch: return `204` with the clearing cookie, do not inspect or require CSRF, do not create/touch/rotate/revoke anything, and use the same response for all such session states. With an exact Origin and an active session, missing, malformed, stale or wrong CSRF returns `403 AUTH_CSRF_INVALID`, with no revoke and no cookie clear. Only exact Origin + active session + current CSRF performs one conditional transactional revoke and returns `204` with the clearing cookie. A second logout after that revoke takes the invalid-session branch and returns the same `204`.

The repository operation behind this route is exact: `authRepository.logout(rawSessionToken, rawCsrfToken, now): Promise<"REVOKED" | "INVALID_SESSION" | "CSRF_INVALID">`. The route checks exact Origin first and does not call the repository on an Origin failure. For exact Origin it passes the raw cookie/header bytes (or `null`) unchanged; `INVALID_SESSION` maps to idempotent `204` and clearing cookie while ignoring CSRF, `CSRF_INVALID` maps to `403 AUTH_CSRF_INVALID` with no clear/revoke, and `REVOKED` maps to `204` with clearing cookie. Repository/database rejection maps to `503 AUTH_UNAVAILABLE`. The service and route never replace this call with `revokeByToken`, a prior read, or a second transaction.

The tests must cover this complete matrix with repository-state assertions, not only status codes. For each no-mutation row, capture and compare `revoked_at`, `last_seen_at`, `idle_expires_at` and `csrf_token_hash`; for the successful row assert exactly one `revoked_at` write and all non-revocation fields are unchanged:

| Origin | Session | CSRF | Expected | State assertion |
|---|---|---|---|---|
| missing or invalid | absent, unknown, active, expired or revoked | absent, wrong or current | `403 AUTH_ORIGIN_INVALID` | no clear/revoke/touch/rotate |
| exact | absent or malformed | absent or wrong | `204` + clearing cookie | no repository mutation |
| exact | unknown | current or wrong | `204` + clearing cookie | no repository mutation |
| exact | idle/absolute expired | absent, wrong or old current value | `204` + clearing cookie | remains expired; no mutation |
| exact | revoked | absent, wrong or old current value | `204` + clearing cookie | remains revoked; timestamps/digest unchanged |
| exact | active | missing, malformed, stale or wrong | `403 AUTH_CSRF_INVALID` | cookie not cleared; `revoked_at` remains `NULL` |
| exact | active | current | `204` + clearing cookie | exactly one revoke; repeat is idempotent `204` |


## RED → GREEN security matrix

Replace legacy bootstrap assertions in `apps/server/test/app/security.test.ts`, `apps/server/test/app/api.test.ts`, and `apps/server/test/e2e/v1-security.test.ts` with tests that first authenticate through the supported login route. Add the RED tests before changing the route/service implementation, run the exact direct-Vitest command below, and record the expected failures (missing v2 method, a `create-app.ts` adapter reference to `validateCsrf`, or unmet assertion), not merely a wrapper-suite failure. The prerequisite's internal source-absence proof remains 15-09-owned and is not reimplemented here:

- `POST /api/v1/session/login`: test Origin precedence before parsing: wrong or missing Origin plus malformed/non-JSON body is always `403 AUTH_ORIGIN_INVALID`; only an exact Origin proceeds to JSON parse/error translation, where malformed body is `400 AUTH_INVALID_REQUEST`. Also cover exact body/200 DTO, wrong password and missing user identical `401 AUTH_INVALID_CREDENTIALS`, and the no-CSRF login exception;
- `GET /api/v1/session`: no cookie `401 AUTH_SESSION_REQUIRED`; invalid/expired/revoked `401 AUTH_SESSION_INVALID`; valid cookie `200` with rotated raw CSRF and immutable absolute `expiresAt`; no session creation on failure;
- `POST /api/v1/session/logout`: apply the normative precedence matrix above. Tests must independently cover missing/invalid Origin with absent, unknown, active, idle-expired, absolute-expired and revoked sessions and absent/wrong/current CSRF and assert the repository logout operation is not called; exact Origin with absent/malformed/unknown/expired/revoked session and any CSRF must be the same idempotent `204` + clearing cookie and assert `INVALID_SESSION` caused no row mutation; exact Origin with active session and missing/wrong/stale CSRF must be `403 AUTH_CSRF_INVALID` with no revoke and no cookie clear and assert `CSRF_INVALID` caused no row mutation; exact Origin + active + current CSRF must revoke and return `204` and assert `REVOKED`; every `204` response clears the cookie with the locked flags and repeated logout remains identical. Add a focused service-composition test that constructs `LocalAuthService` with exactly `(repository, passwordHasher, clock)`, delegates all three repository logout classifications, and proves no `RandomTokenPort`/`DigestPort` is accepted or instantiated at the service boundary.
- valid authenticated mutation with missing/wrong Origin or missing/wrong/stale CSRF → `403`; valid synchronizer token succeeds only through `authenticateCsrfAndTouch`. Add an operation-counting v2 fake for every protected `POST`, `PUT`, `PATCH` and `DELETE` route and assert each accepted mutation makes **exactly one** `authenticateCsrfAndTouch` call and zero `authenticateAndTouch`/restore/rotate/legacy-validation calls; every rejected mutation makes zero authorized-mutation calls. The fake throws on a second or alternate auth operation. The source-absence/v2 seam proof is a completed prerequisite assertion from 15-09, not a route-owned reimplementation;
- no cookie on protected route/SSE → `401`; no handler side effect; GET SSE 401 terminates Web reconnect;
- valid cookie survives a new `createApp`/process over the same DB; exactly `now == issuedAt + 30m` idle and `now == issuedAt + 24h` absolute expiry return `401`, with no TTL extension on failure;
- `GET /api/v1/session/bootstrap`, any bootstrap header, and `POST /api/v1/session/new?local=true` are `404` and never create a session;
- setting `EBB_DISABLE_AUTH=1` in a production-like app has no bypass effect because the variable is not read; injected test auth is explicit and scoped.

Every route-created password, cookie-token and CSRF-token `RawSecretBytes` owner is zeroed with `.fill(0)` in a `finally`, including decode failures after an owner exists, Origin/CSRF rejection, service rejection/throw, cookie serialization failure and response serialization failure. Tests instrument mutable buffers/fakes to assert finally-zeroing on success and every rejected/throwing branch; no `catch`-only cleanup is acceptable. Implement the preHandler/service boundary only after RED evidence, then rerun focused tests to GREEN. Keep SecretStore-unavailability assertions in their existing secret-store suites; local login must not depend on them.

## Real transport

Extend `apps/server/test/e2e/transport-origin.test.ts` to use a real HTTP listener and cookie jar, not only `app.inject`. It must derive the dynamic loopback port/origin and prove: exact-Origin login; `Set-Cookie` `HttpOnly`, `SameSite=Strict`, `Path=/api/v1`, `Max-Age=86400`, paired absolute `Expires`, omitted `Secure` and absent `Domain`; a valid cookie restores after listener/app restart over the same file-backed DB; the exact 30-minute idle and 24-hour absolute boundaries reject without TTL extension; mutation Origin/CSRF success and all 403 rejection paths; idempotent logout and clearing-cookie flags; SSE with absent/invalid cookie is `401` and creates/touches/rotates no session. This transport task owns server routes only; bootstrap artifact/file/fragment scans and browser-harness proof remain pending 15-05/15-07.

## Commands / Expected

- **RED:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/security.test.ts test/app/api.test.ts test/e2e/v1-security.test.ts test/e2e/transport-origin.test.ts` — exits non-zero before implementation because the v2 atomic operation, Origin-before-parse behavior, finally-zeroing or required transport assertions are absent; record the named failing assertions.
- **GREEN:** `pnpm --filter @ebb-orchestrator/server exec vitest run test/app/security.test.ts test/app/api.test.ts test/e2e/v1-security.test.ts test/e2e/transport-origin.test.ts` — PASS; the four named files cover the full logout state matrix with durable row/timestamp assertions, v2 atomic mutation/CSRF-rotation regression, raw-buffer finally-zeroing, Origin-before-parse, and real transport/SSE no-side-effect cases.
- `pnpm --filter @ebb-orchestrator/server typecheck` — PASS.
- `pnpm lint` — PASS; unused legacy handler parameters and raw-token fields are gone.

**Depends on:** 15-01–15-03 and verified 15-09. **Unblocks:** 15-05, 15-06 and authenticated E2E.
