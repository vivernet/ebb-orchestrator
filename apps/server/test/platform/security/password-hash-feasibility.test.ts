import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";
import {
  ARGON2ID_OPTIONS,
  createArgon2PasswordHasher,
} from "../../../src/platform/security/password-hasher.js";

const PASSWORD = new TextEncoder().encode("known-test-password");
const WRONG_PASSWORD = new TextEncoder().encode("wrong-test-password");
const PHC_PATTERN = /^\$argon2id\$v=19\$m=65536,p=4,t=3\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const isWindowsX64 = process.platform === "win32" && process.arch === "x64";

describe("bounded Argon2id password hashing feasibility", () => {
  it.skipIf(!isWindowsX64)("loads the native binding on Node >=24.15 on Windows x64", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(24);
    if (major === 24) {
      expect(minor).toBeGreaterThanOrEqual(15);
    }
    expect(process.platform).toBe("win32");
    expect(process.arch).toBe("x64");
    expect(argon2.argon2id).toBeDefined();
  });

  it("hashes and verifies Argon2id PHC values with the locked parameters", async () => {
    const hasher = createArgon2PasswordHasher();
    const startedAt = performance.now();
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);
    const elapsedMs = performance.now() - startedAt;

    expect(first).toMatch(PHC_PATTERN);
    expect(second).toMatch(PHC_PATTERN);
    expect(first).not.toContain("known-test-password");
    expect(second).not.toContain("known-test-password");
    expect(first).not.toBe(second);
    expect(PHC_PATTERN.exec(first)?.[1]).not.toBe(PHC_PATTERN.exec(second)?.[1]);
    expect(await hasher.verify(first, PASSWORD)).toBe(true);
    expect(await hasher.verify(first, WRONG_PASSWORD)).toBe(false);
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  it("rejects otherwise valid PHC values with non-contract salt or digest lengths", async () => {
    const hasher = createArgon2PasswordHasher();
    const shortSalt = await argon2.hash(Buffer.from(PASSWORD), { ...ARGON2ID_OPTIONS, salt: Buffer.alloc(8, 1) });
    const shortDigest = await argon2.hash(Buffer.from(PASSWORD), { ...ARGON2ID_OPTIONS, hashLength: 16 });

    expect(await hasher.verify(shortSalt, PASSWORD)).toBe(false);
    expect(await hasher.verify(shortDigest, PASSWORD)).toBe(false);
  }, 60_000);

  it("propagates operational argon2 verification failures", async () => {
    const hasher = createArgon2PasswordHasher();
    const encoded = await hasher.hash(PASSWORD);
    const failure = new Error("native verification failure");
    const verifySpy = vi.spyOn(argon2, "verify").mockRejectedValueOnce(failure);

    try {
      await expect(hasher.verify(encoded, PASSWORD)).rejects.toBe(failure);
    } finally {
      verifySpy.mockRestore();
    }
  }, 60_000);

  it("rejects malformed and unknown-version PHC values without fallback", async () => {
    const hasher = createArgon2PasswordHasher();
    expect(await hasher.verify("not-a-phc", PASSWORD)).toBe(false);
    expect(await hasher.verify("$argon2id$v=20$m=65536,p=4,t=3$invalid$invalid", PASSWORD)).toBe(false);
    expect(await hasher.verify("$argon2i$v=19$m=65536,p=4,t=3$invalid$invalid", PASSWORD)).toBe(false);
  });
});
