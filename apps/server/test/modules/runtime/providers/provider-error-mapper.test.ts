/**
 * Тесты маппинга ошибок провайдеров (plan-24, Task 3).
 */

import { describe, expect, it } from "vitest";
import {
  ProviderRuntimeError,
  classifyHttpError,
  classifyHttpStatus,
  classifyParseError,
  classifyStreamProtocolError,
  classifyTransportError,
} from "../../../../src/modules/runtime/providers/provider-error-mapper.js";
import { ProviderGatewayError } from "../../../../src/modules/runtime/providers/provider-network-gateway.js";
import { PROVIDER_ERROR_SPECS } from "../../../../src/modules/runtime/provider-errors.js";

describe("provider-error-mapper: HTTP-статусы", () => {
  it("401/403 → AUTH_INVALID_CREDENTIALS", () => {
    expect(classifyHttpStatus(401)?.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(classifyHttpStatus(403)?.code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("429 → CAPACITY_RATE_LIMIT_EXCEEDED", () => {
    expect(classifyHttpStatus(429)?.code).toBe("CAPACITY_RATE_LIMIT_EXCEEDED");
  });

  it("400/413 → REQUEST_CONTEXT_WINDOW_EXCEEDED (дефолт)", () => {
    expect(classifyHttpStatus(400)?.code).toBe("REQUEST_CONTEXT_WINDOW_EXCEEDED");
  });

  it("500+ → PROVIDER_API_ERROR", () => {
    expect(classifyHttpStatus(500)?.code).toBe("PROVIDER_API_ERROR");
    expect(classifyHttpStatus(503)?.code).toBe("PROVIDER_API_ERROR");
  });

  it("подсказки тела имеют приоритет над статусом", () => {
    expect(classifyHttpError(500, { quota: true }).code).toBe("QUOTA_INSUFFICIENT");
    expect(classifyHttpError(500, { auth: true }).code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(classifyHttpError(400, { rateLimit: true }).code).toBe("CAPACITY_RATE_LIMIT_EXCEEDED");
    expect(classifyHttpError(200).code).toBe("PROVIDER_API_ERROR");
  });
});

describe("provider-error-mapper: транспортные ошибки", () => {
  it("mapping кодов шлюза", () => {
    expect(classifyTransportError(new ProviderGatewayError("forbidden-destination")).code).toBe("NETWORK_FORBIDDEN_DESTINATION");
    expect(classifyTransportError(new ProviderGatewayError("dns-resolution-failed")).code).toBe("NETWORK_DNS_RESOLUTION_FAILED");
    expect(classifyTransportError(new ProviderGatewayError("timeout")).code).toBe("NETWORK_REQUEST_TIMEOUT");
    expect(classifyTransportError(new ProviderGatewayError("response-too-large")).code).toBe("NETWORK_RESPONSE_TOO_LARGE");
    expect(classifyTransportError(new ProviderGatewayError("redirect-policy")).code).toBe("NETWORK_FORBIDDEN_DESTINATION");
  });

  it("mapping errno-кодов", () => {
    const refused = new Error("connect ECONNREFUSED 1.2.3.4:443");
    (refused as { code?: string }).code = "ECONNREFUSED";
    expect(classifyTransportError(refused).code).toBe("NETWORK_CONNECTION_REFUSED");

    const timedOut = new Error("connect ETIMEDOUT");
    (timedOut as { code?: string }).code = "ETIMEDOUT";
    expect(classifyTransportError(timedOut).code).toBe("NETWORK_REQUEST_TIMEOUT");

    const dns = new Error("getaddrinfo ENOTFOUND example.com");
    (dns as { code?: string }).code = "ENOTFOUND";
    expect(classifyTransportError(dns).code).toBe("NETWORK_DNS_RESOLUTION_FAILED");
  });
});

describe("provider-error-mapper: ProviderRuntimeError", () => {
  it("классификация без текстов ошибок провайдера", () => {
    const error = new ProviderRuntimeError("AUTH_INVALID_CREDENTIALS");
    expect(error.classification.id).toBe("E1001");
    expect(error.classification.retryable).toBe(false);
    expect(error.classification.attribution).toBe("user");
    expect(error.message).toBe("E1001:AUTH_INVALID_CREDENTIALS");
  });

  it("все коды таксономии имеют спецификацию", () => {
    for (const code of Object.keys(PROVIDER_ERROR_SPECS)) {
      expect(PROVIDER_ERROR_SPECS[code as keyof typeof PROVIDER_ERROR_SPECS]).toBeDefined();
    }
  });

  it("новые коды консистентны с категориями", () => {
    expect(new ProviderRuntimeError("AUTH_DEVICE_FLOW_TOKEN_MISSING").classification.category).toBe("auth");
    expect(new ProviderRuntimeError("REQUEST_TOOL_VALIDATION_FAILED").classification.category).toBe("request");
    expect(new ProviderRuntimeError("NETWORK_FORBIDDEN_DESTINATION").classification.severity).toBe("critical");
    expect(new ProviderRuntimeError("STREAM_PROTOCOL_ERROR").classification.category).toBe("stream");
    expect(new ProviderRuntimeError("PROVIDER_CLOUD_IDENTITY_CREDENTIALS_UNAVAILABLE").classification.category).toBe("config");
  });
});

describe("provider-error-mapper: парсеры", () => {
  it("stream/parse классификации", () => {
    expect(classifyStreamProtocolError().code).toBe("STREAM_PROTOCOL_ERROR");
    expect(classifyParseError().code).toBe("PROVIDER_RESPONSE_PARSE_ERROR");
  });
});
