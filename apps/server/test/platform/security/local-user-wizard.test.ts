import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import {
  createAuthRepository,
  type AuthRepository,
} from "../../../src/platform/security/auth-repository.js";
import type { PasswordHasher } from "../../../src/platform/security/auth-ports.js";
import type { Database } from "../../../src/platform/database/database.js";
import {
  ensureLocalUser,
  runLocalUserWizard,
  type LocalUserWizardResult,
} from "../../../src/platform/security/local-user-wizard.js";

const PASSWORD = "correct horse battery staple";
const PHC = "$argon2id$v=19$m=65536,p=4,t=3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const databases: Array<{ close(): void }> = [];

class FakeTtyInput extends PassThrough {
  public readonly isTTY = true;
  public readonly rawModeCalls: boolean[] = [];

  public setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    return this;
  }
}

class SynchronousTerminalInput extends EventEmitter {
  public readonly isTTY = true;
  public readonly rawModeCalls: boolean[] = [];

  public constructor(private readonly terminalEvent: "end" | "error") {
    super();
  }

  public setRawMode(mode: boolean): this {
    this.rawModeCalls.push(mode);
    return this;
  }

  public pause(): this {
    return this;
  }

  public resume(): this {
    if (this.terminalEvent === "end") {
      this.emit("end");
    } else {
      this.emit("error", new Error("synchronous input failure"));
    }
    return this;
  }
}

function makeTtyOutput(): NodeJS.WriteStream & { text: string } {
  const output = new Writable({
    write(chunk, _encoding, callback) {
      output.text += chunk.toString();
      callback();
    },
  }) as NodeJS.WriteStream & { text: string };
  output.isTTY = true;
  output.text = "";
  return output;
}

function makeRepository(): AuthRepository & { createLocalUser: ReturnType<typeof vi.fn>; database: Database } {
  const database = createSqliteDatabase(":memory:");
  databases.push(database);
  runMigrations(database, loadTestMigrations());
  const hasher: PasswordHasher = {
    hash: async () => PHC,
    verify: async () => false,
  };
  const repository = createAuthRepository(
    database,
    hasher,
    { randomBytes: () => new Uint8Array(32) },
    { sha256Hex: () => "0".repeat(64) },
  );
  return Object.assign(repository, { createLocalUser: vi.spyOn(repository, "createLocalUser"), database });
}

async function runWithLines(
  input: FakeTtyInput,
  output: NodeJS.WriteStream,
  repository: AuthRepository,
  lines: string[],
): Promise<LocalUserWizardResult> {
  const result = runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository, { now: () => "2030-01-01T00:00:00.000Z" });
  await waitForImmediate();
  for (const line of lines) {
    input.write(`${line}\r`);
    await waitForImmediate();
  }
  return result;
}

function rejectAfterTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`test timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("local first-run password wizard", () => {
  it("creates a local user from exactly two newline-terminated stdin records", async () => {
    const input = new PassThrough();
    const output = makeTtyOutput();
    const repository = makeRepository();
    const pending = ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, output, { mode: "stdin", now: () => "2030-01-01T00:00:00.000Z" });
    input.end(Buffer.from(`${PASSWORD}\r\n${PASSWORD}\n`));

    await expect(pending).resolves.toBe("CREATED");
    expect(repository.createLocalUser).toHaveBeenCalledOnce();
    expect(output.text).not.toContain(PASSWORD);
    expect(await repository.hasLocalUser()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("stops stdin setup and removes listeners when startup is aborted", async () => {
    const input = new PassThrough();
    const repository = makeRepository();
    const controller = new AbortController();
    const pending = ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, makeTtyOutput(), {
      mode: "stdin",
      signal: controller.signal,
    });
    await waitForImmediate();

    controller.abort(new Error("Startup interrupted by SIGTERM"));

    await expect(rejectAfterTimeout(pending, 100)).rejects.toThrow("Startup interrupted by SIGTERM");
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
  });

  it.each([
    [`${PASSWORD}\n${PASSWORD}`, "truncated"],
    [`${PASSWORD}\n${PASSWORD}\nextra`, "extra"],
  ])("rejects %s stdin framing", async (payload) => {
    const input = new PassThrough();
    const repository = makeRepository();
    const pending = ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, makeTtyOutput(), { mode: "stdin" });
    input.end(Buffer.from(payload));

    await expect(pending).rejects.toThrow();
    expect(repository.createLocalUser).not.toHaveBeenCalled();
  });

  it("does not consume stdin when a local user already exists", async () => {
    const input = new PassThrough();
    const repository = makeRepository();
    await repository.createLocalUser(Buffer.from(PASSWORD), "2030-01-01T00:00:00.000Z");
    const create = repository.createLocalUser;
    create.mockClear();
    input.write(Buffer.from("must remain unread"));

    await expect(ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, makeTtyOutput(), { mode: "stdin" })).resolves.toBe("EXISTING");
    expect(input.readableLength).toBeGreaterThan(0);
    expect(input.listenerCount("data")).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("times out before persistence when stdin remains open after both terminated records", async () => {
    const input = new PassThrough();
    const repository = makeRepository();
    const pending = ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, makeTtyOutput(), { mode: "stdin", inputTimeoutMs: 20 });
    input.write(Buffer.from(`${PASSWORD}\n${PASSWORD}\n`));

    await expect(pending).rejects.toThrow(/timed out/i);
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
  });

  it("rejects records over 4096 bytes and clears input listeners", async () => {
    const input = new PassThrough();
    const repository = makeRepository();
    const pending = ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, makeTtyOutput(), { mode: "stdin" });
    input.end(Buffer.concat([Buffer.alloc(4097, 0x61), Buffer.from("\n") ]));

    await expect(pending).rejects.toThrow(/4096-byte limit/i);
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
  });

  it("keeps the default first-run path on the fail-closed TTY wizard", async () => {
    const input = new PassThrough();
    const repository = makeRepository();

    await expect(ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, makeTtyOutput())).rejects.toThrow(/interactive TTY/i);
    expect(repository.createLocalUser).not.toHaveBeenCalled();
  });

  it("rejects stdin stream errors without creating a user and clears listeners", async () => {
    const input = new PassThrough();
    const repository = makeRepository();
    const pending = ensureLocalUser(repository, input as unknown as NodeJS.ReadStream, makeTtyOutput(), { mode: "stdin" });
    await waitForImmediate();
    input.write(Buffer.from(`${PASSWORD}\n`));
    input.emit("error", new Error("injected stream failure"));

    await expect(pending).rejects.toThrow(/input failed/i);
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
  });

  it("fails closed before creating a user when either stream is not a TTY", async () => {
    const input = new PassThrough();
    const output = makeTtyOutput();
    const repository = makeRepository();

    await expect(runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository)).rejects.toThrow(/interactive TTY/i);
    expect(repository.createLocalUser).not.toHaveBeenCalled();
  });

  it("returns failure and creates no user when confirmation does not match", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();

    await expect(runWithLines(input, output, repository, [PASSWORD, "different password"])).resolves.toBe("FAILED");
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.rawModeCalls).toEqual([true, false, true, false]);
    expect(output.text).not.toContain(PASSWORD);
  });

  it("rejects weak input without persisting a user", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();

    await expect(runWithLines(input, output, repository, ["short", "short"])).resolves.toBe("FAILED");
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(output.text).toMatch(/12/);
  });

  it("creates exactly one singleton user with a versioned hash and never prints the password", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();

    await expect(runWithLines(input, output, repository, [PASSWORD, PASSWORD])).resolves.toBe("CREATED");
    expect(repository.createLocalUser).toHaveBeenCalledOnce();
    expect(repository.createLocalUser).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "2030-01-01T00:00:00.000Z",
    );
    expect(output.text).not.toContain(PASSWORD);
    expect(await repository.hasLocalUser()).toBe(true);
    expect(repository.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM local_users")).toEqual({ count: 1 });
    expect(repository.database.get<{ password_hash: string; hash_algorithm: string; hash_parameters_json: string }>("SELECT password_hash, hash_algorithm, hash_parameters_json FROM local_users")).toEqual({
      password_hash: PHC,
      hash_algorithm: "argon2id",
      hash_parameters_json: JSON.stringify({ memoryCost: 65536, timeCost: 3, parallelism: 4, hashLength: 32, saltLength: 16 }),
    });
  });

  it("restores terminal echo after a successful setup", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();

    await expect(runWithLines(input, output, repository, [PASSWORD, PASSWORD])).resolves.toBe("CREATED");
    expect(input.rawModeCalls).toEqual([true, false, true, false]);
  });

  it("fails closed and restores terminal echo when input reaches EOF", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();
    const pending = runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository);
    await waitForImmediate();

    input.end();

    await expect(rejectAfterTimeout(pending, 100)).rejects.toThrow(/closed unexpectedly|EOF/i);
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("restores terminal state and clears listeners when startup is aborted during password input", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();
    const controller = new AbortController();
    const pending = runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository, { signal: controller.signal });
    await waitForImmediate();

    controller.abort(new Error("Startup interrupted by SIGTERM"));

    await expect(rejectAfterTimeout(pending, 100)).rejects.toThrow("Startup interrupted by SIGTERM");
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it.each(["end", "error"] as const)("fails closed when %s fires synchronously during resume", async (terminalEvent) => {
    const input = new SynchronousTerminalInput(terminalEvent);
    const output = makeTtyOutput();
    const repository = makeRepository();

    await expect(rejectAfterTimeout(
      runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository),
      100,
    )).rejects.toThrow(terminalEvent === "end" ? /EOF/i : "synchronous input failure");

    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("rejects string chunks without creating an immutable password copy and cleans up listeners", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();
    const pending = runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository);
    await waitForImmediate();

    input.emit("data", PASSWORD);

    await expect(pending).rejects.toThrow(/binary/i);
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
  });

  it("validates the raw password by bytes without decoding it into a password string", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();
    const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");
    const password = "é".repeat(6);

    try {
      await expect(runWithLines(input, output, repository, [password, password])).resolves.toBe("CREATED");
      expect(decodeSpy).not.toHaveBeenCalled();
      expect(repository.createLocalUser).toHaveBeenCalledOnce();
    } finally {
      decodeSpy.mockRestore();
    }
  });

  it("zeroes the mutable password bytes after repository persistence", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();

    await expect(runWithLines(input, output, repository, [PASSWORD, PASSWORD])).resolves.toBe("CREATED");
    const persistedPassword = repository.createLocalUser.mock.calls[0]?.[0] as Uint8Array;
    expect(persistedPassword).toBeInstanceOf(Uint8Array);
    expect([...persistedPassword]).toEqual(new Array(PASSWORD.length).fill(0));
  });

  it("restores terminal echo and clears the password when repository I/O fails", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();
    repository.createLocalUser.mockRejectedValue(new Error("database write failed"));

    const pending = runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository);
    const outcome = pending.then(() => undefined, (error: unknown) => error);
    await waitForImmediate();
    input.write(`${PASSWORD}\r`);
    await waitForImmediate();
    input.write(`${PASSWORD}\r`);
    await expect(outcome).resolves.toMatchObject({ message: "database write failed" });
    const persistedPassword = repository.createLocalUser.mock.calls[0]?.[0] as Uint8Array;
    expect([...persistedPassword]).toEqual(new Array(PASSWORD.length).fill(0));
    expect(input.rawModeCalls).toEqual([true, false, true, false]);
  });

  it("rejects an output write failure after restoring terminal echo", async () => {
    const input = new FakeTtyInput();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("output failed"));
      },
    }) as NodeJS.WriteStream & { isTTY?: boolean };
    output.isTTY = true;
    const repository = makeRepository();

    await expect(runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository)).rejects.toThrow("output failed");
    expect(repository.createLocalUser).not.toHaveBeenCalled();
    expect(input.rawModeCalls).toEqual([true, false]);
    await waitForImmediate();
    expect(output.listenerCount("error")).toBe(0);
  });

  it("restores terminal echo after an input error", async () => {
    const input = new FakeTtyInput();
    const output = makeTtyOutput();
    const repository = makeRepository();
    const pending = runLocalUserWizard(input as unknown as NodeJS.ReadStream, output, repository);
    await waitForImmediate();
    input.emit("error", new Error("input disconnected"));

    await expect(pending).rejects.toThrow("input disconnected");
    expect(input.rawModeCalls).toEqual([true, false]);
  });
});

export const localUserWizardTestConstants = { PASSWORD };
