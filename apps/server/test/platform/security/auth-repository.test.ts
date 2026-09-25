import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN_BYTES } from "@ebb-orchestrator/contracts";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import type { Database } from "../../../src/platform/database/database.js";
import {
  createAuthRepository,
  type AuthRepository,
} from "../../../src/platform/security/auth-repository.js";
import type {
  DigestPort,
  PasswordHasher,
  RandomTokenPort,
  RawSecretBytes,
} from "../../../src/platform/security/auth-ports.js";

const NOW = "2030-01-01T00:00:00.000Z";
const PHC = "$argon2id$v=19$m=65536,p=4,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PASSWORD = new TextEncoder().encode("correct horse battery staple");

function makeRandomPort(values: RawSecretBytes[]): RandomTokenPort & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    randomBytes(length) {
      calls.push(length);
      const value = values.shift();
      if (!value) throw new Error("test random sequence exhausted");
      return value;
    },
  };
}

const digestPort: DigestPort = {
  sha256Hex(raw) {
    return createHash("sha256").update(raw).digest("hex");
  },
};

function makeHasher(encoded = PHC): PasswordHasher {
  return {
    hash: async () => encoded,
    verify: async (stored, password) => stored === PHC && password.length > 0,
  };
}

let databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function openDatabase(): Promise<{ database: Database; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ebb-auth-repository-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "orchestrator.sqlite");
  const database = createSqliteDatabase(path);
  databases.push(database);
  runMigrations(database, loadTestMigrations());
  return { database, path };
}

function repository(database: Database, hasher = makeHasher(), values: RawSecretBytes[] = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)]): AuthRepository & { random: RandomTokenPort & { calls: number[] } } {
  const random = makeRandomPort(values);
  return Object.assign(createAuthRepository(database, hasher, random, digestPort), { random });
}

function raw(byte: number): RawSecretBytes {
  return new Uint8Array(AUTH_TOKEN_BYTES).fill(byte);
}

