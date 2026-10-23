/**
 * Refresh-поток OAuth-токенов провайдеров с ротацией
 * (plan-24, Task 4).
 *
 * Поведение:
 *  - refresh выполняется только для методов, где источник объявляет серверный
 *    refresh (`refreshTokenGrant: true` у chatgpt/supergrok; для Copilot
 *    refresh отсутствует — используется exchange-on-demand через
 *    `exchangeCopilotBearer`, а не refresh_token grant);
 *  - новые токены сохраняются через `ProviderCredentialStore.saveCredential`
 *    (атомарная ротация той же opaque-записи); наружу возвращаются только
 *    метаданные, никогда — значения;
 *  - конкурентные refresh для одной пары (провайдер, метод) дедуплицируются
 *    общим обещанием (concurrent refresh lock): в сеть уходит один запрос;
 *  - начало `invalid_grant` (или аналогичные коды) помечает credential как
 *    мёртвый (`DISCONNECTED`) и бросает `CredentialExpiredError`;
 *  - транзиентные 429/5xx и транспортные сбои повторяются ограниченное число
 *    раз (bounded retries) и бросают `TransientRefreshError`, не трогая
 *    статус credential.
 */

import {
  ProviderNetworkGateway,
  type ProviderHttpResponse,
} from "../provider-network-gateway.js";
import {
  ProviderCredentialMissingError,
  type ProviderCredentialStore,
} from "../provider-credential-store.js";
import type { ProviderSettingsRepository } from "../provider-settings-repository.js";
import { getAuthFlowSpec, type OAuthDeviceCodeSpec } from "./provider-auth-flow-specs.js";

/** Ошибка: refresh невозможен (нет серверного refresh-контракта). */
export class NoRefreshStrategyError extends Error {
  public constructor(providerId: string, methodId: string) {
    super(`No refresh strategy for '${providerId}/${methodId}'`);
    this.name = "NoRefreshStrategyError";
  }
}

/** Ошибка: refresh-токен отклонён сервером (invalid_grant) — credential мёртв. */
export class CredentialExpiredError extends Error {
  public constructor(providerId: string, methodId: string) {
    super(`Credential for '${providerId}/${methodId}' was rejected by provider (invalid_grant)`);
    this.name = "CredentialExpiredError";
  }
}

/** Ошибка: транзиентный сбой refresh (429/5xx/сеть) после ограниченных ретраев. */
export class TransientRefreshError extends Error {
  public constructor(providerId: string, methodId: string) {
    super(`Transient refresh failure for '${providerId}/${methodId}'`);
    this.name = "TransientRefreshError";
  }
}

/** Результат refresh: только факт ротации и метаданные. */
export interface TokenRefreshResult {
  readonly providerId: string;
  readonly authMethodId: string;
  readonly rotated: true;
  readonly updatedAt: string;
}

/** Параметры refresh-запроса. */
export interface TokenRefreshDeps {
  readonly now?: () => Date;
  readonly sleepMs?: (ms: number) => Promise<void>;
}

const MAX_TRANSIENT_RETRIES = 3;
const RETRY_DELAYS_MS = [100, 250, 500] as const;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=utf-8";

function encodeForm(params: Readonly<Record<string, string>>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

/**
 * Сервис refresh-ротации токенов.
 */
export class TokenRefreshService {
  private readonly inflight = new Map<string, Promise<TokenRefreshResult>>();

  public constructor(
    private readonly gateway: ProviderNetworkGateway,
    private readonly credentialStore: ProviderCredentialStore,
    private readonly repository: ProviderSettingsRepository,
    private readonly deps: TokenRefreshDeps = {},
  ) {}

  /**
   * Выполняет refresh с ротацией. Возвращает только метаданные.
   * Конкурентные вызовы для одной пары дедуплицируются.
   */
  public async refreshCredential(providerId: string, methodId: string): Promise<TokenRefreshResult> {
    const key = `${providerId}:${methodId}`;
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;
    const promise = this.doRefresh(providerId, methodId).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async doRefresh(providerId: string, methodId: string): Promise<TokenRefreshResult> {
    const spec = getAuthFlowSpec(providerId, methodId);
    if (!spec || spec.kind !== "oauth-device-code" || !spec.refreshTokenGrant) {
      throw new NoRefreshStrategyError(providerId, methodId);
    }
    const metadata = this.credentialStore.getCredentialMetadata(providerId, methodId);
    if (!metadata) {
      throw new ProviderCredentialMissingError(`Credential for '${providerId}/${methodId}' is not configured`);
    }
    const payload = await this.credentialStore.readCredentialPayload(providerId, methodId);
    const refreshToken = payload.oauthRefreshToken;
    if (typeof refreshToken !== "string" || refreshToken.length === 0) {
      throw new ProviderCredentialMissingError(`Refresh token for '${providerId}/${methodId}' is missing`);
    }

    let lastResponse: ProviderHttpResponse | undefined;
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
      if (attempt > 0) {
        await (this.deps.sleepMs ?? defaultSleep)(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!);
      }
      let response: ProviderHttpResponse;
      try {
        response = await this.gateway.execute({
          method: "POST",
          url: (spec as OAuthDeviceCodeSpec).tokenEndpoint,
          headers: { "content-type": FORM_CONTENT_TYPE, accept: "application/json" },
          body: encodeForm({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: spec.clientId,
          }),
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("PROVIDER_GATEWAY_")) {
          if (attempt < MAX_TRANSIENT_RETRIES) continue;
          throw new TransientRefreshError(providerId, methodId);
        }
        throw error;
      }
      lastResponse = response;
      if (response.status === 200) {
        const tokens = parseRefreshSuccess(response.body);
        await this.credentialStore.saveCredential(providerId, methodId, {
          oauthAccessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { oauthRefreshToken: tokens.refreshToken } : { oauthRefreshToken: refreshToken }),
        });
        const now = (this.deps.now ?? (() => new Date()))().toISOString();
        return { providerId, authMethodId: methodId, rotated: true, updatedAt: now };
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_TRANSIENT_RETRIES) continue;
        throw new TransientRefreshError(providerId, methodId);
      }
      break;
    }

    // Не-2xx, не-транзиентный ответ: классифицируем ошибку гранта.
    if (lastResponse && isInvalidGrant(lastResponse)) {
      this.markDead(providerId, methodId);
      throw new CredentialExpiredError(providerId, methodId);
    }
    throw new TransientRefreshError(providerId, methodId);
  }

  private markDead(providerId: string, methodId: string): void {
    const metadata = this.repository.getCredentialMetadata(providerId, methodId);
    if (!metadata) return;
    this.repository.attachCredentialMetadata({
      providerId,
      authMethodId: methodId,
      secretName: metadata.secretName,
      referenceId: metadata.referenceId,
      status: "DISCONNECTED",
      now: (this.deps.now ?? (() => new Date()))().toISOString(),
    });
  }
}

function parseRefreshSuccess(body: string): { accessToken: string; refreshToken?: string } {
  const parsed = JSON.parse(body) as { access_token?: unknown; refresh_token?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("PROVIDER_AUTH_REFRESH_RESPONSE_INVALID");
  }
  return {
    accessToken: parsed.access_token,
    ...(typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0 ? { refreshToken: parsed.refresh_token } : {}),
  };
}

function isInvalidGrant(response: ProviderHttpResponse): boolean {
  if (response.status !== 400 && response.status !== 403) return false;
  try {
    const parsed = JSON.parse(response.body) as { error?: unknown; error_description?: unknown };
    const code = typeof parsed.error === "string" ? parsed.error : "";
    return code === "invalid_grant" || code === "invalid_token";
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
