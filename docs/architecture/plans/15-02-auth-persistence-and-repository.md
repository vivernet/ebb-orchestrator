---
id: plan-15-02
kind: plan
roadmap: 01
stage: 13
status: completed
title: SQLite auth persistence и session repository
created: 2026-09-25
updated: 2026-09-25
depends_on:
  - plan-15-01
specs:
  - ../specs/01-system-design.md
  - ../specs/03-production-readiness-design.md
evidence:
  - apps/server/src/platform/database/database.ts
  - apps/server/src/platform/database/sqlite-database.ts
  - apps/server/src/platform/database/migrator.ts
  - apps/server/src/platform/database/migrations/025_audit_log.sql
  - apps/server/src/platform/database/migrations/026_local_auth.sql
  - apps/server/src/platform/security/auth-ports.ts
  - apps/server/src/platform/security/auth-repository.ts
  - apps/server/src/platform/security/password-hasher.ts
  - apps/server/test/helpers/migrations.ts
  - apps/server/test/platform/database/backup-restore.test.ts
  - apps/server/test/platform/database/migrator.test.ts
  - apps/server/test/platform/database/scheduler-migration.test.ts
  - apps/server/test/platform/security/auth-repository.test.ts
  - apps/server/test/platform/security/auth-repository.concurrency.test.ts
---

# 15-02. SQLite auth persistence и session repository

**Результат:** append-only schema и `AuthRepository`/hash adapter, являющиеся единственной durable authority для local user и sessions.

## Files and interfaces

- Create `apps/server/src/platform/database/migrations/026_local_auth.sql` with this exact append-only schema: `local_users(id INTEGER PRIMARY KEY CHECK (id=1), password_hash TEXT NOT NULL, hash_algorithm TEXT NOT NULL, hash_parameters_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)` and `auth_sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, revoked_at TEXT NULL)`, plus indexes on `token_hash`, `revoked_at`, `absolute_expires_at`. All timestamps are RFC3339 UTC TEXT. No username, raw token, plaintext password or SecretStore reference.
- Create `apps/server/src/platform/security/password-hasher.ts`: export the `PasswordHasher` port and `createArgon2PasswordHasher()` factory. The factory is the only `argon2` import and must use the exact 15-01 Argon2id v=19 options (`memoryCost=65536`, `timeCost=3`, `parallelism=4`, `hashLength=32`, `saltLength=16`); `hash(password)` returns the complete PHC string and `verify(encoded,password)` accepts only that Argon2id format/parameter set and fails closed for malformed or unknown versions. Russian JSDoc must state trust boundary, memory/CPU side effect and secret lifetime. No alternate password-hash implementation is permitted.
`apps/server/src/platform/security/auth-repository.ts`: depend on `Database`/`DatabaseTx`, not `DatabaseSync`, and consume only the `PasswordHasher`, `RandomTokenPort` and `DigestPort` ports. Expose the exact `AUTH_PORT_CONTRACT_VERSION=2` operations and signatures from 15-01: `hasLocalUser(): Promise<boolean>`, `createLocalUser(password: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<void>`, `findLocalUser(): Promise<LocalUserRecord | null>`, `issueSession(now: UtcTimestamp): Promise<IssuedSession>`, `authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<AuthSessionRecord | null>`, `authenticateCsrfAndTouch(rawSessionToken: Readonly<RawSecretBytes>, rawCsrfToken: Readonly<RawSecretBytes> | null, now: UtcTimestamp): Promise<AuthenticatedMutationResult>`, `authenticateAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RotatedCsrf | null>`, `revokeByToken(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RevokeResult>`, `logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null, now: UtcTimestamp): Promise<LogoutResult>`, and `revokeExpired(now: UtcTimestamp): Promise<number>`. `validateCsrf` is not an allowed repository API. Construct it only as `new SqliteAuthRepository(database, passwordHasher, randomTokenPort, digestPort)` or `createAuthRepository(database, passwordHasher, randomTokenPort, digestPort)`. `RandomTokenPort` is called only by `issueSession`/CSRF rotation for exactly `AUTH_TOKEN_BYTES`; `DigestPort` is called only by the repository for session/CSRF digests. `createLocalUser` stores the PHC string in `password_hash`, the literal `argon2id` in `hash_algorithm` and the fixed 15-01 parameter JSON in `hash_parameters_json`; it never imports `argon2` or calls `SecretStore`. `authenticateAndTouch` must hash the supplied raw token and perform one `Database.transaction` (`BEGIN IMMEDIATE` in the existing SQLite adapter) with conditional SQL: `UPDATE auth_sessions SET last_seen_at=$now,idle_expires_at=$idleExpiresAt WHERE token_hash=$tokenHash AND revoked_at IS NULL AND $now < idle_expires_at AND $now < absolute_expires_at`; it returns a session only when `SELECT changes()` is `1`. `authenticateAndRotateCsrf` performs that validity/touch check and the conditional `csrf_token_hash` replacement in the same transaction, returning the new raw CSRF only after commit. `revokeByToken` uses `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$now) WHERE token_hash=$tokenHash AND revoked_at IS NULL` and returns `REVOKED` or `ALREADY_REVOKED`; it cannot revive a row. `logout` owns one `BEGIN IMMEDIATE` transaction: it first treats a null or non-`AUTH_TOKEN_BYTES` raw session buffer as `INVALID_SESSION`, otherwise selects by session digest, classifies unknown/revoked/idle-expired/absolute-expired as `INVALID_SESSION` without reading or requiring CSRF, classifies an active row with null or non-`AUTH_TOKEN_BYTES`/stale/wrong CSRF as `CSRF_INVALID` without changing any column, and conditionally sets `revoked_at=$now` only for an active row whose CSRF digest matches, returning `REVOKED` only when `changes()=1`. Every method accepts the injected UTC clock; no read-then-write sequence outside the transaction may authorize a request, and a failed classification or transaction leaves `revoked_at`, timestamps and CSRF digest unchanged.
- `apps/server/src/platform/database/database.ts`/`sqlite-database.ts`: reuse existing transaction boundary; do not add a second adapter or runtime DDL.
- `authenticateCsrfAndTouch` begins one `BEGIN IMMEDIATE`, hashes the supplied session/CSRF bytes inside the repository boundary, classifies session before CSRF, and performs the active-session predicate (`revoked_at IS NULL AND $now < idle_expires_at AND $now < absolute_expires_at`), current `csrf_token_hash` comparison and conditional touch in that same transaction. It returns `INVALID_SESSION` without inspecting CSRF for null/malformed/unknown/revoked/expired session, `CSRF_INVALID` without writing for a missing/malformed/stale/wrong CSRF on an active row, and a touched record only when the conditional update changes exactly one row. A separate CSRF-validation API, pre-read or follow-up touch is forbidden.
- `apps/server/src/platform/database/migrator.ts`: keep its current forward-only integrity semantics unchanged; the migration tests cover the existing validation without editing applied migration files.
- Create `apps/server/test/platform/database/backup-restore.test.ts` with `backupSqliteDatabase(sourcePath, backupPath)` and `restoreSqliteDatabase(backupPath, sourcePath)` test helpers. The test closes the database, copies the SQLite file, opens the backup, proves the singleton user and onboarding rows are present, corrupts the working copy with an injected migration failure, restores the backup only after closing the failed process/database, and proves the restored file opens and reruns forward migrations. No down migration or automatic destructive restore is added to production.

