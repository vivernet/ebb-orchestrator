/**
 * SSRF-контракт сетевого шлюза провайдеров (plan-24, Task 3).
 * Все тесты используют моки lookup/connect — реальной сети нет.
 */

import { describe, expect, it } from "vitest";
import {
  ProviderGatewayError,
  ProviderNetworkGateway,
  checkForbiddenIp,
  parseIp,
  redactProviderHeaders,
  redactProviderUrl,
  validateProviderUrl,
  type GatewayConnectFn,
  type GatewayConnectParams,
  type ProviderHttpResponse,
} from "../../../../src/modules/runtime/providers/provider-network-gateway.js";

function fakeConnect(
  handler: (params: GatewayConnectParams) => { status: number; headers?: Record<string, string>; body?: string } | Promise<{ status: number; headers?: Record<string, string>; body?: string }>,
): { connect: GatewayConnectFn; calls: GatewayConnectParams[] } {
  const calls: GatewayConnectParams[] = [];
  const connect: GatewayConnectFn = async (params) => {
    calls.push(params);
    const result = await handler(params);
    return { status: result.status, headers: result.headers ?? {}, body: result.body ?? "" };
  };
  return { connect, calls };
}

function okConnect(body = "{}"): { connect: GatewayConnectFn; calls: GatewayConnectParams[] } {
  return fakeConnect(() => ({ status: 200, headers: { "content-type": "application/json" }, body }));
}

const PUBLIC_IP = "93.184.216.34";

/** lookup-мок: host → адреса. */
function lookupFor(map: Record<string, string[]>): (host: string) => Promise<string[]> {
  return async (host) => map[host] ?? [];
}

describe("provider-network-gateway: валидация URL", () => {
  it("отклоняет несетевые scheme", () => {
    expect(() => validateProviderUrl("ftp://example.com/x")).toThrow(ProviderGatewayError);
    expect(() => validateProviderUrl("file:///etc/passwd")).toThrow(ProviderGatewayError);
  });

  it("отклоняет URL с credentials (userinfo)", () => {
    expect(() => validateProviderUrl("https://user:password@example.com/v1/chat")).toThrow(ProviderGatewayError);
    expect(() => validateProviderUrl("https://token@example.com/v1")).toThrow(ProviderGatewayError);
  });

  it("отклоняет пустой host и невалидный port", () => {
    expect(() => validateProviderUrl("https:///v1")).toThrow(ProviderGatewayError);
    expect(() => validateProviderUrl("https://example.com:99999/v1")).toThrow(ProviderGatewayError);
    expect(() => validateProviderUrl("https://example.com:0/v1")).toThrow(ProviderGatewayError);
  });

  it("отклоняет управляющие символы в URL", () => {
    expect(() => validateProviderUrl("https://example.com/\u0000")).toThrow(ProviderGatewayError);
  });
});

