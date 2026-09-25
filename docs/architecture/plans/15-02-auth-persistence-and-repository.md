---
id: plan-15-02
kind: plan
roadmap: 01
stage: 13
status: planned
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
  - apps/server/test/helpers/migrations.ts
---

# 15-02. SQLite auth persistence и session repository

**Результат:** append-only schema и `AuthRepository`/hash adapter, являющиеся единственной durable authority для local user и sessions.

## Files and interfaces

- Create `apps/server/src/platform/database/migrations/026_local_auth.sql` with this exact append-only schema: `local_users(id INTEGER PRIMARY KEY CHECK (id=1), password_hash TEXT NOT NULL, hash_algorithm TEXT NOT NULL, hash_parameters_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)` and `auth_sessions(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, revoked_at TEXT NULL)`, plus indexes on `token_hash`, `revoked_at`, `absolute_expires_at`. All timestamps are RFC3339 UTC TEXT. No username, raw token, plaintext password or SecretStore reference.
- Create `apps/server/src/platform/security/password-hasher.ts`: export the `PasswordHasher` port and `createArgon2PasswordHasher()` factory. The factory is the only `argon2` import and must use the exact 15-01 Argon2id v=19 options (`memoryCost=65536`, `timeCost=3`, `parallelism=4`, `hashLength=32`, `saltLength=16`); `hash(password)` returns the complete PHC string and `verify(encoded,password)` accepts only that Argon2id format/parameter set and fails closed for malformed or unknown versions. Russian JSDoc must state trust boundary, memory/CPU side effect and secret lifetime. No alternate password-hash implementation is permitted.
`apps/server/src/platform/security/auth-repository.ts`: depend on `Database`/`DatabaseTx`, not `DatabaseSync`, and consume only the `PasswordHasher`, `RandomTokenPort` and `DigestPort` ports. Expose the exact `AUTH_PORT_CONTRACT_VERSION=1` operations and signatures from 15-01: `hasLocalUser(): Promise<boolean>`, `createLocalUser(password: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<void>`, `findLocalUser(): Promise<LocalUserRecord | null>`, `issueSession(now: UtcTimestamp): Promise<IssuedSession>`, `authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<AuthSessionRecord | null>`, `authenticateAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RotatedCsrf | null>`, `revokeByToken(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RevokeResult>`, `logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null, now: UtcTimestamp): Promise<LogoutResult>`, and `revokeExpired(now: UtcTimestamp): Promise<number>`. Construct it only as `new SqliteAuthRepository(database, passwordHasher, randomTokenPort, digestPort)` or `createAuthRepository(database, passwordHasher, randomTokenPort, digestPort)`. `RandomTokenPort` is called only by `issueSession`/CSRF rotation for exactly `AUTH_TOKEN_BYTES`; `DigestPort` is called only by the repository for session/CSRF digests. `createLocalUser` stores the PHC string in `password_hash`, the literal `argon2id` in `hash_algorithm` and the fixed 15-01 parameter JSON in `hash_parameters_json`; it never imports `argon2` or calls `SecretStore`. `authenticateAndTouch` must hash the supplied raw token and perform one `Database.transaction` (`BEGIN IMMEDIATE` in the existing SQLite adapter) with conditional SQL: `UPDATE auth_sessions SET last_seen_at=$now,idle_expires_at=$idleExpiresAt WHERE token_hash=$tokenHash AND revoked_at IS NULL AND $now < idle_expires_at AND $now < absolute_expires_at`; it returns a session only when `SELECT changes()` is `1`. `authenticateAndRotateCsrf` performs that validity/touch check and the conditional `csrf_token_hash` replacement in the same transaction, returning the new raw CSRF only after commit. `revokeByToken` uses `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$now) WHERE token_hash=$tokenHash AND revoked_at IS NULL` and returns `REVOKED` or `ALREADY_REVOKED`; it cannot revive a row. `logout` owns one `BEGIN IMMEDIATE` transaction: it first treats a null or non-`AUTH_TOKEN_BYTES` raw session buffer as `INVALID_SESSION`, otherwise selects by session digest, classifies unknown/revoked/idle-expired/absolute-expired as `INVALID_SESSION` without reading or requiring CSRF, classifies an active row with null or non-`AUTH_TOKEN_BYTES`/stale/wrong CSRF as `CSRF_INVALID` without changing any column, and conditionally sets `revoked_at=$now` only for an active row whose CSRF digest matches, returning `REVOKED` only when `changes()=1`. Every method accepts the injected UTC clock; no read-then-write sequence outside the transaction may authorize a request, and a failed classification or transaction leaves `revoked_at`, timestamps and CSRF digest unchanged.
- `apps/server/src/platform/database/database.ts`/`sqlite-database.ts`: reuse existing transaction boundary; do not add a second adapter or runtime DDL.
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
   - `authenticateAndTouch` and `authenticateAndRotateCsrf` execute their validity decision and update atomically; previous CSRF digest fails after rotation;
   - `revokeByToken` is idempotent and conditional SQL makes logout win over a later touch; no operation after revoke changes `last_seen_at`, `idle_expires_at` or `csrf_token_hash`;
   - `logout` returns exactly `REVOKED`, `INVALID_SESSION` or `CSRF_INVALID`; test null/malformed/unknown/idle-expired/absolute-expired/revoked session, missing/malformed/wrong/stale/current CSRF, and assert every `INVALID_SESSION`/`CSRF_INVALID` case leaves `revoked_at`, `last_seen_at`, `idle_expires_at` and `csrf_token_hash` byte-for-byte unchanged;
   - logout-vs-touch uses two file-backed database handles and both start orders; the winning logout leaves the row revoked and no later touch/rotation changes any timestamp or digest; repeat logout returns `INVALID_SESSION` without mutation;
   - deterministic fake `RandomTokenPort` and `DigestPort` tests prove `SqliteAuthRepository` receives both through its constructor/factory, requests exactly 32 bytes for issuance/rotation, persists only their lowercase digests, and has no hidden `node:crypto` randomness/digest implementation;
   - `revokeExpired` cleanup is idempotent and never deletes or revokes a currently valid row.
