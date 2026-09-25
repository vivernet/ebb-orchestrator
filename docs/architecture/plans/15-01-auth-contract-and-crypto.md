---
id: plan-15-01
kind: plan
roadmap: 01
stage: 13
status: planned
title: Контракт auth и bounded crypto feasibility
created: 2026-09-25
updated: 2026-09-25
depends_on: []
specs:
  - ../specs/01-system-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - apps/server/src/app/create-app.ts
  - apps/server/src/platform/security/local-session.ts
  - apps/server/package.json
  - packages/contracts/src/api.ts
  - pnpm-lock.yaml
---

# 15-01. Versioned auth/onboarding contract и crypto feasibility

**Результат:** первым deliverable добавляются и проверяются exact `argon2@0.45.1` dependency/lockfile entries на Node `>=24.15 <25`/Windows; затем до начала `15-02`–`15-08` в `packages/contracts/src/api.ts` зафиксированы versioned public DTO/status/error/cookie/CSRF contracts и в server security plan зафиксированы versioned TypeScript ports, error mapping, transaction ownership и raw-secret lifetime rules. После этого downstream tasks не выбирают поля, коды или security semantics самостоятельно.

## Deliverable 1 — pinned Argon2id dependency and feasibility gate

This deliverable is first. It is an implementation change, not a proposal: run the repository package-manager command exactly as written from the repository root:

```text
pnpm --filter @ebb-orchestrator/server add argon2@0.45.1 --save-exact --allow-build=argon2
```

The command must update only the implementation-owned dependency surfaces `apps/server/package.json` and `pnpm-lock.yaml` for this deliverable. The registry metadata inspected for this plan reports `argon2` latest `0.45.1`, Node engine `>=16.17.0`, tarball `https://registry.npmjs.org/argon2/-/argon2-0.45.1.tgz`, and integrity `sha512-skm+/WCjkGqCQxF7FG1LuZXM5yvbFjgbfiCGsud2oLgaDhh6b6dbH0b1EkghbM+xx4Bj8Ape+KKgixoIlWZicQ==`. The generated pnpm v9 lockfile must contain the exact package entry:

```yaml
argon2@0.45.1:
  resolution: {integrity: sha512-skm+/WCjkGqCQxF7FG1LuZXM5yvbFjgbfiCGsud2oLgaDhh6b6dbH0b1EkghbM+xx4Bj8Ape+KKgixoIlWZicQ==}
  engines: {node: '>=16.17.0'}
```

Its snapshot must resolve `@phc/format: 1.0.0`, `cross-env: 10.1.0`, `node-addon-api: 8.9.2` and `node-gyp-build: 4.8.4`; the command, not hand-edited YAML, is authoritative for those transitive entries. `--allow-build=argon2` is required by the repository's pnpm 12.4.2 build-script policy so the native addon install script is not silently skipped.

Create `apps/server/test/platform/security/password-hash-feasibility.test.ts` before implementing the adapter. The test must run on the supported repository matrix (`node >=24.15 <25`); on Windows x64 it must import the native `argon2` binding, hash and verify a known test password, reject a wrong password, create two different salts for two hashes, and report only non-secret measurements. The observed feasibility command on this Windows checkout is:

```text
pnpm --filter @ebb-orchestrator/server test -- password-hash-feasibility.test.ts
```

The adapter is locked to Argon2id version 19 with these explicit parameters: `memoryCost=65536` KiB (64 MiB), `timeCost=3`, `parallelism=4`, `hashLength=32` bytes, `saltLength=16` bytes, `type=argon2.argon2id`. The stored value is the complete PHC string with the `argon2id`/`v=19` marker and encoded salt/digest, not raw derived bytes; the expected parameter serialization is `$argon2id$v=19$m=65536,p=4,t=3$<salt>$<digest>`.

