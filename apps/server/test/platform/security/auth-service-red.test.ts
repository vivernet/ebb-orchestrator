import { describe, expect, it } from "vitest";
import { createAuthService } from "../../../src/platform/security/auth-service.js";
import type { AuthClock, PasswordHasher } from "../../../src/platform/security/auth-ports.js";
import type { AuthRepository } from "../../../src/platform/security/auth-repository.js";
import { createTestAuthService } from "../../helpers/auth.js";

describe("LocalAuthService security boundary", () => {
  it("constructs only from repository, password hasher and clock and delegates login", async () => {
    const password = new Uint8Array([1, 2, 3]);
    const repository = {
      hasLocalUser: async () => true,
      findLocalUser: async () => ({
        id: 1 as const,
        passwordHash: "phc",
        hashAlgorithm: "argon2id" as const,
        hashParametersJson: "{}",
      }),
      issueSession: async () => ({
        session: {
          id: "session-1",
          absoluteExpiresAt: "2030-01-02T00:00:00.000Z",
          idleExpiresAt: "2030-01-01T00:30:00.000Z",
        },
        rawSessionToken: new Uint8Array(32),
        rawCsrfToken: new Uint8Array(32),
      }),
    } as unknown as AuthRepository;
    const passwordHasher: PasswordHasher = {
      hash: async () => "phc",
      verify: async () => true,
    };
    const clock: AuthClock = { now: () => "2030-01-01T00:00:00.000Z" };

    const service = createAuthService(repository, passwordHasher, clock);

    await expect(service.login(password)).resolves.toMatchObject({ ok: true });
  });

  it("maps every repository logout classification without owning crypto ports", async () => {
    const outcomes = ["REVOKED", "INVALID_SESSION", "CSRF_INVALID"] as const;
    const passwordHasher: PasswordHasher = { hash: async () => "phc", verify: async () => true };
    const clock: AuthClock = { now: () => "2030-01-01T00:00:00.000Z" };
    for (const outcome of outcomes) {
      const repository = { logout: async () => outcome } as unknown as AuthRepository;
      const service = createAuthService(repository, passwordHasher, clock);
      const result = await service.logout(new Uint8Array(32), new Uint8Array(32));
      if (outcome === "CSRF_INVALID") expect(result).toEqual({ ok: false, code: "CSRF_INVALID" });
      else expect(result).toEqual({ ok: true, value: outcome === "REVOKED" ? "REVOKED" : "IDEMPOTENT_INVALID_SESSION" });
    }
  });

  it("delegates an authorized mutation exactly once to the atomic repository seam", async () => {
    const calls: Array<{ session: Uint8Array; csrf: Uint8Array | null; now: string }> = [];
    const repository = {
      authenticateCsrfAndTouch: async (session: Uint8Array, csrf: Uint8Array | null, now: string) => {
        calls.push({ session, csrf, now });
        if (calls.length > 1) throw new Error("second auth operation");
        return "CSRF_INVALID" as const;
      },
    } as unknown as AuthRepository;
    const service = createAuthService(repository, { hash: async () => "phc", verify: async () => true }, { now: () => "2030-01-01T00:00:00.000Z" });

    await expect(service.authenticateCsrfAndTouch(new Uint8Array(32), new Uint8Array(32))).resolves.toEqual({ ok: false, code: "CSRF_INVALID" });
    expect(calls).toHaveLength(1);
  });

  it("zeroes issued secrets when login response construction fails", async () => {
    const rawSessionToken = Buffer.alloc(32, 1);
    const rawCsrfToken = Buffer.alloc(32, 2);
    const repository = {
      findLocalUser: async () => ({ id: 1 as const, passwordHash: "phc", hashAlgorithm: "argon2id" as const, hashParametersJson: "{}" }),
      issueSession: async () => ({
        rawSessionToken,
        rawCsrfToken,
        session: { id: "session", idleExpiresAt: "2030-01-01T00:30:00.000Z", get absoluteExpiresAt(): string { throw new Error("response construction"); } },
      }),
    } as unknown as AuthRepository;
    const service = createAuthService(repository, { hash: async () => "phc", verify: async () => true }, { now: () => "2030-01-01T00:00:00.000Z" });

    await expect(service.login(Buffer.from("password"))).resolves.toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(rawSessionToken.every((byte) => byte === 0)).toBe(true);
    expect(rawCsrfToken.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes rotated CSRF when restore response construction fails", async () => {
    const rawCsrfToken = Buffer.alloc(32, 3);
    const repository = {
      authenticateAndRotateCsrf: async () => ({
        rawCsrfToken,
        session: { id: "session", idleExpiresAt: "2030-01-01T00:30:00.000Z", get absoluteExpiresAt(): string { throw new Error("response construction"); } },
      }),
    } as unknown as AuthRepository;
    const service = createAuthService(repository, { hash: async () => "phc", verify: async () => true }, { now: () => "2030-01-01T00:00:00.000Z" });

    await expect(service.restoreAndRotateCsrf(Buffer.alloc(32, 4))).resolves.toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(rawCsrfToken.every((byte) => byte === 0)).toBe(true);
  });

  it("makes the route fake reject a second auth operation in either order", async () => {
    const fake = createTestAuthService();
    const first = fake.authenticateAndTouch(new Uint8Array(32));
    const second = fake.authenticateCsrfAndTouch(new Uint8Array(32), new Uint8Array(32));
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).rejects.toThrow("Повторная или альтернативная auth-операция");

    const secondFake = createTestAuthService();
    const secondFirst = secondFake.authenticateCsrfAndTouch(new Uint8Array(32), new Uint8Array(32));
    const secondSecond = secondFake.authenticateCsrfAndTouch(new Uint8Array(32), new Uint8Array(32));
    await expect(secondFirst).resolves.toMatchObject({ ok: true });
    await expect(secondSecond).rejects.toThrow("Повторная или альтернативная auth-операция");

    const thirdFake = createTestAuthService();
    const thirdFirst = thirdFake.authenticateCsrfAndTouch(new Uint8Array(32), new Uint8Array(32));
    const thirdSecond = thirdFake.authenticateAndTouch(new Uint8Array(32));
    await expect(thirdFirst).resolves.toMatchObject({ ok: true });
    await expect(thirdSecond).rejects.toThrow("Повторная или альтернативная auth-операция");
  });
});