## RED → GREEN

1. Add migration tests to `apps/server/test/platform/database/migrator.test.ts` and focused tests to `apps/server/test/platform/security/auth-repository.test.ts` before implementation:
   - fresh DB applies exactly 026 after 025 and exposes the exact columns/check/unique indexes;
   - upgrade from 025 applies 026 exactly once; repeated run is idempotent; no 027 is expected because onboarding reuses 021;
   - failed migration transaction leaves no partial auth tables/rows;
   - singleton user rejects a second user and rejects an empty/malformed hash;
   - raw session token is returned only from issuance, DB contains only lowercase SHA-256 `token_hash`; same for CSRF;
   - valid session survives closing/reopening the same SQLite file;
   - missing, revoked, idle-expired (`30m`) and absolute-expired (`24h`) rows reject; valid request touches `last_seen_at` and recomputes `idle_expires_at=last_seen_at+30m` but never moves `absolute_expires_at`;
   - `authenticateAndTouch`, `authenticateCsrfAndTouch` and `authenticateAndRotateCsrf` execute their validity decision and update atomically; `authenticateCsrfAndTouch` rejects a stale CSRF without touching, and previous CSRF digest fails after rotation;
   - `revokeByToken` is idempotent and conditional SQL makes logout win over a later touch; no operation after revoke changes `last_seen_at`, `idle_expires_at` or `csrf_token_hash`;
   - `logout` returns exactly `REVOKED`, `INVALID_SESSION` or `CSRF_INVALID`; test null/malformed/unknown/idle-expired/absolute-expired/revoked session, missing/malformed/wrong/stale/current CSRF, and assert every `INVALID_SESSION`/`CSRF_INVALID` case leaves `revoked_at`, `last_seen_at`, `idle_expires_at` and `csrf_token_hash` byte-for-byte unchanged;
   - logout-vs-touch uses two file-backed database handles and both start orders; the winning logout leaves the row revoked and no later touch/rotation changes any timestamp or digest; repeat logout returns `INVALID_SESSION` without mutation;
   - deterministic fake `RandomTokenPort` and `DigestPort` tests prove `SqliteAuthRepository` receives both through its constructor/factory, requests exactly 32 bytes for issuance/rotation, persists only their lowercase digests, and has no hidden `node:crypto` randomness/digest implementation;
   - `revokeExpired` cleanup is idempotent and never deletes or revokes a currently valid row.
