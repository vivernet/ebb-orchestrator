---
id: plan-15-05
kind: plan
status: completed
title: Shared auth contract, Web login/restore и SSE expiry
created: 2026-09-25
updated: 2026-09-27
depends_on:
  - plan-15-04
specs:
  - ../specs/01-system-design.md
  - ../specs/02-web-ui-recovery-design.md
evidence:
  - packages/contracts/src/api.ts
  - apps/web/src/api/client.ts
  - apps/web/src/main.tsx
  - apps/web/src/app/App.tsx
  - apps/web/src/api/events.ts
  - apps/web/src/hooks/useEventClient.ts
  - apps/web/test/routing-bootstrap.test.ts
  - apps/web/test/api-client-foundation.test.ts
  - apps/web/test/app-shell.test.tsx
---

# 15-05. Shared auth contract, Web login/restore и SSE expiry

**Результат:** Web использует cookie credentials + CSRF, имеет явные restoring/authenticated/unauthenticated/expired states и прекращает SSE reconnect после 401.

## Files and interfaces

- Modify `packages/contracts/src/api.ts` `apiPaths`: add only the locked `/session/login` and `/session/logout` paths plus auth request/response/error DTO schemas/types and `AUTH_CONTRACT_VERSION = 1`; remove `sessionBootstrap` from public consumers. Also import the exact `ONBOARDING_CONTRACT_VERSION = 1` DTOs from 15-01; keep path builders URL-safe.
- Modify `apps/web/src/api/client.ts` `ApiClient`, `fetchJson`, `authenticatedHeaders`, `bootstrap`, `restoreSession`: remove `sessionToken` and all Authorization construction; always use `credentials: 'same-origin'`, expose `login`, `logout`, `restoreSession`, retain only current raw CSRF in memory, send CSRF on authenticated mutations, classify locked `401` codes as session-expired and never call `session/new`.
- Modify `apps/web/src/main.tsx` `consumeLaunchToken`/`sessionInitialization`: remove fragment parsing and cleanup; initialize restore only, route `AUTH_SESSION_REQUIRED`/`AUTH_SESSION_INVALID` to explicit login state, keep `400`/`403`/`503` distinct.
- Modify `apps/web/src/app/App.tsx` `AppProps`/`App`: add explicit restoring/login/authenticated/expired states; mount `useEventClient` only when authenticated. Login form must not write password to URL, storage, logs or diagnostic text and must submit the exact `{ password }` DTO.
- Create `apps/web/src/features/auth/LoginPage.tsx`; expose Russian labels, `autocomplete="current-password"`, focus/error semantics and a logout control. Logout must clear client CSRF and return to login only after the `204` response or the locked idempotent error path.
- Modify `apps/web/src/api/events.ts` `EventClient`, `createEventClient`, `scheduleReconnect`, `connect`, `disconnect`: distinguish HTTP 401 from network/5xx. On 401 abort current stream, clear retry timer, emit one session-expired event/callback and never reconnect until a fresh authenticated state. On valid reconnect refetch authoritative projections.
- Modify `apps/web/src/hooks/useEventClient.ts` `useEventClient`/`useOnSSEReconnect` to subscribe/unsubscribe to the auth/session-expired signal and preserve cleanup under StrictMode.

## Explicit Create/Modify task scope

- **Create:** `apps/web/src/features/auth/LoginPage.tsx` and `apps/web/test/sse-session-expiry.test.ts`. The SSE test path is fixed; it is not an alternative location.
- **Modify:** `packages/contracts/src/api.ts`, `apps/web/src/api/client.ts`, `apps/web/src/main.tsx`, `apps/web/src/app/App.tsx`, `apps/web/src/api/events.ts`, `apps/web/src/hooks/useEventClient.ts`, `apps/web/test/routing-bootstrap.test.ts`, `apps/web/test/api-client-foundation.test.ts` and `apps/web/test/app-shell.test.tsx`.

## RED → GREEN

1. Reframe `apps/web/test/routing-bootstrap.test.ts` as auth restore tests; add RED cases for no fragment/no cookie login screen, valid cookie restore, exact login body/200 DTO, wrong password vs missing user safe `401`, logout `204`, no `Authorization` header, no token in `localStorage/sessionStorage`, and no `/session/bootstrap` or `/session/new` call.
2. Extend `apps/web/test/api-client-foundation.test.ts` with exact login/logout request shape, exact Origin/CSRF behavior (login sends no CSRF; authenticated mutations do), cookie credentials, `expiresAt` parsing, safe 401 classification and no raw password/token in thrown error.
3. Add `apps/web/test/sse-session-expiry.test.ts`: a mocked `/events` response 401 stops `fetch` retries, clears timer and dispatches the single expiry signal; a 503 still follows bounded reconnect; `disconnect` cancels both.
4. Add `apps/web/test/app-shell.test.tsx` cases for focus on login, `role="alert"`/`aria-live`, authenticated-only SSE mount and logout transition. Run these before implementation and record RED.
5. Implement against the server contract from 15-04; expected GREEN with no bearer in browser code. Do not implement a one-shot refresh/retry unless the locked contract explicitly requires it.

## Browser acceptance

Real Playwright tests must prove: initial no-cookie navigation shows Russian login; correct login reaches shell; reload restores via cookie after a server restart and returns the locked `expiresAt`; expired/revoked session shows login and SSE makes no further reconnect; logout returns login and repeated logout remains `204`; network errors remain a retry state. Browser JS must never observe a privileged bearer.

## Commands / Expected

- `pnpm --filter @ebb-orchestrator/web test -- routing-bootstrap.test.ts api-client-foundation.test.ts sse-session-expiry.test.ts app-shell.test.tsx` — PASS, all auth state/SSE cases.
- `pnpm --filter @ebb-orchestrator/contracts typecheck && pnpm --filter @ebb-orchestrator/contracts test` — PASS.
- `pnpm --filter @ebb-orchestrator/web build` — PASS, TypeScript included.

**Depends on:** 15-04. **Unblocks:** 15-07 and final browser verification.