If the exact add command cannot produce the lockfile entry, native binding loading fails, or the Node 24/Windows feasibility test fails, stop `15-01` with `REQUIREMENTS_BLOCKED`, retain the failure as the blocker, and do not start `15-02`–`15-08`. There is no bcrypt, scrypt, PBKDF2, WebCrypto or homemade fallback and no silent crypto substitution. A successful feasibility run is required before the contract gate is GREEN.

Downstream usage is closed: `apps/server/src/platform/security/password-hasher.ts` creates the only `PasswordHasher` implementation via `createArgon2PasswordHasher()`, imports `argon2` there, and uses the exact options above for `hash`/`verify`; `apps/server/src/platform/security/auth-repository.ts` consumes only the `PasswordHasher` port and stores the PHC string plus `hash_algorithm='argon2id'` and the fixed parameter JSON; `apps/server/src/main.ts` composes the factory. No route, Web code, SecretStore or shared contract imports `argon2` directly.

## Реальные поверхности и порядок

- `apps/server/src/platform/security/local-session.ts`: legacy process tuple (`token`, raw CSRF, bootstrap token) больше не является authority; durable authority будет передана через auth service/repository.
- `apps/server/src/app/create-app.ts`: текущие `AppDeps`, `OrchestratorApp`, `LOCAL_SESSION_COOKIE`, `safeEquals`, `createSessionCookie`, `readCookie` — legacy boundaries для замены в `15-04`.
- `packages/contracts/src/api.ts`: add `AUTH_CONTRACT_VERSION = 1`, `ONBOARDING_CONTRACT_VERSION = 1`, `AUTH_COOKIE_CONTRACT = { name: "ebb_local_session", path: "/api/v1", httpOnly: true, sameSite: "strict", secure: false, maxAgeSeconds: 86400 } as const`, `AUTH_IDLE_TTL_SECONDS = 1800`, `AUTH_ABSOLUTE_TTL_SECONDS = 86400`, `AUTH_TOKEN_BYTES = 32`, exact DTO/types, error-code unions and path builders. The contract artifact also states `expiresAt` is RFC3339 UTC and the HTTP cookie `Expires` attribute is IMF-fixdate for that same instant. Remove `sessionBootstrap` from public consumers, without adding a new bootstrap path.
- `apps/web/src/api/client.ts`: consumer только locked DTO; privileged bearer/session token в JS/storage не разрешён.

## Explicit task scope

- **Create:** `apps/server/test/platform/security/password-hash-feasibility.test.ts` with the Node 24/Windows native-binding, Argon2id parameter, PHC-format, salt-uniqueness, wrong-password, malformed/unknown-version and no-secret-output assertions described above.
- **Create:** `apps/server/test/platform/security/auth-onboarding-contract.test.ts` as the sole auth/onboarding contract gate. This path is server-owned future task output and is intentionally not listed in frontmatter `evidence`.

### Allowed contract-test seam

`packages/contracts` remains a dependency-free shared-contract package: it may expose serializable DTOs, schemas, paths, status unions and error-code unions, but it must not import `apps/server` or publish `AuthRepository`, `AuthService`, `Database`, `RawSecretBytes` or other implementation ports. The only test that asserts the combined public DTO contract **and** the server-owned `AuthRepository`/`AuthService` signatures is `apps/server/test/platform/security/auth-onboarding-contract.test.ts`. That server-owned test may import shared serializable values from `@ebb-orchestrator/contracts` and implementation ports from `apps/server/src/platform/security/*`; no test under `packages/contracts/test/` may import server code or assert server-owned signatures. The contracts package gate is limited to its own typecheck/build/test surface, while the server contract gate owns the port-signature and transaction/raw-secret assertions described below.