describe("SqliteAuthRepository", () => {
  it("stores one validated singleton local user and rejects a second or malformed hash", async () => {
    const { database } = await openDatabase();
    const auth = repository(database);

    await auth.createLocalUser(PASSWORD, NOW);
    await expect(auth.hasLocalUser()).resolves.toBe(true);
    await expect(auth.createLocalUser(PASSWORD, NOW)).rejects.toThrow();
    await expect(repository(database, makeHasher("")).createLocalUser(PASSWORD, NOW)).rejects.toThrow();

    expect(database.get("SELECT password_hash, hash_algorithm, hash_parameters_json FROM local_users")).toEqual({
      password_hash: PHC,
      hash_algorithm: "argon2id",
      hash_parameters_json: JSON.stringify({ memoryCost: 65536, timeCost: 3, parallelism: 4, hashLength: 32, saltLength: 16 }),
    });
  });

  it("issues opaque tokens through injected ports and survives a file-backed restart", async () => {
    const { database, path } = await openDatabase();
    const auth = repository(database, makeHasher(), [raw(7), raw(8)]);
    const issued = await auth.issueSession(NOW);

    expect(issued.rawSessionToken).toEqual(raw(7));
    expect(issued.rawCsrfToken).toEqual(raw(8));
    expect(auth.random.calls).toEqual([AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES]);
    const row = database.get<{ token_hash: string; csrf_token_hash: string }>("SELECT token_hash, csrf_token_hash FROM auth_sessions");
    expect(row).toEqual({ token_hash: digestPort.sha256Hex(raw(7)), csrf_token_hash: digestPort.sha256Hex(raw(8)) });
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    database.close();
    databases = databases.filter((candidate) => candidate !== database);
    const reopened = createSqliteDatabase(path);
    databases.push(reopened);
    expect(await createAuthRepository(reopened, makeHasher(), makeRandomPort([raw(9)]), digestPort).authenticateAndTouch(raw(7), "2030-01-01T00:01:00.000Z")).not.toBeNull();
  });

  it("touches idle expiry without moving the absolute expiry and rejects both expiry boundaries", async () => {
    const { database } = await openDatabase();
    const auth = repository(database, makeHasher(), [raw(10), raw(11)]);
    const issued = await auth.issueSession(NOW);

    const touched = await auth.authenticateAndTouch(raw(10), "2030-01-01T00:10:00.000Z");
    expect(touched).toEqual({ id: issued.session.id, idleExpiresAt: "2030-01-01T00:40:00.000Z", absoluteExpiresAt: issued.session.absoluteExpiresAt });
    expect(await auth.authenticateAndTouch(raw(10), "2030-01-01T00:40:00.000Z")).toBeNull();
    expect(await auth.authenticateAndTouch(raw(10), "2030-01-02T00:00:00.000Z")).toBeNull();
  });

  it("rotates CSRF atomically and logout wins over later touch or rotation", async () => {
    const { database } = await openDatabase();
    const auth = repository(database, makeHasher(), [raw(12), raw(13), raw(14)]);
    await auth.issueSession(NOW);
    const rotated = await auth.authenticateAndRotateCsrf(raw(12), "2030-01-01T00:02:00.000Z");
    expect(rotated?.rawCsrfToken).toEqual(raw(14));
    expect(await auth.logout(raw(12), raw(13), "2030-01-01T00:03:00.000Z")).toBe("CSRF_INVALID");
    expect(await auth.logout(raw(12), raw(14), "2030-01-01T00:04:00.000Z")).toBe("REVOKED");
    const before = database.get("SELECT last_seen_at, idle_expires_at, csrf_token_hash, revoked_at FROM auth_sessions");
    expect(await auth.authenticateAndTouch(raw(12), "2030-01-01T00:05:00.000Z")).toBeNull();
    expect(await auth.authenticateAndRotateCsrf(raw(12), "2030-01-01T00:05:00.000Z")).toBeNull();
    expect(await auth.logout(raw(12), raw(14), "2030-01-01T00:05:00.000Z")).toBe("INVALID_SESSION");
    expect(database.get("SELECT last_seen_at, idle_expires_at, csrf_token_hash, revoked_at FROM auth_sessions")).toEqual(before);
  });

  it("keeps invalid logout attempts byte-for-byte non-mutating and makes revoke idempotent", async () => {
    const { database } = await openDatabase();
    const auth = repository(database, makeHasher(), [raw(15), raw(16)]);
    await auth.issueSession(NOW);
    const before = database.get("SELECT last_seen_at, idle_expires_at, csrf_token_hash, revoked_at FROM auth_sessions");
    expect(await auth.logout(raw(15), raw(99), "2030-01-01T00:01:00.000Z")).toBe("CSRF_INVALID");
    expect(await auth.logout(raw(99), raw(16), "2030-01-01T00:01:00.000Z")).toBe("INVALID_SESSION");
    expect(await auth.logout(null, raw(16), "2030-01-01T00:01:00.000Z")).toBe("INVALID_SESSION");
    expect(database.get("SELECT last_seen_at, idle_expires_at, csrf_token_hash, revoked_at FROM auth_sessions")).toEqual(before);
    expect(await auth.revokeByToken(raw(15), "2030-01-01T00:02:00.000Z")).toBe("REVOKED");
    expect(await auth.revokeByToken(raw(15), "2030-01-02T00:03:00.000Z")).toBe("ALREADY_REVOKED");
  });

  it("classifies the session before validating CSRF and never digests inactive or malformed CSRF", async () => {
    const { database } = await openDatabase();
    const calls: number[] = [];
    const trackingDigest: DigestPort = {
      sha256Hex(value) {
        calls.push(value.length);
        return digestPort.sha256Hex(value);
      },
    };
    const random = makeRandomPort([raw(21), raw(22)]);
    const auth = createAuthRepository(database, makeHasher(), random, trackingDigest);
    await auth.issueSession(NOW);
    expect(calls).toEqual([AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES]);

    expect(await auth.logout(raw(21), null, "2030-01-01T00:01:00.000Z")).toBe("CSRF_INVALID");
    expect(await auth.logout(raw(21), new Uint8Array(1), "2030-01-01T00:01:00.000Z")).toBe("CSRF_INVALID");
    expect(calls).toEqual([AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES]);

    expect(await auth.logout(new Uint8Array(1), new Uint8Array(1), "2030-01-01T00:01:00.000Z")).toBe("INVALID_SESSION");
    expect(calls).toEqual([AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES]);
    expect(await auth.logout(raw(99), new Uint8Array(1), "2030-01-01T00:01:00.000Z")).toBe("INVALID_SESSION");
    expect(calls).toEqual([AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES, AUTH_TOKEN_BYTES]);
  });

  it("ignores malformed CSRF for idle-expired, absolute-expired, and revoked sessions", async () => {
    const { database } = await openDatabase();
    const strictDigest: DigestPort = {
      sha256Hex(value) {
        if (value.length !== AUTH_TOKEN_BYTES) throw new Error("malformed digest input");
        return digestPort.sha256Hex(value);
      },
    };
    const auth = createAuthRepository(
      database,
      makeHasher(),
      makeRandomPort([raw(23), raw(24), raw(25), raw(26), raw(27), raw(28)]),
      strictDigest,
    );
    await auth.issueSession(NOW);
    expect(await auth.logout(raw(23), new Uint8Array(1), "2030-01-01T00:30:00.000Z")).toBe("INVALID_SESSION");

    await auth.issueSession(NOW);
    expect(await auth.logout(raw(25), new Uint8Array(1), "2030-01-02T00:00:00.000Z")).toBe("INVALID_SESSION");

    await auth.issueSession(NOW);
    expect(await auth.revokeByToken(raw(27), "2030-01-01T00:01:00.000Z")).toBe("REVOKED");
    expect(await auth.logout(raw(27), new Uint8Array(1), "2030-01-01T00:01:01.000Z")).toBe("INVALID_SESSION");
  });

  it("revokes expired sessions idempotently without touching valid sessions", async () => {
    const { database } = await openDatabase();
    const auth = repository(database, makeHasher(), [raw(17), raw(18), raw(19), raw(20)]);
    await auth.issueSession(NOW);
    await auth.issueSession("2030-01-02T00:00:00.000Z");
    expect(await auth.revokeExpired("2030-01-01T00:29:59.000Z")).toBe(0);
    expect(await auth.revokeExpired("2030-01-02T00:00:00.000Z")).toBe(1);
    expect(await auth.revokeExpired("2030-01-02T00:00:01.000Z")).toBe(0);
  });

  it("zeroes issued raw tokens when random, hashing, or persistence fails", async () => {
    const { database } = await openDatabase();
    const first = raw(31);
    let randomCalls = 0;
    const failingRandom: RandomTokenPort = {
      randomBytes() {
        randomCalls += 1;
        if (randomCalls === 1) return first;
        throw new Error("random failure");
      },
    };
    await expect(createAuthRepository(database, makeHasher(), failingRandom, digestPort).issueSession(NOW)).rejects.toThrow("random failure");
    expect(first.every((value) => value === 0)).toBe(true);

    const hashedSession = raw(33);
    const hashedCsrf = raw(34);
    let digestCalls = 0;
    const failingDigest: DigestPort = {
      sha256Hex(value) {
        digestCalls += 1;
        if (digestCalls === 2) throw new Error("digest failure");
        return digestPort.sha256Hex(value);
      },
    };
    await expect(createAuthRepository(database, makeHasher(), makeRandomPort([hashedSession, hashedCsrf]), failingDigest).issueSession(NOW)).rejects.toThrow("digest failure");
    expect(hashedSession.every((value) => value === 0)).toBe(true);
    expect(hashedCsrf.every((value) => value === 0)).toBe(true);

    const persistedSession = raw(41);
    const persistedCsrf = raw(42);
    await repository(database, makeHasher(), [persistedSession, persistedCsrf]).issueSession(NOW);
    const duplicateSession = raw(41);
    const duplicateCsrf = raw(42);
    await expect(repository(database, makeHasher(), [duplicateSession, duplicateCsrf]).issueSession(NOW)).rejects.toThrow();
    expect(duplicateSession.every((value) => value === 0)).toBe(true);
    expect(duplicateCsrf.every((value) => value === 0)).toBe(true);

    const rotateSession = raw(35);
    const rotateCsrf = raw(36);
    const auth = repository(database, makeHasher(), [rotateSession, rotateCsrf]);
    await auth.issueSession(NOW);
    const replacement = raw(37);
    const rotateFailingDigest: DigestPort = {
      sha256Hex(value) {
        if (value === replacement) throw new Error("rotate digest failure");
        return digestPort.sha256Hex(value);
      },
    };
    const rotating = createAuthRepository(database, makeHasher(), makeRandomPort([replacement]), rotateFailingDigest);
    await expect(rotating.authenticateAndRotateCsrf(rotateSession, "2030-01-01T00:01:00.000Z")).rejects.toThrow("rotate digest failure");
    expect(replacement.every((value) => value === 0)).toBe(true);
  });

  it("preserves raw tokens only on successful issue and CSRF rotation", async () => {
    const { database } = await openDatabase();
    const session = raw(38);
    const csrf = raw(39);
    const auth = repository(database, makeHasher(), [session, csrf]);
    const issued = await auth.issueSession(NOW);
    expect(issued.rawSessionToken).toEqual(raw(38));
    expect(issued.rawCsrfToken).toEqual(raw(39));
    const replacement = raw(40);
    const rotated = await createAuthRepository(database, makeHasher(), makeRandomPort([replacement]), digestPort)
      .authenticateAndRotateCsrf(session, "2030-01-01T00:01:00.000Z");
    expect(rotated?.rawCsrfToken).toEqual(raw(40));
  });

  it("uses fixed-size timing-safe digest comparison for CSRF hashes", () => {
    const source = readFileSync(new URL("../../../src/platform/security/auth-repository.ts", import.meta.url), "utf8");
    expect(source).toContain("timingSafeEqual");
    expect(source).toMatch(/length === .*timingSafeEqual/s);
  });

  it("classifies direct authorized mutations before inspecting malformed or null CSRF", async () => {
    const { database } = await openDatabase();
    const calls: number[] = [];
    const trackingDigest: DigestPort = { sha256Hex(value) { calls.push(value.length); return digestPort.sha256Hex(value); } };
    const auth = createAuthRepository(database, makeHasher(), makeRandomPort([raw(51), raw(52), raw(53), raw(54)]), trackingDigest);
    await auth.issueSession(NOW);
    const baseline = database.get("SELECT last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at, revoked_at FROM auth_sessions");
    expect(await auth.authenticateCsrfAndTouch(raw(51), raw(99), "2030-01-01T00:01:00.000Z")).toBe("CSRF_INVALID");
    expect(await auth.authenticateCsrfAndTouch(raw(51), null, "2030-01-01T00:01:00.000Z")).toBe("CSRF_INVALID");
    expect(await auth.authenticateCsrfAndTouch(raw(51), new Uint8Array(1), "2030-01-01T00:01:00.000Z")).toBe("CSRF_INVALID");
    expect(calls).toEqual([32, 32, 32, 32, 32, 32]);
    expect(database.get("SELECT last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at, revoked_at FROM auth_sessions")).toEqual(baseline);

    expect(await auth.authenticateCsrfAndTouch(new Uint8Array(1), null, "2030-01-01T00:01:00.000Z")).toBe("INVALID_SESSION");
    expect(await auth.authenticateCsrfAndTouch(raw(99), new Uint8Array(1), "2030-01-01T00:01:00.000Z")).toBe("INVALID_SESSION");
    expect(calls).toEqual([32, 32, 32, 32, 32, 32, 32]);
    expect(database.get("SELECT last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at, revoked_at FROM auth_sessions")).toEqual(baseline);
  });

  it("returns INVALID_SESSION for revoked and expired sessions without CSRF inspection or durable changes", async () => {
    const { database } = await openDatabase();
    const auth = repository(database, makeHasher(), [raw(61), raw(62), raw(63), raw(64), raw(65), raw(66)]);
    await auth.issueSession(NOW);
    await auth.issueSession(NOW);
    await auth.issueSession(NOW);
    await auth.revokeByToken(raw(65), "2030-01-01T00:01:00.000Z");
    const before = database.all("SELECT id, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at, revoked_at FROM auth_sessions");
    expect(await auth.authenticateCsrfAndTouch(raw(61), null, "2030-01-01T00:30:00.000Z")).toBe("INVALID_SESSION");
    expect(await auth.authenticateCsrfAndTouch(raw(63), new Uint8Array(1), "2030-01-02T00:00:00.000Z")).toBe("INVALID_SESSION");
    expect(await auth.authenticateCsrfAndTouch(raw(65), new Uint8Array(1), "2030-01-01T00:01:01.000Z")).toBe("INVALID_SESSION");
    expect(database.all("SELECT id, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at, revoked_at FROM auth_sessions")).toEqual(before);
  });
});
