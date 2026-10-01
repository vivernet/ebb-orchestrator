import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN_BYTES } from "@ebb-orchestrator/contracts";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { createAuthRepository } from "../../../src/platform/security/auth-repository.js";
import { createNodeDigestPort } from "../../../src/platform/security/auth-ports.js";
import type { Database } from "../../../src/platform/database/database.js";
import type { RawSecretBytes } from "../../../src/platform/security/auth-ports.js";

const WORKER_SOURCE = `
  // TSX's temp-directory fallback calls os.userInfo() on Windows; use a process-local cache identity instead.
  process.geteuid ??= () => process.pid;
  await import("tsx/esm");
  const { parentPort, workerData } = await import("node:worker_threads");
  const { createSqliteDatabase } = await import(workerData.databaseUrl);
  const { runMigrations } = await import(workerData.migratorUrl);
  const { loadTestMigrations } = await import(workerData.migrationsUrl);
  const { createAuthRepository } = await import(workerData.repositoryUrl);
  const { createNodeDigestPort } = await import(workerData.portsUrl);
  let database;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { database = createSqliteDatabase(workerData.path); break; }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("locked") || attempt === 39) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const transaction = database.transaction.bind(database);
  database.transaction = (fn) => transaction((tx) => { parentPort.postMessage({ kind: "acquired", workerId: workerData.workerId }); return fn(tx); });
  const auth = createAuthRepository(database, { hash: async () => workerData.phc, verify: async () => true }, { randomBytes: () => new Uint8Array(32).fill(workerData.randomByte ?? 0) }, createNodeDigestPort());
  const token = Uint8Array.from(workerData.token);
  const csrf = Uint8Array.from(workerData.csrf);
  parentPort.postMessage({ kind: "ready", workerId: workerData.workerId });
  await new Promise((resolve) => parentPort.once("message", (message) => {
    if (message !== "release") throw new Error("unexpected worker release command");
    parentPort.postMessage({ kind: "released", workerId: workerData.workerId });
    resolve();
  }));
  let result;
  if (workerData.operation === "authorize") result = await auth.authenticateCsrfAndTouch(token, csrf, workerData.now);
  if (workerData.operation === "rotate") { const rotated = await auth.authenticateAndRotateCsrf(token, workerData.now); result = rotated ? { digest: createNodeDigestPort().sha256Hex(rotated.rawCsrfToken) } : null; }
  if (workerData.operation === "logout") result = await auth.logout(token, csrf, workerData.now);
  database.close();
  parentPort.postMessage({ kind: "complete", workerId: workerData.workerId, result });
`;
const PHC = "$argon2id$v=19$m=65536,p=4,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = "2030-01-01T00:00:00.000Z";
type Operation = "authorize" | "rotate" | "logout";
type Row = { last_seen_at: string; idle_expires_at: string; csrf_token_hash: string; absolute_expires_at: string; revoked_at: string | null };
let databases: Database[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function byte(value: number): RawSecretBytes { return new Uint8Array(AUTH_TOKEN_BYTES).fill(value); }
function snapshot(path: string): Row {
  const database = createSqliteDatabase(path);
  const row = database.get<Row>("SELECT last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at, revoked_at FROM auth_sessions");
  database.close();
  if (!row) throw new Error("missing durable auth row");
  return row;
}
async function setup(): Promise<{ path: string; token: RawSecretBytes; csrf: RawSecretBytes }> {
  const directory = await mkdtemp(join(tmpdir(), "ebb-auth-race-"));
  directories.push(directory);
  const path = join(directory, "race.sqlite");
  const database = createSqliteDatabase(path);
  databases.push(database);
  runMigrations(database, loadTestMigrations());
  const sequence = [byte(21), byte(22)];
  const issued = await createAuthRepository(database, { hash: async () => PHC, verify: async () => true }, { randomBytes: () => sequence.shift() ?? byte(0) }, createNodeDigestPort()).issueSession(NOW);
  database.close();
  databases = databases.filter((candidate) => candidate !== database);
  return { path, token: issued.rawSessionToken, csrf: issued.rawCsrfToken };
}
async function runControlledRace(path: string, token: RawSecretBytes, csrf: RawSecretBytes, first: Operation, second: Operation): Promise<{ firstResult: unknown; secondResult: unknown; afterFirst: Row }> {
  const workers = new Map<number, Worker>();
  const events: Array<{ kind: string; workerId: number; result?: unknown }> = [];
  const spawn = (workerId: number, operation: Operation, randomByte: number | null) => new Worker(WORKER_SOURCE, { eval: true, execArgv: ["--input-type=module"], workerData: {
    path, workerId, operation, randomByte, now: "2030-01-01T00:01:00.000Z", phc: PHC, token: [...token], csrf: [...csrf],
    databaseUrl: new URL("../../../src/platform/database/sqlite-database.ts", import.meta.url).href,
    migratorUrl: new URL("../../../src/platform/database/migrator.ts", import.meta.url).href,
    migrationsUrl: new URL("../../helpers/migrations.ts", import.meta.url).href,
    repositoryUrl: new URL("../../../src/platform/security/auth-repository.ts", import.meta.url).href,
    portsUrl: new URL("../../../src/platform/security/auth-ports.ts", import.meta.url).href,
  } });
  workers.set(1, spawn(1, first, first === "rotate" ? 31 : null));
  workers.set(2, spawn(2, second, second === "rotate" ? 32 : null));
  for (const worker of workers.values()) {
    worker.on("message", (message: { kind: string; workerId: number; result?: unknown }) => events.push(message));
  }
  const waitFor = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`missing ${label} acknowledgement`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const count = (kind: string, workerId?: number) => events.filter((event) => event.kind === kind && (workerId === undefined || event.workerId === workerId));
  await waitFor(() => count("ready").length === 2, "unique readiness");
  if (count("ready").some((_, index, all) => index !== all.findIndex((event) => event.workerId === all[index]?.workerId))) throw new Error("duplicate readiness acknowledgement");
  workers.get(1)?.postMessage("release");
  await waitFor(() => count("released", 1).length === 1, "first release");
  await waitFor(() => count("acquired", 1).length === 1, "first acquisition");
  await waitFor(() => count("complete", 1).length === 1, "first completion");
  const afterFirst = snapshot(path);
  workers.get(2)?.postMessage("release");
  await waitFor(() => count("released", 2).length === 1, "second release");
  await waitFor(() => count("acquired", 2).length === 1, "second acquisition");
  await waitFor(() => count("complete").length === 2, "both completions");
  for (const kind of ["ready", "released", "acquired", "complete"]) {
    if (count(kind).length !== 2 || new Set(count(kind).map((event) => event.workerId)).size !== 2) throw new Error(`duplicate or missing ${kind} acknowledgement`);
  }
  await Promise.all([...workers.values()].map((worker) => worker.terminate()));
  return { firstResult: count("complete", 1)[0]?.result, secondResult: count("complete", 2)[0]?.result, afterFirst };
}

describe("auth repository deterministic file-backed concurrency", () => {
  it.each(["authorization-first", "rotation-first"] as const)("serializes %s rotation versus authorized mutation with durable snapshots", async (order) => {
    const { path, token, csrf } = await setup();
    const before = snapshot(path);
    const race = await runControlledRace(path, token, csrf, order === "authorization-first" ? "authorize" : "rotate", order === "authorization-first" ? "rotate" : "authorize");
    const final = snapshot(path);
    const rotationDigest = createNodeDigestPort().sha256Hex(byte(order === "authorization-first" ? 32 : 31));
    const touched = {
      ...before,
      last_seen_at: "2030-01-01T00:01:00.000Z",
      idle_expires_at: "2030-01-01T00:31:00.000Z",
    };
    const rotated = {
      ...touched,
      csrf_token_hash: rotationDigest,
    };
    if (order === "authorization-first") {
      expect(race.firstResult).toMatchObject({ id: expect.any(String) });
      expect(race.afterFirst).toEqual(touched);
      expect(final).toEqual(rotated);
    } else {
      expect(race.firstResult).toEqual({ digest: rotationDigest });
      expect(race.afterFirst).toEqual(rotated);
      expect(race.secondResult).toBe("CSRF_INVALID");
      expect(final).toEqual(rotated);
    }
  });

  it.each(["touch-first", "logout-first"] as const)("serializes %s authorized mutation versus logout with durable snapshots", async (order) => {
    const { path, token, csrf } = await setup();
    const before = snapshot(path);
    const race = await runControlledRace(path, token, csrf, order === "touch-first" ? "authorize" : "logout", order === "touch-first" ? "logout" : "authorize");
    const final = snapshot(path);
    const revoked = { ...before, revoked_at: "2030-01-01T00:01:00.000Z" };
    const touched = {
      ...revoked,
      last_seen_at: "2030-01-01T00:01:00.000Z",
      idle_expires_at: "2030-01-01T00:31:00.000Z",
    };
    if (order === "touch-first") {
      expect(race.afterFirst).toEqual({ ...before, last_seen_at: touched.last_seen_at, idle_expires_at: touched.idle_expires_at });
      expect(final).toEqual(touched);
    } else {
      expect(race.afterFirst).toEqual(revoked);
      expect(race.secondResult).toBe("INVALID_SESSION");
      expect(final).toEqual(revoked);
    }
  });

  it("rejects a wrong CSRF authorized mutation without any durable row change", async () => {
    const { path, token } = await setup();
    const before = snapshot(path);
    const race = await runControlledRace(path, token, byte(99), "authorize", "logout");
    expect(race.firstResult).toBe("CSRF_INVALID");
    expect(race.afterFirst).toEqual(before);
  });
});
