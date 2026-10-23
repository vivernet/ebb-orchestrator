/**
 * Wire-контракт OAuth Authorization Code + PKCE (plan-24, Task 4).
 * Все запросы — через мок-шлюз; реальной сети нет.
 */

import { describe, expect, it } from "vitest";
import {
  PkceFlow,
  computePkceChallenge,
  generatePkceState,
  generatePkceVerifier,
  isAllowedCallbackOrigin,
  originOfUrl,
} from "../../../../../src/modules/runtime/providers/auth/oauth-pkce-flow.js";
import type { OAuthPkceSpec } from "../../../../../src/modules/runtime/providers/auth/provider-auth-flow-specs.js";
import { createMockGateway, parseForm } from "./helpers.js";

const SPEC: OAuthPkceSpec = {
  kind: "oauth-pkce",
  clientId: "pkce-client-1",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  scopes: ["read", "write"],
  redirectUri: "http://127.0.0.1:3000/api/v1/providers/auth/callback",
};

describe("oauth-pkce-flow: генерация verifier/challenge/state", () => {
  it("verifier — base64url 43 символа; challenge — S256(verifier)", () => {
    const verifier = generatePkceVerifier(() => Buffer.alloc(32, 3));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const challenge = computePkceChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(computePkceChallenge(verifier));
    expect(challenge).not.toBe(computePkceChallenge(generatePkceVerifier(() => Buffer.alloc(32, 4))));
  });

  it("state — случайный base64url", () => {
    const a = generatePkceState(() => Buffer.alloc(16, 1));
    const b = generatePkceState(() => Buffer.alloc(16, 2));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("originOfUrl извлекает точный origin", () => {
    expect(originOfUrl("http://127.0.0.1:3000/api/v1/cb")).toBe("http://127.0.0.1:3000");
    expect(originOfUrl("https://auth.example.com/token")).toBe("https://auth.example.com");
    expect(originOfUrl("not-a-url")).toBeUndefined();
  });

  it("isAllowedCallbackOrigin требует точного равенства", () => {
    expect(isAllowedCallbackOrigin("http://127.0.0.1:3000", "http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedCallbackOrigin("https://127.0.0.1:3000", "http://127.0.0.1:3000")).toBe(false);
    expect(isAllowedCallbackOrigin("http://127.0.0.1:3001", "http://127.0.0.1:3000")).toBe(false);
    expect(isAllowedCallbackOrigin("http://127.0.0.1:3000.evil.com", "http://127.0.0.1:3000")).toBe(false);
  });
});

describe("oauth-pkce-flow: start", () => {
  it("строит URL авторизации с PKCE-параметрами", () => {
    const flow = new PkceFlow(createMockGateway().gateway);
    const started = flow.start(SPEC, { random: (bytes) => Buffer.alloc(bytes, 5) });
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("pkce-client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(SPEC.redirectUri);
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("code_challenge")).toBe(started.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.challenge).toBe(computePkceChallenge(started.verifier));
  });
});

describe("oauth-pkce-flow: complete", () => {
  const tokenBody = JSON.stringify({ access_token: "at-pkce", refresh_token: "rt-pkce", expires_in: 3600 });

  it("успешный обмен с верным origin/state", async () => {
    const m = createMockGateway();
    m.respond((params) => {
      const form = parseForm(params.body);
      expect(form.grant_type).toBe("authorization_code");
      expect(form.code).toBe("code-1");
      expect(form.client_id).toBe("pkce-client-1");
      expect(form.redirect_uri).toBe(SPEC.redirectUri);
      expect(form.code_verifier).toBe("verifier-secret");
      return { status: 200, body: tokenBody };
    });
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { code: "code-1", state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.tokens.accessToken).toBe("at-pkce");
      expect(outcome.tokens.refreshToken).toBe("rt-pkce");
    }
  });

  it("callback-origin mismatch отклоняется до обмена", async () => {
    const m = createMockGateway();
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { code: "code-1", state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "https://evil.example.com",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "callback-origin" });
    expect(m.calls).toHaveLength(0);
  });

  it("state mismatch отклоняется", async () => {
    const m = createMockGateway();
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { code: "code-1", state: "wrong-state" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "state-mismatch" });
    expect(m.calls).toHaveLength(0);
  });

  it("отсутствие code отклоняется", async () => {
    const m = createMockGateway();
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "code-missing" });
  });

  it("error от провайдера (user denied) классифицируется", async () => {
    const m = createMockGateway();
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { error: "access_denied", state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "user-denied" });
  });

  it("5xx token endpoint → token-exchange failure", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 503, body: "" }));
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { code: "code-1", state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "token-exchange" });
  });

  it("400 token endpoint (bad grant) → token-exchange failure", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 400, body: JSON.stringify({ error: "invalid_grant" }) }));
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { code: "code-1", state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "token-exchange" });
  });

  it("транспортный сбой → gateway failure", async () => {
    const m = createMockGateway();
    m.respond(() => {
      throw new Error("PROVIDER_GATEWAY_TRANSPORT");
    });
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { code: "code-1", state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "gateway" });
  });

  it("невалидное тело успешного ответа → token-exchange failure", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 200, body: "junk" }));
    const flow = new PkceFlow(m.gateway);
    const outcome = await flow.complete(
      SPEC,
      { code: "code-1", state: "state-1" },
      originOfUrl(SPEC.redirectUri)!,
      "http://127.0.0.1:3000",
      "state-1",
      "verifier-secret",
    );
    expect(outcome).toEqual({ ok: false, failureKind: "token-exchange" });
  });
});
