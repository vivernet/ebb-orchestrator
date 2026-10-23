/**
 * Wire-контракт OAuth Device Flow (RFC 8628) (plan-24, Task 4).
 * Все запросы — через мок-шлюз; реальной сети нет.
 */

import { describe, expect, it } from "vitest";
import { DeviceCodeFlow, classifyDeviceTokenErrorBody } from "../../../../../src/modules/runtime/providers/auth/device-code-flow.js";
import { PROVIDER_DEVICE_CODE_SPECS, type OAuthDeviceCodeSpec } from "../../../../../src/modules/runtime/providers/auth/provider-auth-flow-specs.js";
import { createMockGateway, parseForm } from "./helpers.js";

const SPEC: OAuthDeviceCodeSpec = PROVIDER_DEVICE_CODE_SPECS.chatgpt!;

describe("device-code-flow: start", () => {
  it("отправляет device authorization запрос через шлюз и возвращает публичные данные", async () => {
    const m = createMockGateway();
    m.respond((params) => {
      expect(params.path).toContain("/api/accounts/deviceauth/usercode");
      const form = parseForm(params.body);
      expect(form.client_id).toBe(SPEC.clientId);
      expect(form.scope).toBeUndefined();
      expect(params.headers["content-type"]).toContain("application/x-www-form-urlencoded");
      return {
        status: 200,
        body: JSON.stringify({
          device_code: "device-code-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.openai.com/device",
          verification_uri_complete: "https://auth.openai.com/device?user_code=ABCD-EFGH",
          expires_in: 1800,
          interval: 8,
        }),
      };
    });
    const flow = new DeviceCodeFlow(m.gateway);
    const result = await flow.start(SPEC);
    expect(result.deviceCode).toBe("device-code-1");
    expect(result.userCode).toBe("ABCD-EFGH");
    expect(result.verificationUrl).toBe("https://auth.openai.com/device");
    expect(result.verificationUrlComplete).toContain("ABCD-EFGH");
    expect(result.intervalSeconds).toBe(8);
    expect(result.expiresInSeconds).toBe(1800);
    expect(m.calls).toHaveLength(1);
  });

  it("передаёт scope для провайдеров со scopes (githubcopilot)", async () => {
    const m = createMockGateway();
    m.respond((params) => {
      const form = parseForm(params.body);
      expect(form.scope).toBe("read:user");
      return { status: 200, body: JSON.stringify({ device_code: "d", user_code: "u", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) };
    });
    const flow = new DeviceCodeFlow(m.gateway);
    await flow.start(PROVIDER_DEVICE_CODE_SPECS.githubcopilot!);
  });

  it("бросает ошибку при не-2xx ответе device endpoint", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 400, body: JSON.stringify({ error: "invalid_client" }) }));
    await expect(new DeviceCodeFlow(m.gateway).start(SPEC)).rejects.toThrow("PROVIDER_AUTH_DEVICE_START_REJECTED");
  });

  it("бросает ошибку при транспортном сбое шлюза", async () => {
    const m = createMockGateway();
    m.respond(() => {
      throw new Error("PROVIDER_GATEWAY_TRANSPORT");
    });
    await expect(new DeviceCodeFlow(m.gateway).start(SPEC)).rejects.toThrow("PROVIDER_AUTH_DEVICE_START_GATEWAY_FAILED");
  });

  it("бросает ошибку при невалидном теле device ответа", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 200, body: JSON.stringify({}) }));
    await expect(new DeviceCodeFlow(m.gateway).start(SPEC)).rejects.toThrow("PROVIDER_AUTH_DEVICE_RESPONSE_INVALID");
  });
});

