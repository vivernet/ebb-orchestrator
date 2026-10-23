/**
 * Сетевой egress-шлюз провайдеров (plan-24, Task 3).
 *
 * Единственная точка исходящего HTTP для всех provider-запросов плана
 * (модельные запросы Task 3, auth/device/refresh/revoke Task 4).
 *
 * Безопасность:
 *  - валидация scheme/host/port; URL с credentials (userinfo) отклоняются;
 *  - DNS-резолвинг выполняется один раз на запрос и закрепляется (pinning);
 *    последующие redirect-хопы проходят полную повторную валидацию;
 *  - запрещённые диапазоны адресов (loopback, private, link-local, metadata,
 *    multicast, reserved, CGNAT, ...) отклоняются, если только провайдер не
 *    объявляет поддержку локального endpoint И пользователь явно не указал
 *    точный локальный/частный endpoint (`allowLocalEndpoint`). Адреса cloud
 *    metadata (169.254.169.254 и др.) блокируются всегда;
 *  - redirects выключены по умолчанию; каждый разрешённый redirect повторно
 *    валидируется (включая повторный DNS-резолвинг), downgrade https→http
 *    запрещён;
 *  - тело запроса/ответа ограничено по размеру, всё ограничено по времени;
 *  - заголовки/URL для диагностики редэктируются (`redactProvider*`),
 *    значения секретов наружу не возвращаются.
 *
 * Сетевые операции выполняются через внедряемые `lookup`/`connect`
 * (в тестах — моки, без реальной сети).
 */

import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { safeRedact } from "../../../platform/security/redact.js";

/** Версия IP-адреса. */
export type IpVersion = 4 | 6;

/** Разобранный IP-адрес. */
export interface ParsedIp {
  readonly version: IpVersion;
  /** 4 байта для IPv4, 16 для IPv6 (сетевой порядок). */
  readonly bytes: Uint8Array;
  readonly text: string;
}

/** Диапазон IP-адресов. */
export interface IpRange {
  readonly label: string;
  readonly version: IpVersion;
  readonly base: Uint8Array;
  readonly mask: Uint8Array;
}

/** Разбирает IPv4-адрес в 4 байта. */
function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^(0|[1-9][0-9]{0,2})$/u.test(parts[i]!)) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** Разбирает IPv6-адрес (включая встроенный IPv4 и `::`-сжатие) в 16 байт. */
function parseIpv6(text: string): Uint8Array | null {
  const hasCompress = text.includes("::");
  let head: string[];
  let tail: string[] = [];
  if (hasCompress) {
    const parts = text.split("::");
    const left = parts[0] ?? "";
    const right = parts[1] ?? "";
    head = left === "" ? [] : left.split(":");
    if (right !== "") tail = right.split(":");
    if (head.length + tail.length > 7) return null;
  } else {
    head = text.split(":");
    if (head.length !== 8) return null;
  }

  const bytes = new Uint8Array(16);
  let cursor = 0;
  const writeGroup = (group: string, at: number): boolean => {
    const embeddedV4 = group.includes(".");
    if (embeddedV4) {
      if (at !== 6) return false;
      const v4 = parseIpv4(group);
      if (!v4) return false;
      bytes.set(v4, 12);
      return true;
    }
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return false;
    const value = Number.parseInt(group, 16);
    bytes[at] = (value >> 8) & 0xff;
    bytes[at + 1] = value & 0xff;
    return true;
  };

  for (const group of head) {
    if (cursor >= 16 || !writeGroup(group, cursor)) return null;
    cursor += 2;
  }
  if (hasCompress) {
    const tailStart = 16 - tail.length * 2;
    cursor = tailStart;
    for (const group of tail) {
      if (cursor >= 16 || !writeGroup(group, cursor)) return null;
      cursor += 2;
    }
  }
  return bytes;
}

/** Разбирает IP-строку (IPv4/IPv6) в `ParsedIp`. */
export function parseIp(text: string): ParsedIp | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 45) return null;
  const v4 = parseIpv4(trimmed);
  if (v4) return { version: 4, bytes: v4, text: trimmed };
  const v6 = parseIpv6(trimmed);
  if (v6) return { version: 6, bytes: v6, text: trimmed };
  return null;
}