`15-01` contract gate test is exactly `apps/server/test/platform/security/auth-onboarding-contract.test.ts`. RED asserts that `AUTH_CONTRACT_VERSION`, `ONBOARDING_CONTRACT_VERSION`, `AUTH_COOKIE_CONTRACT`, `AUTH_IDLE_TTL_SECONDS`, `AUTH_ABSOLUTE_TTL_SECONDS`, `AUTH_TOKEN_BYTES`, `apiPaths.sessionLogin`, `apiPaths.session`, `apiPaths.sessionLogout`, all onboarding builders, Zod schemas/types and the two error-code unions are absent or incompatible before the contract edit; GREEN asserts exact key sets, literal versions, allowed statuses/codes, exact cookie directives/TTL constants, no `sessionBootstrap`, path-segment encoding, and the route/status table above. It also asserts `LogoutResult` is exactly `REVOKED | INVALID_SESSION | CSRF_INVALID`, that the server-owned repository/service method signatures carry both nullable raw session/CSRF inputs plus the injected timestamp, and that no `packages/contracts` test imports server implementation. This test is the first downstream dependency gate and must pass before any server/Web/E2E contract consumer is changed.


## Auth contract v1 — exact public HTTP surface

### Paths and request/response DTOs

| Method/path | Request | `2xx` response | Exact non-success behavior |
|---|---|---|---|
| `POST /api/v1/session/login` | JSON with exact keys `{ password: string }` | `200` `LoginResponseDto` | `400 AUTH_INVALID_REQUEST`; `401 AUTH_INVALID_CREDENTIALS` for wrong password **and** missing singleton user with identical body; `403 AUTH_ORIGIN_INVALID`; `503 AUTH_UNAVAILABLE` |
| `GET /api/v1/session` | no body; HttpOnly cookie required | `200` `SessionResponseDto` | `401 AUTH_SESSION_REQUIRED` without cookie; `401 AUTH_SESSION_INVALID` for malformed, unknown, revoked, idle-expired or absolute-expired cookie; `503 AUTH_UNAVAILABLE` |
| `POST /api/v1/session/logout` | no body | `204` empty body; every `204` emits the clearing cookie | exact Origin is always required (`403 AUTH_ORIGIN_INVALID`); a valid session also requires current `X-CSRF-Token` (`403 AUTH_CSRF_INVALID`); absent/unknown/expired/revoked cookie is an idempotent `204`, not an error; rejected `403` requests do not revoke, rotate or clear the cookie |

`AuthErrorCode` is exactly `AUTH_INVALID_REQUEST | AUTH_INVALID_CREDENTIALS | AUTH_ORIGIN_INVALID | AUTH_UNAVAILABLE | AUTH_SESSION_REQUIRED | AUTH_SESSION_INVALID | AUTH_CSRF_INVALID`. The JSON error body is versioned and exact: `{ "contractVersion": 1, "error": { "code": AuthErrorCode, "message": string } }`. User-facing messages are safe Russian text; `AUTH_INVALID_CREDENTIALS` never reveals whether the user exists. No success or error DTO contains a password, raw session token, raw CSRF token except the dedicated `csrfToken` response field, password hash, digest or SecretStore value.

`LoginResponseDto` is exactly `{ contractVersion: 1, csrfToken: string, expiresAt: string }`. `SessionResponseDto` is exactly `{ contractVersion: 1, authenticated: true, csrfToken: string, expiresAt: string }`. `expiresAt` is the immutable RFC3339 UTC `absolute_expires_at`; idle expiry is enforced server-side and is not presented as a renewable client promise. There is no username or user id in v1 because the product has one singleton local user without username.

## Versioned TypeScript ports — contract gate for 15-02 and 15-04

Before any downstream implementation, `15-01` locks `AUTH_PORT_CONTRACT_VERSION = 1` and the following TypeScript signatures. The symbols may be implemented in their owning files (`password-hasher.ts`, `auth-repository.ts`, `auth-service.ts`); consumers must not narrow, widen or rename them without a new contract version.

