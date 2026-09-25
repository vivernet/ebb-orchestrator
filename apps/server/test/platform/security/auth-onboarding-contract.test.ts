import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTH_ABSOLUTE_TTL_SECONDS,
  AUTH_CONTRACT_VERSION,
  AUTH_COOKIE_CONTRACT,
  AUTH_IDLE_TTL_SECONDS,
  AUTH_TOKEN_BYTES,
  ONBOARDING_CONTRACT_VERSION,
  apiPaths,
  authErrorCodeSchema,
  authErrorResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  onboardingApprovalRequestSchema,
  onboardingApproveRequestSchema,
  onboardingDiscoverRequestSchema,
  onboardingErrorCodeSchema,
  onboardingProjectionSchema,
  sessionResponseSchema,
} from "@ebb-orchestrator/contracts";
import type {
  AuthRepository,
  CreateAuthRepository,
  AuthSessionRecord,
  IssuedSession,
  LocalUserRecord,
  LogoutResult,
  RawSecretBytes,
  RotatedCsrf,
} from "../../../src/platform/security/auth-repository.js";
import type { AuthService } from "../../../src/platform/security/auth-service.js";
import type { CreateAuthService } from "../../../src/platform/security/auth-service.js";
import {
  AUTH_PORT_CONTRACT_VERSION,
  type AuthClock,
  type DigestPort,
  type PasswordHasher,
  type RandomTokenPort,
} from "../../../src/platform/security/auth-ports.js";
import type { Database } from "../../../src/platform/database/database.js";