const CONTROL_CHARACTER_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(32)}${String.fromCharCode(127)}]|%[0-9a-f]{2}`,
  "iu",
);

/** Проверяет URL на управляющие символы и percent-кодированные управляющие байты. */
function hasControlCharacters(rawUrl: string): boolean {
  return CONTROL_CHARACTER_RE.test(rawUrl);
}

function maskBytes(prefix: number, version: IpVersion): Uint8Array {
  const total = version === 4 ? 4 : 16;
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    mask[i] = bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff;
  }
  return mask;
}

function range(label: string, spec: string): IpRange {
  const [addr, prefixText] = spec.split("/");
  const ip = parseIp(addr!);
  if (!ip) throw new Error(`Invalid IP range spec: ${spec}`);
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > (ip.version === 4 ? 32 : 128)) {
    throw new Error(`Invalid IP range prefix: ${spec}`);
  }
  return { label, version: ip.version, base: ip.bytes, mask: maskBytes(prefix, ip.version) };
}

function isIpInRange(ip: ParsedIp, ipRange: IpRange): boolean {
  if (ip.version !== ipRange.version) return false;
  for (let i = 0; i < ip.bytes.length; i += 1) {
    if ((ip.bytes[i]! & ipRange.mask[i]!) !== (ipRange.base[i]! & ipRange.mask[i]!)) return false;
  }
  return true;
}

/** Запрещённые диапазоны адресов (SSRF-защита). */
export const FORBIDDEN_IP_RANGES: readonly IpRange[] = Object.freeze([
  range("unspecified-ipv4", "0.0.0.0/8"),
  range("private-10", "10.0.0.0/8"),
  range("cgnat-100.64", "100.64.0.0/10"),
  range("loopback-127", "127.0.0.0/8"),
  range("link-local-169.254", "169.254.0.0/16"),
  range("private-172.16", "172.16.0.0/12"),
  range("private-192.168", "192.168.0.0/16"),
  range("ietf-assign-192.0.0", "192.0.0.0/24"),
  range("test-net-1", "192.0.2.0/24"),
  range("benchmarking-198.18", "198.18.0.0/15"),
  range("test-net-2", "198.51.100.0/24"),
  range("test-net-3", "203.0.113.0/24"),
  range("multicast-224", "224.0.0.0/4"),
  range("reserved-240", "240.0.0.0/4"),
  range("unspecified-ipv6", "::/128"),
  range("loopback-ipv6", "::1/128"),
  range("ula-fc00", "fc00::/7"),
  range("link-local-ipv6", "fe80::/10"),
  range("multicast-ipv6", "ff00::/8"),
  range("documentation-2001:db8", "2001:db8::/32"),
  range("orchid-2001:10", "2001:10::/28"),
  range("nat64-64:ff9b", "64:ff9b::/96"),
]);

/** Адреса cloud metadata, блокируемые всегда (даже при allowLocalEndpoint). */
export const METADATA_IP_ADDRESSES: readonly string[] = Object.freeze([
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "169.254.170.2", // AWS ECS container metadata
  "100.100.100.200", // Alibaba Cloud IMDS
  "fd00:ec2::254", // AWS IMDSv2 (IPv6)
]);

/** Результат проверки адреса. */
export interface ForbiddenCheck {
  readonly forbidden: boolean;
  readonly reason?: string;
}

/**
 * Проверяет IP-адрес на принадлежность запрещённым диапазонам.
 * `allowPrivate` разрешает только частные/локальные диапазоны; метаданные
 * и прочие служебные адреса блокируются всегда.
 */
export function checkForbiddenIp(ip: ParsedIp, allowPrivate = false): ForbiddenCheck {
  if (METADATA_IP_ADDRESSES.includes(ip.text)) {
    return { forbidden: true, reason: "cloud-metadata" };
  }
  for (const ipRange of FORBIDDEN_IP_RANGES) {
    if (!isIpInRange(ip, ipRange)) continue;
    if (allowPrivate && isPrivateRangeLabel(ipRange.label)) continue;
    return { forbidden: true, reason: ipRange.label };
  }
  return { forbidden: false };
}

function isPrivateRangeLabel(label: string): boolean {
  return (
    label === "private-10"
    || label === "private-172.16"
    || label === "private-192.168"
    || label === "loopback-127"
    || label === "loopback-ipv6"
    || label === "link-local-169.254"
    || label === "link-local-ipv6"
    || label === "ula-fc00"
    || label === "unspecified-ipv6"
    || label === "cgnat-100.64"
  );
}

/** Ошибка шлюза: типизированный код + классификация (без текста ошибки наружу). */
export class ProviderGatewayError extends Error {
  public readonly kind: ProviderGatewayErrorKind;
  public constructor(kind: ProviderGatewayErrorKind, detail?: string) {
    super(`PROVIDER_GATEWAY_${kind.toUpperCase()}${detail ? `:${detail}` : ""}`);
    this.name = "ProviderGatewayError";
    this.kind = kind;
  }
}

/** Код ошибки шлюза. */
export type ProviderGatewayErrorKind =
  | "malformed-url"
  | "forbidden-destination"
  | "dns-resolution-failed"
  | "redirect-policy"
  | "timeout"
  | "response-too-large"
  | "transport";

/** Функция DNS-резолвинга (внедряемая; по умолчанию — node:dns). */
export type GatewayLookupFn = (host: string) => Promise<readonly string[]>;

/** Параметры низкоуровневого соединения (внедряемого). */
export interface GatewayConnectParams {
  readonly ip: string;
  readonly port: number;
  readonly secure: boolean;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | Buffer>;
  readonly body: string | null;
  readonly signal: AbortSignal;
  readonly maxResponseBytes: number;
}

export interface GatewayConnectResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Функция соединения (внедряемая; по умолчанию — node:http/https). */
export type GatewayConnectFn = (params: GatewayConnectParams) => Promise<GatewayConnectResult>;

/** Опции шлюза. */
export interface ProviderGatewayOptions {
  /** Максимальный размер тела ответа в байтах. */
  readonly maxResponseBytes: number;
  /** Таймаут всего запроса (мс). */
  readonly requestTimeoutMs: number;
  /** Максимальное число redirect-хопов при `followRedirects`. */
  readonly maxRedirects: number;
}

export const DEFAULT_PROVIDER_GATEWAY_OPTIONS: ProviderGatewayOptions = Object.freeze({
  maxResponseBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 60_000,
  maxRedirects: 3,
});

/** Зависимости шлюза (в тестах — моки). */
export interface ProviderGatewayDeps {
  readonly lookup?: GatewayLookupFn;
  readonly connect?: GatewayConnectFn;
}

/** Спецификация одного HTTP-запроса через шлюз. */
export interface ProviderHttpRequestSpec {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string | Buffer>>;
  readonly body?: string;
  /** По умолчанию false — redirects не выполняются. */
  readonly followRedirects?: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  /** true — разрешены частные/локальные диапазоны (см. allowLocalEndpoint). */
  readonly allowPrivateDestination?: boolean;
  readonly sizeLimitBytes?: number;
  /** Внешний сигнал отмены (например отмена run). */
  readonly signal?: AbortSignal;
}

/** Ответ шлюза. */
export interface ProviderHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly finalUrl: string;
  readonly durationMs: number;
  readonly redirected: boolean;
}

/** Запись диагностики шлюза (все значения редэктированы). */
export interface ProviderGatewayLogEntry {
  readonly providerHost: string;
  readonly method: string;
  readonly status: number | null;
  readonly durationMs: number;
  readonly bytes: number;
  readonly redirected: boolean;
  readonly errorKind?: ProviderGatewayErrorKind;
}

const DEFAULT_LOOKUP: GatewayLookupFn = async (host) => {
  const records = await dns.promises.lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/** Реализация соединения по умолчанию: node:http/https с закреплённым IP. */
export const defaultGatewayConnect: GatewayConnectFn = (params) =>
  new Promise<GatewayConnectResult>((resolve, reject) => {
    const module = params.secure ? https : http;
    const request = module.request(
      {
        host: params.ip,
        port: params.port,
        method: params.method,
        path: params.path,
        // Node принимает Buffer-значения заголовков (сериализует через String);
        // в типизации OutgoingHttpHeaders Buffer отсутствует — каст здесь единственный.
        headers: params.headers as http.OutgoingHttpHeaders,
        servername: params.secure && typeof params.headers.host === "string" ? params.headers.host : undefined,
        rejectUnauthorized: params.secure,
        signal: params.signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers[key] = value;
          else if (Array.isArray(value)) headers[key] = value.join(", ");
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > params.maxResponseBytes) {
            response.destroy();
            reject(new ProviderGatewayError("response-too-large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        response.on("error", (error) => reject(error));
      },
    );
    request.on("error", (error) => {
      if (error instanceof Error && error.name === "AbortError") {
        reject(new ProviderGatewayError("timeout"));
        return;
      }
      reject(error);
    });
    if (params.body !== null) request.write(params.body);
    request.end();
  });

/** Разбирает URL и проверяет scheme/host/port/userinfo. */
export function validateProviderUrl(
  rawUrl: string,
): { protocol: string; hostname: string; port: number; host: string; path: string; origin: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProviderGatewayError("malformed-url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderGatewayError("malformed-url", "scheme");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ProviderGatewayError("malformed-url", "credentials-in-url");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) throw new ProviderGatewayError("malformed-url", "empty-host");
  // `new URL("https:///v1")` трактует "v1" как host — требуем явный authority
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(rawUrl) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\//u.test(rawUrl)) {
    throw new ProviderGatewayError("malformed-url", "missing-authority");
  }
  if (hasControlCharacters(rawUrl)) {
    throw new ProviderGatewayError("malformed-url", "control-chars");
  }
  const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProviderGatewayError("malformed-url", "port");
  }
  const host = parsed.port === "" ? hostname : `${hostname}:${parsed.port}`;
  return {
    protocol: parsed.protocol,
    hostname,
    port,
    host,
    path: `${parsed.pathname}${parsed.search}`,
    origin: `${parsed.protocol}//${host}`,
  };
}