```ts
export const AUTH_PORT_CONTRACT_VERSION = 1 as const;
export type UtcTimestamp = string; // RFC3339 UTC, ...Z
export type RawSecretBytes = Uint8Array; // mutable caller-owned bytes

export interface AuthClock {
  now(): UtcTimestamp;
}
export interface RandomTokenPort {
  randomBytes(length: typeof AUTH_TOKEN_BYTES): RawSecretBytes;
}
export interface DigestPort {
  sha256Hex(raw: Readonly<RawSecretBytes>): string; // lowercase 64-char hex
}
export interface PasswordHasher {
  hash(password: Readonly<RawSecretBytes>): Promise<string>; // complete PHC only
  verify(encoded: string, password: Readonly<RawSecretBytes>): Promise<boolean>;
}
export function createArgon2PasswordHasher(): PasswordHasher;

export type AuthPortErrorCode =
  | "INVALID_CREDENTIALS"
  | "SESSION_INVALID"
  | "CSRF_INVALID"
  | "UNAVAILABLE";
export type RevokeResult = "REVOKED" | "ALREADY_REVOKED";
export type LogoutResult = "REVOKED" | "INVALID_SESSION" | "CSRF_INVALID";
export interface LocalUserRecord {
  id: 1;
  passwordHash: string;
  hashAlgorithm: "argon2id";
  hashParametersJson: string;
}
export interface AuthSessionRecord {
  id: string;
  absoluteExpiresAt: UtcTimestamp;
  idleExpiresAt: UtcTimestamp;
}
export interface IssuedSession {
  session: AuthSessionRecord;
  rawSessionToken: RawSecretBytes;
  rawCsrfToken: RawSecretBytes;
}
export interface RotatedCsrf {
  session: AuthSessionRecord;
  rawCsrfToken: RawSecretBytes;
}

export interface AuthRepository {
  hasLocalUser(): Promise<boolean>;
  createLocalUser(password: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<void>;
  findLocalUser(): Promise<LocalUserRecord | null>;
  issueSession(now: UtcTimestamp): Promise<IssuedSession>;
  authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<AuthSessionRecord | null>;
  authenticateAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RotatedCsrf | null>;
  revokeByToken(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RevokeResult>;
  logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null, now: UtcTimestamp): Promise<LogoutResult>;
  revokeExpired(now: UtcTimestamp): Promise<number>;
}

export interface AuthService {
  login(password: Readonly<RawSecretBytes>): Promise<
    { ok: true; value: IssuedSession & { response: LoginResponseDto } } |
    { ok: false; code: AuthPortErrorCode }
  >;
  restoreAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>): Promise<
    { ok: true; value: RotatedCsrf & { response: SessionResponseDto } } |
    { ok: false; code: AuthPortErrorCode }
  >;
  authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>): Promise<
    { ok: true; value: AuthSessionRecord } |
    { ok: false; code: AuthPortErrorCode }
  >;
  logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null): Promise<
    { ok: true; value: "REVOKED" | "IDEMPOTENT_INVALID_SESSION" } |
    { ok: false; code: "CSRF_INVALID" | "UNAVAILABLE" }
  >;
  hasLocalUser(): Promise<boolean>;
}
```

The composition signatures are fixed. `SqliteAuthRepository` is constructed as `new SqliteAuthRepository(database: Database, passwordHasher: PasswordHasher, randomTokenPort: RandomTokenPort, digestPort: DigestPort)` and `createAuthRepository(database: Database, passwordHasher: PasswordHasher, randomTokenPort: RandomTokenPort, digestPort: DigestPort): AuthRepository` returns that implementation. The only production implementations are `createNodeRandomTokenPort(): RandomTokenPort` and `createNodeDigestPort(): DigestPort` from `apps/server/src/platform/security/auth-ports.ts`; they are composed in `main.ts` and passed to the repository, while tests inject deterministic fakes. `RandomTokenPort` and `DigestPort` belong to this repository boundary because `issueSession`, CSRF rotation and token-hash persistence are repository operations; they are not fields or constructor arguments of `AuthService`. `LocalAuthService` is constructed as `new LocalAuthService(repository: AuthRepository, passwordHasher: PasswordHasher, clock: AuthClock)` and `createAuthService(repository: AuthRepository, passwordHasher: PasswordHasher, clock: AuthClock): AuthService` returns it. No service or route may instantiate crypto ports or contain fallback randomness/digest logic.