describe("provider-network-gateway: запрещённые диапазоны", () => {
  const gateway = new ProviderNetworkGateway({}, { lookup: lookupFor({}), connect: okConnect().connect });

  const urlFor = (ip: string): string => (ip.includes(":") ? `https://[${ip}]/v1` : `https://${ip}/v1`);

  it.each([
    ["0.0.0.0", "unspecified-ipv4"],
    ["127.0.0.1", "loopback-127"],
    ["10.0.0.1", "private-10"],
    ["100.64.0.1", "cgnat-100.64"],
    ["100.100.100.200", "cloud-metadata"],
    ["169.254.169.254", "cloud-metadata"],
    ["172.16.0.1", "private-172.16"],
    ["192.168.1.1", "private-192.168"],
    ["198.18.0.1", "benchmarking-198.18"],
    ["203.0.113.5", "test-net-3"],
    ["224.0.0.1", "multicast-224"],
    ["240.0.0.1", "reserved-240"],
    ["::1", "loopback-ipv6"],
    ["fe80::1", "link-local-ipv6"],
    ["fc00::1", "ula-fc00"],
    ["ff02::1", "multicast-ipv6"],
    ["2001:db8::1", "documentation-2001:db8"],
  ])("IP %s запрещён (%s)", async (ip, label) => {
    const parsed = parseIp(ip);
    expect(parsed).not.toBeNull();
    const check = checkForbiddenIp(parsed!, false);
    expect(check.forbidden).toBe(true);
    expect(check.reason).toBe(label);
    await expect(
      gateway.execute({ method: "POST", url: urlFor(ip), headers: {} }),
    ).rejects.toThrow(/FORBIDDEN-DESTINATION/);
  });

  it("блокирует адреса cloud metadata даже при allowPrivateDestination", async () => {
    await expect(
      gateway.execute({
        method: "POST",
        url: "https://169.254.169.254/latest/meta-data",
        headers: {},
        allowPrivateDestination: true,
      }),
    ).rejects.toThrow(/FORBIDDEN-DESTINATION/);
    await expect(
      gateway.execute({
        method: "POST",
        url: "https://[fd00:ec2::254]/latest/meta-data",
        headers: {},
        allowPrivateDestination: true,
      }),
    ).rejects.toThrow(/FORBIDDEN-DESTINATION/);
    // Alibaba Cloud IMDS (100.100.100.200) блокируется всегда
    await expect(
      gateway.execute({
        method: "POST",
        url: "https://100.100.100.200/latest/meta-data",
        headers: {},
        allowPrivateDestination: true,
      }),
    ).rejects.toThrow(/FORBIDDEN-DESTINATION/);
  });

  it("частные диапазоны разрешаются только при allowPrivateDestination", async () => {
    const { connect, calls } = okConnect();
    const gw = new ProviderNetworkGateway({}, {
      lookup: lookupFor({ "ollama.local": ["127.0.0.1"] }),
      connect,
    });
    await expect(
      gw.execute({ method: "POST", url: "http://ollama.local:11434/api/chat", headers: {} }),
    ).rejects.toThrow(/FORBIDDEN-DESTINATION/);
    const response = await gw.execute({
      method: "POST",
      url: "http://ollama.local:11434/api/chat",
      headers: {},
      allowPrivateDestination: true,
    });
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ ip: "127.0.0.1", port: 11434, secure: false });
    expect(calls[0]!.headers.host).toBe("ollama.local:11434");
  });
});

describe("provider-network-gateway: DNS-резолвинг и закрепление", () => {
  it("резолвит один раз и закрепляет назначение (не перe-resolve)", async () => {
    let lookups = 0;
    const lookup = async (host: string): Promise<string[]> => {
      lookups += 1;
      expect(host).toBe("api.example.com");
      return [PUBLIC_IP];
    };
    const { connect, calls } = okConnect(JSON.stringify({ ok: true }));
    const gw = new ProviderNetworkGateway({}, { lookup, connect });
    await gw.execute({ method: "POST", url: `https://api.example.com/v1/chat`, headers: {} });
    expect(lookups).toBe(1);
    expect(calls[0]).toMatchObject({ ip: PUBLIC_IP, port: 443, secure: true });
    expect(calls[0]!.headers.host).toBe("api.example.com");
  });

  it("ДНС-ребайндинг: враждебный вторичный адрес не используется (pinning)", async () => {
    const lookup = async (host: string): Promise<string[]> => {
      if (host === "safe.example.com") return [PUBLIC_IP];
      return ["127.0.0.1"]; // последующие запросы — враждебные
    };
    const { connect, calls } = okConnect();
    const gw = new ProviderNetworkGateway({}, { lookup, connect });
    await gw.execute({ method: "POST", url: "https://safe.example.com/v1/chat", headers: {} });
    expect(calls[0]!.ip).toBe(PUBLIC_IP);
  });

  it("при ошибке DNS — типизированная ошибка", async () => {
    const gw = new ProviderNetworkGateway({}, {
      lookup: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      connect: okConnect().connect,
    });
    await expect(
      gw.execute({ method: "POST", url: "https://nope.invalid/v1", headers: {} }),
    ).rejects.toThrow(/DNS-RESOLUTION-FAILED/);
  });

  it("отклоняет DNS-ответ без адресов", async () => {
    const gw = new ProviderNetworkGateway({}, { lookup: async () => [], connect: okConnect().connect });
    await expect(
      gw.execute({ method: "POST", url: "https://empty.example.com/v1", headers: {} }),
    ).rejects.toThrow(/DNS-RESOLUTION-FAILED/);
  });

  it("литеральный IP не резолвится через DNS", async () => {
    let lookups = 0;
    const gw = new ProviderNetworkGateway({}, {
      lookup: async () => {
        lookups += 1;
        return [PUBLIC_IP];
      },
      connect: okConnect().connect,
    });
    await gw.execute({ method: "POST", url: `https://${PUBLIC_IP}/v1`, headers: {} });
    expect(lookups).toBe(0);
  });
});

