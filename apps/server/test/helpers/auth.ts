import type { AuthService } from "../../src/platform/security/auth-service.js";

export const TEST_SESSION_TOKEN = Buffer.alloc(32, 7).toString("base64url");
export const TEST_CSRF_TOKEN = Buffer.alloc(32, 8).toString("base64url");
export const TEST_COOKIE = `ebb_local_session=${TEST_SESSION_TOKEN}`;

export type AuthOperationCounts = {
  authenticateCsrfAndTouch: number;
  authenticateAndTouch: number;
  restoreAndRotateCsrf: number;
  logout: number;
};

export type TestAuthService = AuthService & {
  authOperationCounts: AuthOperationCounts;
  resetAuthOperationCounts(): void;
};

/** Узкий deterministic auth fake для route tests, не являющийся production authority. */
export function createTestAuthService(options: { strict?: boolean } = {}): TestAuthService {
  const strict = options.strict ?? true;
  const session = {
    id: "test-session",
    absoluteExpiresAt: "2030-01-02T00:00:00.000Z",
    idleExpiresAt: "2030-01-01T00:30:00.000Z",
  };
  const authOperationCounts: AuthOperationCounts = {
    authenticateCsrfAndTouch: 0,
    authenticateAndTouch: 0,
    restoreAndRotateCsrf: 0,
    logout: 0,
  };
  let authOperationClaimed: keyof AuthOperationCounts | null = null;
  const claimAuthOperation = (operation: keyof AuthOperationCounts): void => {
    if (strict && authOperationClaimed !== null) throw new Error("Повторная или альтернативная auth-операция в fake запрещена.");
    authOperationClaimed = operation;
    authOperationCounts[operation] += 1;
    // Один HTTP-запрос может пройти только одну auth seam; следующий запрос
    // получает новый claim после завершения текущего event-loop turn.
    queueMicrotask(() => { authOperationClaimed = null; });
  };
  return {
    authOperationCounts,
    resetAuthOperationCounts(): void {
      authOperationClaimed = null;
      for (const operation of Object.keys(authOperationCounts) as Array<keyof AuthOperationCounts>) authOperationCounts[operation] = 0;
    },
    login: async () => ({
      ok: true as const,
      value: {
        session,
        rawSessionToken: Buffer.alloc(32, 7),
        rawCsrfToken: Buffer.alloc(32, 8),
        response: { contractVersion: 1 as const, csrfToken: TEST_CSRF_TOKEN, expiresAt: session.absoluteExpiresAt },
      },
    }),
    restoreAndRotateCsrf: async (rawSessionToken) => {
      claimAuthOperation("restoreAndRotateCsrf");
      void rawSessionToken;
      return {
        ok: true as const,
        value: {
          session,
          rawCsrfToken: Buffer.alloc(32, 8),
          response: { contractVersion: 1 as const, authenticated: true as const, csrfToken: TEST_CSRF_TOKEN, expiresAt: session.absoluteExpiresAt },
        },
      };
    },
    authenticateAndTouch: async (rawSessionToken) => {
      claimAuthOperation("authenticateAndTouch");
      void rawSessionToken;
      return { ok: true as const, value: session };
    },
    authenticateCsrfAndTouch: async (rawSessionToken, rawCsrfToken) => {
      claimAuthOperation("authenticateCsrfAndTouch");
      void rawSessionToken;
      void rawCsrfToken;
      return { ok: true as const, value: session };
    },
    logout: async (rawSessionToken, rawCsrfToken) => {
      claimAuthOperation("logout");
      void rawSessionToken;
      void rawCsrfToken;
      return { ok: true as const, value: "REVOKED" as const };
    },
    hasLocalUser: async () => true,
  };
}

export function testAuthHeaders(): Record<string, string> {
  return { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN };
}