describe("auth/onboarding contract v1", () => {
  it("exposes the exact versioned public paths and constants", () => {
    expect(AUTH_CONTRACT_VERSION).toBe(1);
    expect(ONBOARDING_CONTRACT_VERSION).toBe(1);
    expect(AUTH_IDLE_TTL_SECONDS).toBe(1800);
    expect(AUTH_ABSOLUTE_TTL_SECONDS).toBe(86400);
    expect(AUTH_TOKEN_BYTES).toBe(32);
    expect(AUTH_COOKIE_CONTRACT).toEqual({
      name: "ebb_local_session",
      path: "/api/v1",
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      maxAgeSeconds: 86400,
    });
    expect(Object.keys(apiPaths)).toEqual([
      "sessionLogin",
      "session",
      "sessionLogout",
      "events",
      "dashboard",
      "projectsCollection",
      "projects",
      "project",
      "projectTasks",
      "projectEpics",
      "epics",
      "epic",
      "tasks",
      "task",
      "taskDispatch",
      "execution",
      "approvals",
      "approvalApprove",
      "runs",
      "run",
      "runCancel",
      "runEvents",
      "runTools",
      "runPermissions",
      "runRecovery",
      "usage",
      "settings",
      "onboardingDiscover",
      "onboarding",
      "onboardingApproval",
      "onboardingApprove",
      "onboardingActivate",
    ]);
    expect(apiPaths.sessionLogin).toBe("/api/v1/session/login");
    expect(apiPaths.session).toBe("/api/v1/session");
    expect(apiPaths.sessionLogout).toBe("/api/v1/session/logout");
    expect(apiPaths.onboarding("draft/with spaces")).toBe("/api/v1/onboarding/draft%2Fwith%20spaces");
    expect(apiPaths.onboardingApproval("draft/with spaces")).toBe("/api/v1/onboarding/draft%2Fwith%20spaces/approval");
    expect(apiPaths.onboardingApprove("draft/with spaces")).toBe("/api/v1/onboarding/draft%2Fwith%20spaces/approve");
    expect(apiPaths.onboardingActivate("draft/with spaces")).toBe("/api/v1/onboarding/draft%2Fwith%20spaces/activate");
    expect("sessionBootstrap" in apiPaths).toBe(false);
  });

  it("validates the exact auth DTO shapes and error code unions", () => {
    expect(loginRequestSchema.parse({ password: "correct horse" })).toEqual({ password: "correct horse" });
    expect(loginRequestSchema.safeParse({ password: "x", username: "unexpected" }).success).toBe(false);
    expect(loginResponseSchema.parse({ contractVersion: 1, csrfToken: "csrf", expiresAt: "2030-01-01T00:00:00.000Z" })).toEqual({
      contractVersion: 1,
      csrfToken: "csrf",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(sessionResponseSchema.parse({ contractVersion: 1, authenticated: true, csrfToken: "csrf", expiresAt: "2030-01-01T00:00:00.000Z" })).toMatchObject({ authenticated: true });
    expect(authErrorCodeSchema.options).toEqual([
      "AUTH_INVALID_REQUEST",
      "AUTH_INVALID_CREDENTIALS",
      "AUTH_ORIGIN_INVALID",
      "AUTH_UNAVAILABLE",
      "AUTH_SESSION_REQUIRED",
      "AUTH_SESSION_INVALID",
      "AUTH_CSRF_INVALID",
    ]);
    expect(authErrorResponseSchema.parse({
      contractVersion: 1,
      error: { code: "AUTH_INVALID_CREDENTIALS", message: "Неверные учётные данные." },
    })).toEqual({
      contractVersion: 1,
      error: { code: "AUTH_INVALID_CREDENTIALS", message: "Неверные учётные данные." },
    });
  });

  it("rejects UTC timestamps with impossible calendar or clock fields", () => {
    const invalidTimestamps = [
      "2030-02-29T00:00:00.000Z",
      "2028-02-30T00:00:00.000Z",
      "2030-04-31T00:00:00.000Z",
      "2030-00-01T00:00:00.000Z",
      "2030-13-01T00:00:00.000Z",
      "2030-01-01T24:00:00.000Z",
      "2030-01-01T00:60:00.000Z",
      "2030-01-01T00:00:60.000Z",
    ];

    for (const expiresAt of invalidTimestamps) {
      expect(loginResponseSchema.safeParse({ contractVersion: 1, csrfToken: "csrf", expiresAt }).success).toBe(false);
    }
  });

  it("validates the exact onboarding projection and request shapes", () => {
    expect(onboardingDiscoverRequestSchema.parse({ repositoryPath: "C:/repo" })).toEqual({ repositoryPath: "C:/repo" });
    expect(onboardingApprovalRequestSchema.parse({ proposed: {
      defaultBranch: "main",
      workflow: "trunk",
      roles: ["developer"],
      guidelines: ["run tests"],
    } })).toMatchObject({ proposed: { defaultBranch: "main" } });
    expect(onboardingApproveRequestSchema.parse({})).toEqual({});
    expect(onboardingApproveRequestSchema.parse({ note: "approved" })).toEqual({ note: "approved" });
    expect(onboardingErrorCodeSchema.options).toEqual([
      "ONBOARDING_INVALID_REPOSITORY",
      "ONBOARDING_DISCOVERY_FAILED",
      "ONBOARDING_NOT_FOUND",
      "ONBOARDING_INVALID_PROPOSAL",
      "ONBOARDING_APPROVAL_PENDING",
      "ONBOARDING_NOT_PENDING",
      "ONBOARDING_NOT_APPROVED",
      "ONBOARDING_UNAVAILABLE",
    ]);
    expect(onboardingProjectionSchema.parse({
      contractVersion: 1,
      projectId: "project-1",
      status: "DRAFT",
      repository: { path: "C:/repo", remotes: [] },
      detected: {
        root: "C:/repo",
        defaultBranch: "main",
        remotes: [],
        packageManager: "pnpm",
        languageHints: ["typescript"],
        testCommands: ["pnpm test"],
        untrustedExistingConfig: false,
      },
      proposed: null,
      approval: null,
    })).toMatchObject({ contractVersion: 1, status: "DRAFT" });
  });

  it("keeps the server-owned repository and service signatures versioned", async () => {
    const raw = new Uint8Array(AUTH_TOKEN_BYTES) as RawSecretBytes;
    const session: AuthSessionRecord = {
      id: "session-1",
      absoluteExpiresAt: "2030-01-01T00:00:00.000Z",
      idleExpiresAt: "2030-01-01T00:00:00.000Z",
    };
    const localUser: LocalUserRecord = {
      id: 1,
      passwordHash: "phc",
      hashAlgorithm: "argon2id",
      hashParametersJson: "{\"memoryCost\":65536}",
    };
    const issued: IssuedSession = { session, rawSessionToken: raw, rawCsrfToken: raw };
    const rotated: RotatedCsrf = { session, rawCsrfToken: raw };
    const repository: AuthRepository = {
      hasLocalUser: async () => true,
      createLocalUser: async () => undefined,
      findLocalUser: async () => localUser,
      issueSession: async () => issued,
      authenticateAndTouch: async () => session,
      authenticateCsrfAndTouch: async () => session,
      authenticateAndRotateCsrf: async () => rotated,
      revokeByToken: async () => "REVOKED",
      logout: async (): Promise<LogoutResult> => "INVALID_SESSION",
      revokeExpired: async () => 0,
    };
    const hasher: PasswordHasher = {
      hash: async () => "phc",
      verify: async () => true,
    };
    const clock: AuthClock = { now: () => "2030-01-01T00:00:00.000Z" };
    const random: RandomTokenPort = { randomBytes: () => raw };
    const digest: DigestPort = { sha256Hex: () => "0".repeat(64) };
    const database = {} as Database;
    const service: AuthService = {
      login: async () => ({ ok: true, value: { ...issued, response: { contractVersion: 1, csrfToken: "csrf", expiresAt: session.absoluteExpiresAt } } }),
      restoreAndRotateCsrf: async () => ({ ok: true, value: { ...rotated, response: { contractVersion: 1, authenticated: true, csrfToken: "csrf", expiresAt: session.absoluteExpiresAt } } }),
      authenticateAndTouch: async () => ({ ok: true, value: session }),
      authenticateCsrfAndTouch: async () => ({ ok: true, value: session }),
      logout: async () => ({ ok: true, value: "REVOKED" }),
      hasLocalUser: async () => true,
    };
    const repositoryFactory: CreateAuthRepository = (_database, _hasher, _random, _digest) => repository;
    const serviceFactory: CreateAuthService = (_repository, _hasher, _clock) => service;

    expect(AUTH_PORT_CONTRACT_VERSION).toBe(2);
    await expect(repository.hasLocalUser()).resolves.toBe(true);
    await expect(service.hasLocalUser()).resolves.toBe(true);
    await expect(hasher.verify("phc", raw)).resolves.toBe(true);
    expect(clock.now()).toMatch(/Z$/);
    expect(random.randomBytes(AUTH_TOKEN_BYTES)).toHaveLength(AUTH_TOKEN_BYTES);
    expect(digest.sha256Hex(raw)).toHaveLength(64);
    expect(database).toBeDefined();
    expect(repositoryFactory(database, hasher, random, digest)).toBe(repository);
    expect(serviceFactory(repository, hasher, clock)).toBe(service);
  });

  it("keeps only the v2 atomic authorized-mutation seam in owned sources", () => {
    const forbidden = ["validate", "Csrf"].join("");
    const ownedSources = [
      new URL("../../../src/platform/security/auth-ports.ts", import.meta.url),
      new URL("../../../src/platform/security/auth-repository.ts", import.meta.url),
      new URL("../../../src/platform/security/auth-service.ts", import.meta.url),
      new URL("../../helpers/auth.ts", import.meta.url),
      new URL("./auth-onboarding-contract.test.ts", import.meta.url),
      new URL("./auth-service-red.test.ts", import.meta.url),
    ];
    for (const sourceUrl of ownedSources) expect(readFileSync(sourceUrl, "utf8")).not.toContain(forbidden);
  });

  it("keeps local password setup independent from SecretStore", () => {
    const securityFiles = ["auth-repository.ts", "auth-service.ts", "password-hasher.ts"];
    for (const file of securityFiles) {
      const source = readFileSync(new URL(`../../../src/platform/security/${file}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/SecretStore|secret-store/);
    }
  });
});