2. Run focused tests before implementation and preserve the expected RED signal: `pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts auth-repository.test.ts auth-repository.concurrency.test.ts backup-restore.test.ts`.
3. Implement minimal repository/hash code and rerun. Expected GREEN: all matrix cases pass with deterministic fake clock; no SecretStore calls.
4. Add restart fixture using `createSqliteDatabase` and `loadTestMigrations` from `apps/server/test/helpers/migrations.ts`; never use `:memory:` for the restart assertion.
5. Add `apps/server/test/platform/security/auth-repository.concurrency.test.ts`: use `node:worker_threads` workers (symbol `runAuthRaceWorker`) so two independent `createSqliteDatabase` handles operate on the same temporary file; the existing SQLite `busy_timeout` may serialize `BEGIN IMMEDIATE`, but the test must not mock or assume call order. Issue one session, race `authenticateAndTouch` against `logout(rawSessionToken, currentCsrfToken, now)`, repeat with the worker start order reversed, and assert the durable final row is revoked, every touch attempted after the winning logout returns no session, exactly one logout result is `REVOKED` and repeats are `INVALID_SESSION`, and revoked rows never change `last_seen_at`, `idle_expires_at` or `csrf_token_hash`. Add a wrong-CSRF worker case and assert `CSRF_INVALID` leaves the complete row unchanged. Run a second two-worker race for CSRF rotation and assert the durable final digest equals exactly one returned raw token digest, while the prior digest is rejected. Inspect durable rows after both workers complete.

## Explicit Create/Modify task scope

- **Create:** `apps/server/src/platform/security/password-hasher.ts` with `PasswordHasher` and `createArgon2PasswordHasher()`; `apps/server/src/platform/security/auth-ports.ts` with `createNodeRandomTokenPort(): RandomTokenPort` and `createNodeDigestPort(): DigestPort`; `apps/server/src/platform/security/auth-repository.ts`; `apps/server/src/platform/database/migrations/026_local_auth.sql`; `apps/server/test/platform/database/backup-restore.test.ts`; `apps/server/test/platform/security/auth-repository.test.ts`; and `apps/server/test/platform/security/auth-repository.concurrency.test.ts` with `runAuthRaceWorker`.
- **Modify:** `apps/server/test/platform/database/migrator.test.ts` and `apps/server/test/helpers/migrations.ts` for the exact 026/021 chain and rollback/restart assertions. The concurrency test path is future output and is not frontmatter evidence in this plan or in 15-08.

## Migration and recovery semantics

Migration 026 has no down migration and does not import old bootstrap state—there are no durable old sessions. Migration 021 remains the authoritative onboarding schema and is not edited. A pre-rollout SQLite backup is the recovery point. A migration error rolls back and prevents listener/worker startup. Restore is manual after process stop; re-run the forward migrations. The repository must tolerate a valid schema with no user, while `main.ts` must not reach READY until the wizard creates one.

## Commands / Expected

- `pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts auth-repository.test.ts` — PASS, including fresh/upgrade/idempotence/rollback/restart/TTL cases.
- `pnpm --filter @ebb-orchestrator/server test -- migrator.test.ts backup-restore.test.ts` — PASS; a failed 026 transaction leaves no partial schema, the pre-upgrade copy restores after the database is closed, and forward migration reruns without editing 001–025.
- **Concurrency Run:** `pnpm --filter @ebb-orchestrator/server test -- auth-repository.concurrency.test.ts` after implementation, with the real repository migration chain and a fresh file-backed SQLite database. **Expected:** exit 0; both worker start orders pass for the touch-vs-logout race; exactly one `REVOKED`, all later logouts `INVALID_SESSION`, wrong-CSRF `CSRF_INVALID` with complete row immutability, every post-logout touch returns no session, and the final row is revoked with its `last_seen_at`, `idle_expires_at` and `csrf_token_hash` equal to the pre-race values; the CSRF-rotation race returns exactly two distinct raw tokens, the final digest equals exactly one returned token digest, and the prior digest is rejected. Output contains only worker/result counts and redacted status, never raw tokens/passwords/digests.
- `pnpm --filter @ebb-orchestrator/server typecheck` — PASS.
- `pnpm lint` — PASS; no plaintext-secret logging or unsafe `any` workaround.

**Depends on:** 15-01. **Unblocks:** 15-03 and 15-04.