describe("device-code-flow: poll", () => {
  it("pending: authorization_pending не меняет статус", async () => {
    const m = createMockGateway();
    m.respond((params) => {
      const form = parseForm(params.body);
      expect(form.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(form.device_code).toBe("device-code-1");
      expect(form.client_id).toBe(SPEC.clientId);
      return { status: 400, body: JSON.stringify({ error: "authorization_pending" }) };
    });
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "device-code-1");
    expect(outcome).toEqual({ outcome: "pending" });
  });

  it("pending: slow_down трактуется как ожидание", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 400, body: JSON.stringify({ error: "slow_down" }) }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome.outcome).toBe("pending");
  });

  it("429 трактуется как pending (rate limit)", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 429, body: "" }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome.outcome).toBe("pending");
  });

  it("denied: access_denied", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 400, body: JSON.stringify({ error: "access_denied" }) }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome).toEqual({ outcome: "denied" });
  });

  it("expired: expired_token", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 400, body: JSON.stringify({ error: "expired_token" }) }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome).toEqual({ outcome: "expired" });
  });

  it("failed: invalid_grant классифицируется отдельно", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 400, body: JSON.stringify({ error: "invalid_grant" }) }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome).toEqual({ outcome: "failed", failureKind: "invalid-grant" });
  });

  it("failed: 5xx — транзиентный сбой token-exchange", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 500, body: "" }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome).toEqual({ outcome: "failed", failureKind: "token-exchange" });
  });

  it("failed: транспортный сбой шлюза", async () => {
    const m = createMockGateway();
    m.respond(() => {
      throw new Error("PROVIDER_GATEWAY_TIMEOUT");
    });
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome).toEqual({ outcome: "failed", failureKind: "gateway" });
  });

  it("complete: токены возвращаются только при успехе", async () => {
    const m = createMockGateway();
    m.respond(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
    }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome.outcome).toBe("complete");
    if (outcome.outcome === "complete") {
      expect(outcome.tokens.accessToken).toBe("at-1");
      expect(outcome.tokens.refreshToken).toBe("rt-1");
      expect(outcome.tokens.expiresInSeconds).toBe(3600);
    }
  });

  it("complete без refresh_token не заполняет refresh", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 200, body: JSON.stringify({ access_token: "at-1" }) }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome.outcome).toBe("complete");
    if (outcome.outcome === "complete") {
      expect(outcome.tokens.refreshToken).toBeUndefined();
    }
  });

  it("failed: невалидное тело успешного ответа", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 200, body: "not-json" }));
    const outcome = await new DeviceCodeFlow(m.gateway).poll(SPEC, "d");
    expect(outcome).toEqual({ outcome: "failed", failureKind: "token-exchange" });
  });
});

describe("device-code-flow: exchangeCopilotBearer", () => {
  it("обменивает OAuth access token на bearer-токен Copilot", async () => {
    const m = createMockGateway();
    m.respond((params) => {
      expect(params.headers.authorization).toBe("Bearer at-1");
      return { status: 200, body: JSON.stringify({ token: "copilot-bearer" }) };
    });
    const bearer = await new DeviceCodeFlow(m.gateway).exchangeCopilotBearer(PROVIDER_DEVICE_CODE_SPECS.githubcopilot!, "at-1");
    expect(bearer).toBe("copilot-bearer");
  });

  it("возвращает undefined при отсутствии tokenExchangeEndpoint", async () => {
    const m = createMockGateway();
    const bearer = await new DeviceCodeFlow(m.gateway).exchangeCopilotBearer(PROVIDER_DEVICE_CODE_SPECS.supergrok!, "at-1");
    expect(bearer).toBeUndefined();
    expect(m.calls).toHaveLength(0);
  });

  it("возвращает undefined при сбое обмена (без раскрытия значений)", async () => {
    const m = createMockGateway();
    m.respond(() => ({ status: 401, body: "" }));
    const bearer = await new DeviceCodeFlow(m.gateway).exchangeCopilotBearer(PROVIDER_DEVICE_CODE_SPECS.githubcopilot!, "at-1");
    expect(bearer).toBeUndefined();
  });
});

describe("device-code-flow: classifyDeviceTokenErrorBody", () => {
  it("маппит коды ошибок device-потока", () => {
    expect(classifyDeviceTokenErrorBody(JSON.stringify({ error: "authorization_pending" }), 400)).toEqual({ outcome: "pending" });
    expect(classifyDeviceTokenErrorBody(JSON.stringify({ error: "slow_down" }), 400)).toEqual({ outcome: "pending" });
    expect(classifyDeviceTokenErrorBody(JSON.stringify({ error: "access_denied" }), 400)).toEqual({ outcome: "denied" });
    expect(classifyDeviceTokenErrorBody(JSON.stringify({ error: "expired_token" }), 400)).toEqual({ outcome: "expired" });
    expect(classifyDeviceTokenErrorBody(JSON.stringify({ error: "invalid_grant" }), 400)).toEqual({ outcome: "failed", failureKind: "invalid-grant" });
    expect(classifyDeviceTokenErrorBody("junk", 400)).toEqual({ outcome: "failed", failureKind: "unknown" });
    expect(classifyDeviceTokenErrorBody("", 429)).toEqual({ outcome: "pending" });
    expect(classifyDeviceTokenErrorBody("", 503)).toEqual({ outcome: "failed", failureKind: "token-exchange" });
  });
});