2. Preserve the RED evidence for the migration-integrity regression with the direct focused command `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/scheduler-migration.test.ts`; it exits 1 before the cumulative catalog fix and reports `Applied migration 1 is missing from the supplied catalog`. Do not use the package test wrapper for RED evidence or focused reporting.
3. Implement minimal repository/hash code and update the scheduler migration fixture with a cumulative catalog helper that includes base migrations 1, 2, 3 and 5 plus every previously applied legacy/forward migration. Rerun. Expected GREEN: all matrix cases pass with deterministic fake clock; no SecretStore calls; all scheduler data-preservation, collision, orphan and rollback assertions remain active.
4. Add restart fixture using `createSqliteDatabase` and `loadTestMigrations` from `apps/server/test/helpers/migrations.ts`; never use `:memory:` for the restart assertion.
5. Add `apps/server/test/platform/security/auth-repository.concurrency.test.ts`: use `node:worker_threads` workers (symbol `runAuthRaceWorker`) so two independent `createSqliteDatabase` handles operate on the same temporary file; the existing SQLite `busy_timeout` may serialize `BEGIN IMMEDIATE`, but the test must not mock or assume call order. Issue one session, race `authenticateAndTouch` against `logout(rawSessionToken, currentCsrfToken, now)`, repeat with the worker start order reversed, and assert the durable final row is revoked, every touch attempted after the winning logout returns no session, exactly one logout result is `REVOKED` and repeats are `INVALID_SESSION`, and revoked rows never change `last_seen_at`, `idle_expires_at` or `csrf_token_hash`. Add a wrong-CSRF worker case and assert `CSRF_INVALID` leaves the complete row unchanged. Run a CSRF-rotation-vs-`authenticateCsrfAndTouch` race in both start orders: an authorization using the old token either commits entirely before rotation or returns `CSRF_INVALID` without touch; it must never touch after a successful rotation. Inspect durable rows after both workers complete. `validateCsrf` must not occur in the fixture, worker protocol or source/import scan.

## Explicit Create/Modify task scope

- **Create:** `apps/server/src/platform/security/password-hasher.ts` with `PasswordHasher` and `createArgon2PasswordHasher()`; `apps/server/src/platform/security/auth-ports.ts` with `createNodeRandomTokenPort(): RandomTokenPort` and `createNodeDigestPort(): DigestPort`; `apps/server/src/platform/security/auth-repository.ts`; `apps/server/src/platform/database/migrations/026_local_auth.sql`; `apps/server/test/platform/database/backup-restore.test.ts`; `apps/server/test/platform/security/auth-repository.test.ts`; and `apps/server/test/platform/security/auth-repository.concurrency.test.ts` with `runAuthRaceWorker`.
- **Modify:** `apps/server/test/platform/database/migrator.test.ts`, `apps/server/test/helpers/migrations.ts`, and `apps/server/test/platform/database/scheduler-migration.test.ts` for the exact 026/021 chain, rollback/restart assertions, and cumulative migration catalogs required by fail-closed migrator validation. The concurrency test path is future output and is not frontmatter evidence in this plan or in 15-08.

## Migration and recovery semantics

Migration 026 has no down migration and does not import old bootstrap state—there are no durable old sessions. Migration 021 remains the authoritative onboarding schema and is not edited. A pre-rollout SQLite backup is the recovery point. A migration error rolls back and prevents listener/worker startup. Restore is manual after process stop; re-run the forward migrations. The repository must tolerate a valid schema with no user, while `main.ts` must not reach READY until the wizard creates one.

## Commands / Expected

- `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/scheduler-migration.test.ts` — PASS; 1 file, 10 tests, exit 0. Every migration run supplies the cumulative catalog, and the data-preservation, collision, orphan and rollback assertions remain green.
- `pnpm --filter @ebb-orchestrator/server exec vitest run test/platform/database/migrator.test.ts test/platform/security/auth-repository.test.ts test/platform/security/auth-repository.concurrency.test.ts test/platform/database/backup-restore.test.ts test/platform/security/auth-onboarding-contract.test.ts test/platform/security/password-hash-feasibility.test.ts` — PASS; 6 files, 34 tests, exit 0.
- **Concurrency Run:** included in the exact command above as `test/platform/security/auth-repository.concurrency.test.ts`, with the real repository migration chain and a fresh file-backed SQLite database. **Expected:** exit 0; both worker start orders pass for the touch-vs-logout race; exactly one `REVOKED`, all later logouts `INVALID_SESSION`, wrong-CSRF `CSRF_INVALID` with complete row immutability, every post-logout touch returns no session, and the final row is revoked with its `last_seen_at`, `idle_expires_at` and `csrf_token_hash` equal to the pre-race values; the CSRF-rotation race returns exactly two distinct raw tokens, the final digest equals exactly one returned token digest, and the prior digest is rejected. Output contains only worker/result counts and redacted status, never raw tokens/passwords/digests.
- `pnpm --filter @ebb-orchestrator/server typecheck` — PASS; exit 0.
- `pnpm --filter @ebb-orchestrator/server build` — PASS; exit 0.
- `pnpm lint` — KNOWN FAILURE outside this task scope; exit 1 with the pre-existing unused `request`/`reply` errors in `apps/server/src/app/create-app.ts:199`. No lint workaround is added here.
- `git diff --check` — PASS; exit 0 (with the existing CRLF normalization warning for `docs/architecture/plans/16-documentation-cleanup-and-refresh.md`).

**Depends on:** 15-01. **Unblocks:** 15-03 and 15-04.