/** Разрешает hostname в закреплённый набор адресов (с проверкой запретов). */
async function resolvePinnedDestinations(
  parsed: ReturnType<typeof validateProviderUrl>,
  allowPrivate: boolean,
  lookup: GatewayLookupFn,
): Promise<readonly ParsedIp[]> {
  // URL.hostname для IPv6 включает скобки — снимаем их для проверки литерала
  const literalHost = parsed.hostname.replace(/^\[|\]$/g, "");
  const literal = parseIp(literalHost);
  let addresses: readonly string[];
  if (literal) {
    addresses = [literalHost];
  } else {
    try {
      addresses = await lookup(parsed.hostname);
    } catch {
      throw new ProviderGatewayError("dns-resolution-failed", "lookup");
    }
  }
  if (addresses.length === 0) throw new ProviderGatewayError("dns-resolution-failed", "no-addresses");
  const pinned: ParsedIp[] = [];
  for (const address of addresses) {
    const ip = parseIp(address);
    if (!ip) throw new ProviderGatewayError("dns-resolution-failed", "non-ip");
    const check = checkForbiddenIp(ip, allowPrivate);
    if (check.forbidden) {
      throw new ProviderGatewayError("forbidden-destination", check.reason ?? "range");
    }
    pinned.push(ip);
  }
  return pinned;
}