describe("provider-network-gateway: redirect-политика", () => {
  it("по умолчанию redirects не выполняются", async () => {
    const { connect, calls } = fakeConnect(() => ({
      status: 302,
      headers: { location: "https://other.example.com/v2" },
    }));
    const gw = new ProviderNetworkGateway({}, { lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }), connect });
    const response = await gw.execute({ method: "POST", url: "https://a.example.com/v1", headers: {} });
    expect(response.status).toBe(302);
    expect(response.redirected).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("разрешённый redirect повторно валидируется (кросс-хост)", async () => {
    let hop = 0;
    const { connect, calls } = fakeConnect((_params) => {
      hop += 1;
      if (hop === 1) return { status: 302, headers: { location: "https://b.example.com/v2" } };
      return { status: 200, body: "{}" };
    });
    const gw = new ProviderNetworkGateway({}, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP], "b.example.com": [PUBLIC_IP] }),
      connect,
    });
    const response = await gw.execute({
      method: "POST",
      url: "https://a.example.com/v1",
      headers: {},
      followRedirects: true,
    });
    expect(response.status).toBe(200);
    expect(response.redirected).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]!.headers.host).toBe("b.example.com");
  });

  it("redirect на запрещённый адрес блокируется", async () => {
    const { connect } = fakeConnect(() => ({
      status: 302,
      headers: { location: "https://127.0.0.1/steal" },
    }));
    const gw = new ProviderNetworkGateway({}, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }),
      connect,
    });
    await expect(
      gw.execute({ method: "POST", url: "https://a.example.com/v1", headers: {}, followRedirects: true }),
    ).rejects.toThrow(/FORBIDDEN-DESTINATION/);
  });

  it("запрещён downgrade https→http", async () => {
    const { connect } = fakeConnect(() => ({
      status: 302,
      headers: { location: "http://b.example.com/v2" },
    }));
    const gw = new ProviderNetworkGateway({}, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }),
      connect,
    });
    await expect(
      gw.execute({ method: "POST", url: "https://a.example.com/v1", headers: {}, followRedirects: true }),
    ).rejects.toThrow(/REDIRECT-POLICY/);
  });

  it("лимит числа redirect-хопов", async () => {
    const { connect } = fakeConnect(() => ({
      status: 302,
      headers: { location: "https://a.example.com/next" },
    }));
    const gw = new ProviderNetworkGateway({ maxRedirects: 2 }, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }),
      connect,
    });
    await expect(
      gw.execute({ method: "POST", url: "https://a.example.com/v1", headers: {}, followRedirects: true }),
    ).rejects.toThrow(/REDIRECT-POLICY/);
  });

  it("cross-host redirect снимает секретные заголовки (Authorization/API-key/cookie)", async () => {
    let hop = 0;
    const { connect, calls } = fakeConnect((_params) => {
      hop += 1;
      if (hop === 1) return { status: 302, headers: { location: "https://b.example.com/v2" } };
      return { status: 200, body: "{}" };
    });
    const gw = new ProviderNetworkGateway({}, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP], "b.example.com": [PUBLIC_IP] }),
      connect,
    });
    await gw.execute({
      method: "POST",
      url: "https://a.example.com/v1",
      headers: {
        authorization: "Bearer sk-secret",
        "x-api-key": "abc123",
        cookie: "session=secret",
        "content-type": "application/json",
        "x-custom": "public",
      },
      followRedirects: true,
    });
    expect(calls.length).toBe(2);
    const second = calls[1]!.headers;
    expect(second.authorization).toBeUndefined();
    expect(second["x-api-key"]).toBeUndefined();
    expect(second.cookie).toBeUndefined();
    expect(second["content-type"]).toBe("application/json");
    expect(second["x-custom"]).toBe("public");
  });

  it("same-host redirect сохраняет секретные заголовки", async () => {
    let hop = 0;
    const { connect, calls } = fakeConnect((_params) => {
      hop += 1;
      if (hop === 1) return { status: 302, headers: { location: "https://a.example.com/v2" } };
      return { status: 200, body: "{}" };
    });
    const gw = new ProviderNetworkGateway({}, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }),
      connect,
    });
    await gw.execute({
      method: "POST",
      url: "https://a.example.com/v1",
      headers: {
        authorization: "Bearer sk-secret",
        "x-api-key": "abc123",
        "content-type": "application/json",
      },
      followRedirects: true,
    });
    expect(calls.length).toBe(2);
    expect(calls[1]!.headers.authorization).toBe("Bearer sk-secret");
    expect(calls[1]!.headers["x-api-key"]).toBe("abc123");
    expect(calls[1]!.headers["content-type"]).toBe("application/json");
  });
});