`AuthRepository.logout(rawSessionToken, rawCsrfToken, now)` has exactly three classifications: `REVOKED` means an active row matched the current CSRF and was revoked; `INVALID_SESSION` means null or a raw session buffer whose length is not `AUTH_TOKEN_BYTES`, unknown, revoked, idle-expired or absolute-expired session and ignores CSRF; `CSRF_INVALID` means an active row with null or a raw CSRF buffer whose length is not `AUTH_TOKEN_BYTES`, stale or wrong CSRF. Cookie/header decoding and base64url-without-padding validation happen at the HTTP boundary; the repository receives decoded raw bytes and treats any non-32-byte buffer as malformed. Origin is not a repository concern and is checked before this call by the route. Repository failures reject and map to `UNAVAILABLE`; they are not classifications.

Port error mapping is fixed: wrong password and missing singleton user map to `AUTH_INVALID_CREDENTIALS`; malformed/unknown/revoked/idle-expired/absolute-expired session maps to `AUTH_SESSION_INVALID`; a missing or stale CSRF for an active session maps to `AUTH_CSRF_INVALID`; malformed JSON maps to `AUTH_INVALID_REQUEST`; missing or non-exact Origin maps to `AUTH_ORIGIN_INVALID`; database, migration, hasher or random/digest failure maps to `AUTH_UNAVAILABLE`. HTTP route checks own `Origin`/body precedence, maps only these codes, and never exposes `AuthPortErrorCode` or storage details.

Raw-secret and transaction rules are part of version 1. The HTTP/TTY/E2E boundary creates one mutable `RawSecretBytes`, passes it by `Readonly` view, and zeroes the owning buffer in `finally` after the port call and cookie/response serialization; no port retains a reference or returns a raw password. `issueSession`/`login` raw session bytes are used only to set the HttpOnly cookie and are then zeroed; raw CSRF bytes may cross only the dedicated `csrfToken` response field and are zeroed after serialization. Passwords, raw session/CSRF values and derived bytes never enter logs, errors, DTOs, argv, env, files, SQLite or `SecretStore`; only PHC and lowercase SHA-256 digests persist. `AuthRepository` owns the `Database.transaction` for `createLocalUser`, `issueSession`, `authenticateAndTouch`, `authenticateAndRotateCsrf`, `revokeByToken`, `logout` and `revokeExpired`; the validity predicate and its write are one transaction, while `AuthService`, routes and fixtures must not open nested transactions or authorize from a read performed outside that transaction. `findLocalUser`/`hasLocalUser` are read-only and never authorize a request. A failed transaction changes neither auth row nor timestamp/digest. For `logout`, the repository begins one `BEGIN IMMEDIATE`, selects the row by session digest, evaluates the active predicate `revoked_at IS NULL AND $now < idle_expires_at AND $now < absolute_expires_at`, compares the CSRF digest only for an active row, and conditionally updates `revoked_at` only when both predicates match. Null/malformed/unknown/expired/revoked session and wrong CSRF return without any write or timestamp change.

## Auth contract v1 — exact public HTTP surface

### Origin, CSRF and cookie rules