/** Имена заголовков, несущих секреты (в нижнем регистре). */
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key",
  "api-key", "x-auth-token", "x-tenant-key", "x-api-source", "x-appwrite-project",
]);

/** True, если имя заголовка несёт секрет/credentials (любой регистр). */
function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
  // «Ловим» любые другие имена с признаком credentials (auth/token/key/secret/...)
  return /(?:api[_-]?key|token|secret|credential|authorization|password|cookie)/iu.test(lower);
}

/** Редэктирует заголовки для диагностики (маскирует секретные значения). */
export function redactProviderHeaders(
  headers: Readonly<Record<string, string | Buffer>>,
): Readonly<Record<string, string | Buffer>> {
  const out: Record<string, string | Buffer> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeaderName(key) ? "[REDACTED]" : value;
  }
  return out;
}

/**
 * Для redirect на другой host секретные заголовки (Authorization, API-key,
 * cookie и любые credential-bearing) НЕ переносятся на новый хост.
 * Для исходного host (или пока redirect не выполнялся) поведение не меняется.
 */
function stripSensitiveHeadersForCrossHostRedirect(
  headers: Readonly<Record<string, string | Buffer>>,
  fromOrigin: string | null,
  toOrigin: string,
): Record<string, string | Buffer> {
  if (fromOrigin === null || fromOrigin === toOrigin) return { ...headers };
  const out: Record<string, string | Buffer> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isSensitiveHeaderName(key)) out[key] = value;
  }
  return out;
}

/** Редэктирует URL для диагностики (userinfo и секретные query-параметры). */
export function redactProviderUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return safeRedact(rawUrl);
  }
  parsed.username = "";
  parsed.password = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|password|pass|secret|auth[_-]?token)$/iu.test(key)) {
      parsed.searchParams.set(key, "[REDACTED]");
    }
  }
  return parsed.toString();
}

class DeadlineController {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  public constructor(ms: number, external?: AbortSignal) {
    if (ms > 0) {
      this.timer = setTimeout(() => this.controller.abort(), ms);
      this.timer.unref?.();
    }
    if (external) {
      if (external.aborted) this.controller.abort();
      else external.addEventListener("abort", () => this.controller.abort(), { once: true });
    }
  }
  public get signal(): AbortSignal {
    return this.controller.signal;
  }
  public dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Позиция смены названия провайдера в диагностике (без реального значения). */
export const PROVIDER_GATEWAY_DIAGNOSTIC_HINT = "provider-network-gateway" as const;

/**
 * Сетевой шлюз провайдеров: единственный egress-порт.
 */
export class ProviderNetworkGateway {
  private readonly lookup: GatewayLookupFn;
  private readonly connect: GatewayConnectFn;
  private readonly options: ProviderGatewayOptions;

