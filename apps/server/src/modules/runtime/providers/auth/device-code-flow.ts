/**
 * OAuth Device Flow (RFC 8628) поверх сетевого шлюза провайдеров
 * (plan-24, Task 4).
 *
 * Реализует протокол устройства:
 *  - `start` — POST на device authorization endpoint (client_id, scope);
 *  - `poll` — POST на token endpoint с grant_type=urn:ietf:params:oauth:
 *    grant-type:device_code; ответы классифицируются (pending/complete/denied/
 *    expired/failed, включая 429 и 5xx);
 *  - `exchangeCopilotBearer` — обмен короткоживущего bearer-токена Copilot
 *    из OAuth access token по требованию (tokenExchangeEndpoint).
 *
 * Все HTTP-вызовы выполняются только через ProviderNetworkGateway; прямые
 * fetch/undici/net-вызовы запрещены. Токены и другие значения в сообщениях
 * об ошибках не раскрываются — наружу идут только классифицированные
 * результаты и безопасные причины.
 */

import {
  ProviderNetworkGateway,
  type ProviderHttpResponse,
} from "../provider-network-gateway.js";
import type { OAuthDeviceCodeSpec } from "./provider-auth-flow-specs.js";

/** Результат запуска device-потока. */
export interface DeviceCodeStartResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly verificationUrlComplete?: string;
  /** Интервал опроса в секундах (из ответа сервера или дефолт спецификации). */
  readonly intervalSeconds: number;
  /** Срок действия device_code в секундах (expires_in). */
  readonly expiresInSeconds: number;
}

/** Исход токенов успешного устройства. */
export interface DeviceTokenPair {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Срок действия access token в секундах (если передан сервером). */
  readonly expiresInSeconds?: number;
}

/** Исход опроса token endpoint. */
export type DeviceTokenPollOutcome =
  | { readonly outcome: "pending" }
  | { readonly outcome: "complete"; readonly tokens: DeviceTokenPair }
  | { readonly outcome: "denied" }
  | { readonly outcome: "expired" }
  | { readonly outcome: "failed"; readonly failureKind: "gateway" | "token-exchange" | "invalid-grant" | "unknown" };

/** Классифицирует ошибку device-потока из тела ответа (без раскрытия значений). */
export function classifyDeviceTokenErrorBody(body: string, status: number): DeviceTokenPollOutcome {
  if (status === 429) {
    // Rate limit: опрос продолжается позже (PENDING), как и при slow_down.
    return { outcome: "pending" };
  }
  if (status >= 500) {
    return { outcome: "failed", failureKind: "token-exchange" };
  }
  let error: unknown;
  try {
    error = JSON.parse(body) as { error?: unknown };
  } catch {
    return { outcome: "failed", failureKind: "unknown" };
  }
  const code = typeof (error as { error?: unknown }).error === "string" ? (error as { error: string }).error : "";
  switch (code) {
    case "authorization_pending":
    case "slow_down":
      return { outcome: "pending" };
    case "access_denied":
      return { outcome: "denied" };
    case "expired_token":
      return { outcome: "expired" };
    case "invalid_grant":
      return { outcome: "failed", failureKind: "invalid-grant" };
    default:
      return { outcome: "failed", failureKind: "unknown" };
  }
}

/** Парсит успешный ответ token endpoint. */
function parseTokenResponse(body: string): DeviceTokenPair {
  const parsed = JSON.parse(body) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("PROVIDER_AUTH_TOKEN_RESPONSE_INVALID");
  }
  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0 ? { refreshToken: parsed.refresh_token } : {}),
    ...(typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? { expiresInSeconds: parsed.expires_in } : {}),
  };
}