- All API routes except `GET /api/v1/health` and the three session paths above remain authenticated. `GET /api/v1/events`/SSE authenticates with the cookie; as a safe GET it does not require CSRF, but it never creates a session.
- `POST /api/v1/session/login` is the **only login CSRF exception**: it requires one exact configured loopback Origin string (`http` scheme, configured loopback host and port; no missing-Origin, prefix or alternate-port match), but no CSRF header because no session exists yet. Missing or different Origin is `403`.
- Every authenticated `POST`, `PUT`, `PATCH` and `DELETE` other than the explicitly idempotent invalid-session logout case requires exact Origin and the current synchronizer `X-CSRF-Token`. `GET`/`HEAD` do not require CSRF. Logout with a valid session is never exempt from CSRF.
- Cookie name is `ebb_local_session`; value is an opaque 32-byte random token encoded base64url without padding. Directives are exactly `HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=86400; Expires=<absolute_expires_at as IMF-fixdate>`. `Secure` is intentionally omitted for the supported loopback HTTP origin; no `Domain` directive is emitted. Clearing uses the same name/path/flags with `Max-Age=0` and an Expires date in the past. JSON `expiresAt` remains the immutable RFC3339 UTC representation of the same instant.
- CSRF is also a 32-byte base64url token without padding. The server stores only `SHA-256(rawToken UTF-8).digest('hex')` as lowercase 64-character `token_hash`; CSRF uses the identical digest representation in `csrf_token_hash`. Raw values exist only at the response/request boundary and are never logged or persisted.
- Login issues a new session and raw CSRF token. `GET /api/v1/session` validates and touches the session, then transactionally replaces `csrf_token_hash` and returns the newly issued raw token; the previous raw CSRF token is immediately invalid. Ordinary authenticated requests touch idle time but do not rotate CSRF. A failed validation never touches or rotates anything.
- Time is an injected UTC clock represented as RFC3339 `...Z` TEXT. A session is valid only while `now < idle_expires_at`, `now < absolute_expires_at`, and `revoked_at IS NULL`; a successful touch atomically sets `last_seen_at=$now` and `idle_expires_at=$now+30m`, while `absolute_expires_at` never moves. This is a sliding idle TTL with a fixed absolute deadline.
- Logout evaluates **Origin → session classification → CSRF for active session → revoke/clear**. Missing/malformed/non-exact Origin is always `403 AUTH_ORIGIN_INVALID` with no cookie mutation, even for absent or invalid sessions. With exact Origin, absent/malformed/unknown/idle-expired/absolute-expired/revoked session is idempotent `204` with the clearing cookie and CSRF is ignored; exact Origin + active session requires current CSRF or returns `403 AUTH_CSRF_INVALID` without revoke/clear; exact Origin + active session + current CSRF sets `revoked_at` atomically and returns `204` with the clearing cookie. Repeating logout after expiry or revocation is the same `204`; it never revives or creates a session.

### Onboarding contract v1 locked for dependent task 15-06

`OnboardingProjection` has exact fields `{ contractVersion: 1, projectId: string, status: "DRAFT" | "APPROVAL_PENDING" | "APPROVED" | "ACTIVE", repository: { path: string, remotes: Array<{ name: string, url: string }> }, detected: { root: string, defaultBranch: string, remotes: Array<{ name: string, url: string }>, packageManager: string, languageHints: string[], testCommands: string[], untrustedExistingConfig: boolean }, proposed: OnboardingProposal | null, approval: { id: string, status: "PENDING" | "APPROVED" } | null }`. `OnboardingProposal` is `{ defaultBranch: string, workflow: string, roles: string[], guidelines: string[] }` with no client-supplied repository path. `OnboardingErrorCode` is exactly `ONBOARDING_INVALID_REPOSITORY | ONBOARDING_DISCOVERY_FAILED | ONBOARDING_NOT_FOUND | ONBOARDING_INVALID_PROPOSAL | ONBOARDING_APPROVAL_PENDING | ONBOARDING_NOT_PENDING | ONBOARDING_NOT_APPROVED | ONBOARDING_UNAVAILABLE`.