describe("provider-network-gateway: лимиты и таймауты", () => {
  it("отклоняет тело ответа больше лимита", async () => {
    const bigBody = "x".repeat(1024);
    const { connect } = fakeConnect(() => ({ status: 200, body: bigBody }));
    const gw = new ProviderNetworkGateway({ maxResponseBytes: 512 }, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }),
      connect,
    });
    await expect(
      gw.execute({ method: "POST", url: "https://a.example.com/v1", headers: {} }),
    ).rejects.toThrow(/RESPONSE-TOO-LARGE/);
  });

  it("таймаут запроса", async () => {
    const { connect } = fakeConnect(
      (params) => new Promise<{ status: number }>((_resolve, reject) => {
        params.signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
      }),
    );
    const gw = new ProviderNetworkGateway({ requestTimeoutMs: 50 }, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }),
      connect,
    });
    await expect(
      gw.execute({ method: "POST", url: "https://a.example.com/v1", headers: {} }),
    ).rejects.toThrow(/TIMEOUT/);
  });
});

describe("provider-network-gateway: редэктирование", () => {
  it("redactProviderHeaders маскирует секретные заголовки", () => {
    const redacted = redactProviderHeaders({
      authorization: "Bearer sk-secret",
      "x-api-key": "abc123",
      "content-type": "application/json",
      "x-custom": "public",
    });
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted["x-api-key"]).toBe("[REDACTED]");
    expect(redacted["content-type"]).toBe("application/json");
    expect(redacted["x-custom"]).toBe("public");
  });

  it("redactProviderUrl маскирует userinfo и секретные query-параметры", () => {
    expect(redactProviderUrl("https://user:pass@example.com/v1")).not.toContain("pass");
    const redacted = redactProviderUrl("https://example.com/v1?api_key=secret&model=gpt");
    expect(redacted).toContain("REDACTED");
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain("model=gpt");
  });
});

describe("provider-network-gateway: общий контракт", () => {
  it("возвращает статус, заголовки, тело и длительность", async () => {
    const { connect } = fakeConnect(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    }));
    const gw = new ProviderNetworkGateway({}, {
      lookup: lookupFor({ "a.example.com": [PUBLIC_IP] }),
      connect,
    });
    const response: ProviderHttpResponse = await gw.execute({
      method: "POST",
      url: "https://a.example.com/v1/chat",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe(JSON.stringify({ ok: true }));
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.finalUrl).toBe("https://a.example.com/v1/chat");
  });
});