/** Парсит ответ device authorization endpoint. */
function parseDeviceCodeResponse(body: string, defaultInterval: number): DeviceCodeStartResult {
  const parsed = JSON.parse(body) as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    verification_uri_complete?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  if (
    typeof parsed.device_code !== "string" || parsed.device_code.length === 0
    || typeof parsed.user_code !== "string" || parsed.user_code.length === 0
    || typeof parsed.verification_uri !== "string" || parsed.verification_uri.length === 0
  ) {
    throw new Error("PROVIDER_AUTH_DEVICE_RESPONSE_INVALID");
  }
  const expiresIn = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 1800;
  const interval = typeof parsed.interval === "number" && Number.isFinite(parsed.interval) ? parsed.interval : defaultInterval;
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUrl: parsed.verification_uri,
    ...(typeof parsed.verification_uri_complete === "string" && parsed.verification_uri_complete.length > 0 ? { verificationUrlComplete: parsed.verification_uri_complete } : {}),
    intervalSeconds: interval,
    expiresInSeconds: expiresIn,
  };
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8";

function encodeForm(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * Движок OAuth Device Flow. Все запросы идут через ProviderNetworkGateway.
 */
export class DeviceCodeFlow {
  public constructor(
    private readonly gateway: ProviderNetworkGateway,
    private readonly deps: { readonly now?: () => Date } = {},
  ) {}

  /**
   * Запускает device-поток: отправляет запрос на device authorization
   * endpoint. Возвращает device_code и публичные данные для отображения.
   */
  public async start(spec: OAuthDeviceCodeSpec): Promise<DeviceCodeStartResult> {
    const body = encodeForm({
      client_id: spec.clientId,
      ...(spec.scopes.length > 0 ? { scope: spec.scopes.join(" ") } : {}),
    });
    let response: ProviderHttpResponse;
    try {
      response = await this.gateway.execute({
        method: "POST",
        url: spec.deviceAuthorizationEndpoint,
        headers: { "content-type": FORM_CONTENT_TYPE, accept: "application/json" },
        body,
      });
    } catch {
      throw new Error("PROVIDER_AUTH_DEVICE_START_GATEWAY_FAILED");
    }
    if (response.status !== 200) {
      throw new Error("PROVIDER_AUTH_DEVICE_START_REJECTED");
    }
    return parseDeviceCodeResponse(response.body, spec.defaultPollingInterval);
  }

  /**
   * Опрашивает token endpoint. Только `complete` возвращает токены;
   * остальные исходы классифицированы без значений.
   */
  public async poll(spec: OAuthDeviceCodeSpec, deviceCode: string): Promise<DeviceTokenPollOutcome> {
    const body = encodeForm({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: spec.clientId,
    });
    let response: ProviderHttpResponse;
    try {
      response = await this.gateway.execute({
        method: "POST",
        url: spec.tokenEndpoint,
        headers: { "content-type": FORM_CONTENT_TYPE, accept: "application/json" },
        body,
      });
    } catch {
      return { outcome: "failed", failureKind: "gateway" };
    }
    if (response.status === 200) {
      try {
        return { outcome: "complete", tokens: parseTokenResponse(response.body) };
      } catch {
        return { outcome: "failed", failureKind: "token-exchange" };
      }
    }
    return classifyDeviceTokenErrorBody(response.body, response.status);
  }

  /**
   * Обменивает OAuth access token на короткоживущий bearer-токен Copilot
   * (tokenExchangeEndpoint). Возвращает undefined, если endpoint не объявлен
   * или обмен не удался (без раскрытия деталей).
   */
  public async exchangeCopilotBearer(spec: OAuthDeviceCodeSpec, accessToken: string): Promise<string | undefined> {
    if (!spec.tokenExchangeEndpoint) return undefined;
    let response: ProviderHttpResponse;
    try {
      response = await this.gateway.execute({
        method: "POST",
        url: spec.tokenExchangeEndpoint,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
        },
      });
    } catch {
      return undefined;
    }
    if (response.status !== 200) return undefined;
    try {
      const parsed = JSON.parse(response.body) as { token?: unknown };
      return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined;
    } catch {
      return undefined;
    }
  }
}