- `POST /api/v1/onboarding/discover`, body exactly `{ repositoryPath: string }`, returns `201 OnboardingProjection` with `status: "DRAFT"`, a backend-generated `projectId`, persisted detected facts, `proposed: null` and `approval: null`. Invalid/missing path is `400 ONBOARDING_INVALID_REPOSITORY`; discovery failure is `400 ONBOARDING_DISCOVERY_FAILED`.
- `GET /api/v1/onboarding/:projectId` returns `200 OnboardingProjection` from durable rows; unknown id is `404 ONBOARDING_NOT_FOUND`. Reload never re-runs discovery and never needs the client to resend a path.
- `POST /api/v1/onboarding/:projectId/approval`, body exactly `{ proposed: OnboardingProposal }`, returns `201` with the updated projection in `APPROVAL_PENDING`; malformed proposal is `400 ONBOARDING_INVALID_PROPOSAL`, missing project is `404`, and an existing pending approval is `409 ONBOARDING_APPROVAL_PENDING`. The repository path is read from the persisted draft.
- `POST /api/v1/onboarding/:projectId/approve`, optional body exactly `{ note?: string }`, returns `200` with `APPROVED`; no pending approval is `409 ONBOARDING_NOT_PENDING`.
- `POST /api/v1/onboarding/:projectId/activate`, empty body, returns `200` with `ACTIVE`; missing/mismatched approved approval or non-PROPOSED config is `409 ONBOARDING_NOT_APPROVED`. Activation is one transaction that requires the exact approval and changes the config to `ACTIVE`.
- Each successful discover creates a new draft for that request; there is no implicit merge/reuse by path and no v1 garbage collector. Repeating the same request returns a different `projectId`. This policy is deterministic and avoids treating an abandoned draft as approved authority.

## Bounded crypto feasibility (RED → GREEN gate)

1. **RED:** create `apps/server/test/platform/security/password-hash-feasibility.test.ts` and run it only after the exact add command in Deliverable 1. Before the adapter exists it must fail; the test covers async hash/verify, wrong-password rejection, fresh salts, PHC parsing, malformed/unknown version rejection, bounded wall time/memory/parallelism and no password/derived-byte output.
2. Verify the checked-in Node `>=24.15 <25` runtime on Windows x64 by importing the installed `argon2@0.45.1` native binding. The exact options are Argon2id v=19, `memoryCost=65536`, `timeCost=3`, `parallelism=4`, `hashLength=32`, `saltLength=16`; the PHC value must carry algorithm/version/parameters/salt and never be replaced by raw derived bytes.
3. **GREEN:** the Node 24/Windows feasibility test, correct/wrong password checks, fresh-salt check, malformed/unknown-version rejection, bounded measurement and restart verification all pass. If dependency installation, native binding load or feasibility fails, stop with `REQUIREMENTS_BLOCKED` and do not start downstream plans; never silently substitute another algorithm.
4. Add a test that local password setup never constructs or calls `SecretStore`; `apps/server/src/platform/security/secret-store.ts` and `keyring-secret-store.ts` remain outside this boundary.

## Acceptance and commands

- `pnpm --filter @ebb-orchestrator/server test -- auth-onboarding-contract.test.ts password-hash-feasibility.test.ts` — GREEN only after the algorithm/format/parameters decision is recorded; the server-owned DTO/port contract and native feasibility assertions pass with no secret material in output.
- `pnpm --filter @ebb-orchestrator/contracts typecheck && pnpm --filter @ebb-orchestrator/contracts test` — PASS for the shared serializable contract package only; no server-owned signature test is placed in this package.
- `pnpm --filter @ebb-orchestrator/server typecheck` — PASS; the server-owned contract test compiles against the exact local repository/service ports.
- `pnpm lint` — GREEN; existing `create-app.ts` errors are fixed by downstream implementation, not waived.

**Depends on:** none. **Unblocks:** 15-02, 15-03, 15-04, 15-05, 15-06 and the test-only onboarding/auth fixture.