  public constructor(options: Partial<ProviderGatewayOptions> = {}, deps: ProviderGatewayDeps = {}) {
    this.options = { ...DEFAULT_PROVIDER_GATEWAY_OPTIONS, ...options };
    this.lookup = deps.lookup ?? DEFAULT_LOOKUP;
    this.connect = deps.connect ?? defaultGatewayConnect;
  }

  /**
   * Выполняет HTTP-запрос с полной валидацией назначения.
   * Бросает `ProviderGatewayError` при запрете/сбое.
   */
  public async execute(spec: ProviderHttpRequestSpec): Promise<ProviderHttpResponse> {
    const startedAt = Date.now();
    const maxRedirects = spec.maxRedirects ?? this.options.maxRedirects;
    let url = spec.url;
    let redirected = false;
    let hops = 0;
    // Origin предыдущего хопа: при redirect на другой host секретные заголовки
    // не переносятся (см. stripSensitiveHeadersForCrossHostRedirect).
    let previousOrigin: string | null = null;

    for (;;) {
      const parsed = validateProviderUrl(url);
      const allowPrivate = spec.allowPrivateDestination === true;
      const pinned = await resolvePinnedDestinations(parsed, allowPrivate, this.lookup);
      const ip = pinned[0]!;
      const isSecure = parsed.protocol === "https:";
      const hostHeader = parsed.host;
      const headers: Record<string, string | Buffer> = {
        "user-agent": "ebb-orchestrator-provider-gateway/1.0",
        host: hostHeader,
        ...stripSensitiveHeadersForCrossHostRedirect(spec.headers, previousOrigin, parsed.origin),
      };
      const deadline = new DeadlineController(spec.timeoutMs ?? this.options.requestTimeoutMs, spec.signal);
      try {
        const result = await this.connect({
          ip: ip.text,
          port: parsed.port,
          secure: isSecure,
          method: spec.method,
          path: parsed.path,
          headers,
          body: spec.body ?? null,
          signal: deadline.signal,
          maxResponseBytes: spec.sizeLimitBytes ?? this.options.maxResponseBytes,
        });

        // Защита от обхода лимита на уровне транспорта (включая DI-транспорты)
        const responseLimit = spec.sizeLimitBytes ?? this.options.maxResponseBytes;
        if (result.body.length > responseLimit) {
          throw new ProviderGatewayError("response-too-large");
        }

        const isRedirect = result.status >= 300 && result.status < 400 && result.headers.location;
        if (!isRedirect || !spec.followRedirects) {
          return {
            status: result.status,
            headers: result.headers,
            body: result.body,
            finalUrl: url,
            durationMs: Date.now() - startedAt,
            redirected,
          };
        }
        if (hops >= maxRedirects) {
          throw new ProviderGatewayError("redirect-policy", "max-redirects");
        }
        const location = result.headers.location;
        if (typeof location !== "string" || location.length === 0) {
          throw new ProviderGatewayError("redirect-policy", "empty-location");
        }
        const next = new URL(location, url);
        if (next.protocol === "http:" && isSecure) {
          // downgrade https→http запрещён
          throw new ProviderGatewayError("redirect-policy", "https-downgrade");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new ProviderGatewayError("redirect-policy", "scheme");
        }
        url = next.toString();
        redirected = true;
        hops += 1;
        previousOrigin = parsed.origin;
      } catch (error) {
        if (error instanceof ProviderGatewayError) throw error;
        if (error instanceof Error && (error.name === "AbortError" || error.message === "AbortError")) {
          throw new ProviderGatewayError("timeout");
        }
        throw error;
      } finally {
        deadline.dispose();
      }
    }
  }

  /** Диагностический снимок (все значения редэктированы). */
  public describe(spec: ProviderHttpRequestSpec, response?: ProviderHttpResponse, errorKind?: ProviderGatewayErrorKind): ProviderGatewayLogEntry {
    const parsed = validateProviderUrl(spec.url);
    return {
      providerHost: parsed.hostname,
      method: spec.method,
      status: response?.status ?? null,
      durationMs: response?.durationMs ?? 0,
      bytes: response ? response.body.length : 0,
      redirected: response?.redirected ?? false,
      ...(errorKind ? { errorKind } : {}),
    };
  }
}
