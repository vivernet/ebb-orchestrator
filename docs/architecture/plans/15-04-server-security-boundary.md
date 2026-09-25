---
id: plan-15-04
kind: plan
roadmap: 01
stage: 13
status: planned
title: Server auth routes, CSRF и security boundary
created: 2026-09-25
updated: 2026-09-25
depends_on:
  - plan-15-01
  - plan-15-02
  - plan-15-03
specs:
  - ../specs/01-system-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - apps/server/src/app/create-app.ts
  - apps/server/src/platform/security/local-session.ts
  - apps/server/test/app/security.test.ts
  - apps/server/test/app/api.test.ts
  - apps/server/test/e2e/transport-origin.test.ts
  - apps/server/test/e2e/v1-security.test.ts
---

# 15-04. Server auth routes, CSRF и security boundary

**Результат:** один injected `AuthService` владеет login/restore/logout/TTL/CSRF; Fastify preHandler больше не имеет bypass или in-memory token authority.

## Files and interfaces

- Create `apps/server/src/platform/security/auth-service.ts` implementing `AUTH_PORT_CONTRACT_VERSION=1` exactly: `login(password: Readonly<RawSecretBytes>)`, `restoreAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>)`, `authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>)`, `logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null)`, and `hasLocalUser()`, with the exact Promise result unions, `AuthPortErrorCode` mapping and `IssuedSession`/`RotatedCsrf` values defined in 15-01. Construct it only as `new LocalAuthService(repository: AuthRepository, passwordHasher: PasswordHasher, clock: AuthClock)` or `createAuthService(repository: AuthRepository, passwordHasher: PasswordHasher, clock: AuthClock): AuthService`. It accepts no `RandomTokenPort` or `DigestPort`; those ports are owned and injected by `SqliteAuthRepository`. It owns no database transaction and delegates atomic validity/touch/rotation/revocation/logout to the repository. Route adapters zero each mutable raw-secret buffer in `finally` after this call and cookie/response serialization; the service retains none and never returns a password/hash/digest or raw CSRF outside the locked response boundary.
- Modify `apps/server/src/app/create-app.ts` `AppDeps`, `OrchestratorApp`, global `preHandler`, session route registration, `safeEquals`, `createSessionCookie`, `readCookie` and `LOCAL_SESSION_COOKIE`. `AppDeps.authService` is the only auth injection boundary.
- Modify `apps/server/src/main.ts` after the `15-03` migration/wizard gate to compose `createAuthRepository(database, passwordHasher, createNodeRandomTokenPort(), createNodeDigestPort())`, `createAuthService(repository, passwordHasher, clock)`, and pass exactly that service as `createApp({ authService, ... })`. This task owns only the auth-service fields and wiring; it must preserve the separate `onboardingService` composition owned by `15-06` and must not reintroduce a route-level onboarding database/approval dependency.
- Remove `bootstrapToken`, `sessionToken` and `csrfToken` from `OrchestratorApp` production authority. Tests inject a real repository-backed service or a narrowly scoped fake implementing the same auth port; they never set `EBB_DISABLE_AUTH`.
- Remove `EBB_DISABLE_AUTH` branch, query token parsing, `GET /api/v1/session/bootstrap`, and `POST /api/v1/session/new`. `/api/v1/health` remains the only unauthenticated API route. Any legacy path must be absent (`404`) and must not create a session.
- Implement the exact 15-01 route/status matrix, including the login Origin-without-CSRF exception, idempotent invalid-session logout, `HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=86400; Expires=...`, omitted `Secure` on loopback HTTP, and no `Domain`. Login/password errors must not reveal whether a user exists.

### Logout evaluation precedence — normative matrix

`POST /api/v1/session/logout` evaluates inputs in this exact order, before any revocation or cookie mutation: **(1) Origin, (2) session classification, (3) CSRF only for an active session, (4) revocation and clearing**. Missing, malformed or non-exact Origin always returns `403 AUTH_ORIGIN_INVALID`, regardless of cookie or CSRF, and leaves the cookie untouched. With an exact Origin, a missing cookie or malformed/unknown/idle-expired/absolute-expired/revoked session is the idempotent invalid-session branch: return `204` with the clearing cookie, do not inspect or require CSRF, do not create/touch/rotate/revoke anything, and use the same response for all such session states. With an exact Origin and an active session, missing, malformed, stale or wrong CSRF returns `403 AUTH_CSRF_INVALID`, with no revoke and no cookie clear. Only exact Origin + active session + current CSRF performs one conditional transactional revoke and returns `204` with the clearing cookie. A second logout after that revoke takes the invalid-session branch and returns the same `204`.

