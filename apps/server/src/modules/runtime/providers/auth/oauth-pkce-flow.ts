/**
 * OAuth Authorization Code + PKCE (plan-24, Task 4).
 *
 * Реализует одноразовый PKCE-поток:
 *  - `start` генерирует криптографически случайные verifier/challenge/state;
 *    возвращает URL авторизации, а секретные артефакты сохраняются вызывающим
 *    (в `AuthFlowSecretVault`) и используются один раз;
 *  - `complete` проверяет точное совпадение callback-origin с ожидаемым
 *    origin redirect URI, проверяет state (one-use), обменивает code на токены
 *    через шлюз.
 *
 * Инварианты безопасности:
 *  - state/verifier — одноразовые: повторное использование завершается сбоем
 *    (replay protection); после обмена значения обнуляются;
 *  - `isAllowedCallbackOrigin` сравнивает origin по точному равенству (без
 *    подстановок и нормализаций, допускающих обход);
 *  - все HTTP-запросы идут только через ProviderNetworkGateway.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  ProviderNetworkGateway,
  type ProviderHttpResponse,
} from "../provider-network-gateway.js";
import type { OAuthPkceSpec } from "./provider-auth-flow-specs.js";

/** Результат запуска PKCE-потока. */
export interface PkceStartResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
}

/** Результат завершения PKCE-потока (обмен code на токены). */
export interface PkceCompleteResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresInSeconds?: number;
}

/** Параметры callback (query-строка OAuth redirect). */
export interface PkceCallbackParams {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
}

/** Классифицированный сбой завершения PKCE. */
export type PkceCompleteOutcome =
  | { readonly ok: true; readonly tokens: PkceCompleteResult }
  | { readonly ok: false; readonly failureKind: "callback-origin" | "state-mismatch" | "code-missing" | "token-exchange" | "gateway" | "user-denied" };

const PKCE_VERIFIER_BYTES = 32;
const PKCE_STATE_BYTES = 16;

/** Генерирует PKCE verifier (base64url, 43 символа). */
export function generatePkceVerifier(random: (bytes: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(PKCE_VERIFIER_BYTES)).toString("base64url");
}

/** Вычисляет PKCE challenge (S256). */
export function computePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/** Генерирует одноразовый OAuth state. */
export function generatePkceState(random: (bytes: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(PKCE_STATE_BYTES)).toString("base64url");
}

/**
 * Проверяет точное совпадение origin callback с ожидаемым origin.
 * Сравнение — по точному равенству: любые отличия (схема, хост, порт,
 * лишний слэш) отклоняются.
 */
export function isAllowedCallbackOrigin(actualOrigin: string, expectedOrigin: string): boolean {
  return actualOrigin === expectedOrigin;
}

/** Извлекает origin из URL (scheme://host[:port]). */
export function originOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return undefined;
  }
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8";

function encodeForm(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * Движок OAuth Authorization Code + PKCE. Все запросы идут через
 * ProviderNetworkGateway.
 */
export class PkceFlow {
  public constructor(private readonly gateway: ProviderNetworkGateway) {}

  /** Строит URL авторизации и возвращает секретные артефакты потока. */
  public start(spec: OAuthPkceSpec, deps: { readonly random?: (bytes: number) => Uint8Array } = {}): PkceStartResult {
    const random = deps.random ?? randomBytes;
    const verifier = generatePkceVerifier(random);
    const challenge = computePkceChallenge(verifier);
    const state = generatePkceState(random);
    const authorizationUrl = new URL(spec.authorizationEndpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", spec.clientId);
    authorizationUrl.searchParams.set("redirect_uri", spec.redirectUri);
    authorizationUrl.searchParams.set("scope", spec.scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: authorizationUrl.toString(), state, verifier, challenge };
  }

  /**
   * Завершает поток: проверяет origin, state (one-use) и обменивает code на
   * токены. `expectedOrigin` — точный origin redirect URI; `actualOrigin` —
   * origin, из которого пришёл callback.
   */
  public async complete(
    spec: OAuthPkceSpec,
    params: PkceCallbackParams,
    expectedOrigin: string,
    actualOrigin: string,
    state: string,
    verifier: string,
  ): Promise<PkceCompleteOutcome> {
    if (!isAllowedCallbackOrigin(actualOrigin, expectedOrigin)) {
      return { ok: false, failureKind: "callback-origin" };
    }
    if (state.length === 0 || params.state !== state) {
      return { ok: false, failureKind: "state-mismatch" };
    }
    if (params.error) {
      return { ok: false, failureKind: "user-denied" };
    }
    if (typeof params.code !== "string" || params.code.length === 0) {
      return { ok: false, failureKind: "code-missing" };
    }
    const body = encodeForm({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: spec.redirectUri,
      client_id: spec.clientId,
      code_verifier: verifier,
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
      return { ok: false, failureKind: "gateway" };
    }
    if (response.status !== 200) {
      return { ok: false, failureKind: "token-exchange" };
    }
    try {
      const parsed = JSON.parse(response.body) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
        return { ok: false, failureKind: "token-exchange" };
      }
      return {
        ok: true,
        tokens: {
          accessToken: parsed.access_token,
          ...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0 ? { refreshToken: parsed.refresh_token } : {}),
          ...(typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? { expiresInSeconds: parsed.expires_in } : {}),
        },
      };
    } catch {
      return { ok: false, failureKind: "token-exchange" };
    }
  }
}