The repository operation behind this route is exact: `authRepository.logout(rawSessionToken, rawCsrfToken, now): Promise<"REVOKED" | "INVALID_SESSION" | "CSRF_INVALID">`. The route checks exact Origin first and does not call the repository on an Origin failure. For exact Origin it passes the raw cookie/header bytes (or `null`) unchanged; `INVALID_SESSION` maps to idempotent `204` and clearing cookie while ignoring CSRF, `CSRF_INVALID` maps to `403 AUTH_CSRF_INVALID` with no clear/revoke, and `REVOKED` maps to `204` with clearing cookie. Repository/database rejection maps to `503 AUTH_UNAVAILABLE`. The service and route never replace this call with `revokeByToken`, a prior read, or a second transaction.

The tests must cover this complete matrix with repository-state assertions, not only status codes:

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

Replace legacy bootstrap assertions in `apps/server/test/app/security.test.ts`, `apps/server/test/app/api.test.ts`, and `apps/server/test/e2e/v1-security.test.ts` with tests that first authenticate through the supported login route:

- `POST /api/v1/session/login`: exact body/200 DTO, malformed body `400 AUTH_INVALID_REQUEST`, wrong password and missing user identical `401 AUTH_INVALID_CREDENTIALS`, wrong/missing Origin `403 AUTH_ORIGIN_INVALID`, no CSRF header accepted for this endpoint;
- `GET /api/v1/session`: no cookie `401 AUTH_SESSION_REQUIRED`; invalid/expired/revoked `401 AUTH_SESSION_INVALID`; valid cookie `200` with rotated raw CSRF and immutable absolute `expiresAt`; no session creation on failure;
- `POST /api/v1/session/logout`: apply the normative precedence matrix above. Tests must independently cover missing/invalid Origin with absent, unknown, active, idle-expired, absolute-expired and revoked sessions and absent/wrong/current CSRF and assert the repository logout operation is not called; exact Origin with absent/malformed/unknown/expired/revoked session and any CSRF must be the same idempotent `204` + clearing cookie and assert `INVALID_SESSION` caused no row mutation; exact Origin with active session and missing/wrong/stale CSRF must be `403 AUTH_CSRF_INVALID` with no revoke and no cookie clear and assert `CSRF_INVALID` caused no row mutation; exact Origin + active + current CSRF must revoke and return `204` and assert `REVOKED`; every `204` response clears the cookie with the locked flags and repeated logout remains identical. Add a focused service-composition test that constructs `LocalAuthService` with exactly `(repository, passwordHasher, clock)`, delegates all three repository logout classifications, and proves no `RandomTokenPort`/`DigestPort` is accepted or instantiated at the service boundary.
- valid authenticated mutation with missing/wrong Origin or missing/wrong/stale CSRF → `403`; valid synchronizer token succeeds; every repository touch is conditional and transactional;
- no cookie on protected route/SSE → `401`; no handler side effect; GET SSE 401 terminates Web reconnect;
- valid cookie survives a new `createApp`/process over the same DB; idle at 30 minutes and absolute at 24 hours → `401`, no TTL extension on failure;
- `GET /api/v1/session/bootstrap`, any bootstrap header, and `POST /api/v1/session/new?local=true` are `404` and never create a session;
- setting `EBB_DISABLE_AUTH=1` in a production-like app has no bypass effect because the variable is not read; injected test auth is explicit and scoped.

Add RED tests first and record failures. Implement the preHandler/service boundary, then rerun focused tests to GREEN. Keep SecretStore-unavailability assertions in their existing secret-store suites; local login must not depend on them.

## Real transport

Extend `apps/server/test/e2e/transport-origin.test.ts` to use a real HTTP listener and cookie jar, not only `app.inject`: login with exact Origin, Set-Cookie attributes including `Max-Age`/`Expires` and omitted `Secure`, restore after app restart, idle/absolute expiry, idempotent logout, CSRF and disallowed Origin. Derive the actual dynamic port/origin. Expected: 200/204/401/403 match the locked matrix and no bootstrap artifact/token exists.

## Commands / Expected

- `pnpm --filter @ebb-orchestrator/server test -- security.test.ts api.test.ts v1-security.test.ts transport-origin.test.ts` — PASS with all negative cases and no legacy fallback.
- `pnpm --filter @ebb-orchestrator/server typecheck` — PASS.
- `pnpm lint` — PASS; unused legacy handler parameters and raw-token fields are gone.

**Depends on:** 15-01–15-03. **Unblocks:** 15-05, 15-06 and authenticated E2E.
