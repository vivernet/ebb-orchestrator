/**
 * Сервис жизненного цикла авторизации провайдеров (plan-24, Task 4).
 *
 * Единая точка входа для Web/API: begin/poll/cancel/disconnect/refresh/status.
 *
 * Реализация:
 *  - `beginAuthorization` запускает интерактивный поток (device-code или
 *    PKCE) и возвращает только публичные данные; неинтерактивные методы
 *    (api-key, subscription-token, credential-fields, cloud-identity,
 *    local-endpoint) управляются Task 2 credential store и здесь отклоняются;
 *  - `pollAuthorization` проверяет привязку к сессии (cross-session запрещён),
 *    срок действия (expiry enforcement) и опрашивает device token endpoint;
 *  - токены сохраняются через `ProviderCredentialStore` (bounded payloads) и
 *    никогда не возвращаются; device_code/verifier/state обнуляются после
 *    завершения/отмены/истечения;
 *  - все HTTP-запросы идут только через ProviderNetworkGateway;
 *  - disconnect: локальное удаление credentials (keyring + метаданные) и
 *    отмена активных потоков; удалённый revoke заявляется только при наличии
 *    документированного endpoint (в закреплённом источнике его нет →
 *    `LOCAL_DISCONNECTED`).
 */

import { randomBytes } from "node:crypto";
import { ProviderNetworkGateway } from "../provider-network-gateway.js";
import {
  getProvider,
} from "../provider-catalog.js";
import type { ProviderAuthMethod } from "../provider-types.js";
import {
  ProviderConfigurationMissingError,
  type ProviderSettingsRepository,
} from "../provider-settings-repository.js";
import {
  ProviderCredentialMissingError,
  type ProviderCredentialStore,
} from "../provider-credential-store.js";
import {
  AuthFlowSecretVault,
  InMemoryAuthFlowStore,
  isFlowExpired,
  toSafeFlowProjection,
  type AuthFlowStore,
  type ProviderAuthFlowProjection,
  type ProviderAuthFlowRecord,
} from "./provider-auth-state.js";
import {
  INTERACTIVE_AUTH_METHODS,
  getAuthFlowSpec,
  type OAuthDeviceCodeSpec,
  type OAuthPkceSpec,
  type ProviderAuthFlowSpec,
} from "./provider-auth-flow-specs.js";
import { DeviceCodeFlow } from "./device-code-flow.js";
import { PkceFlow, type PkceCallbackParams } from "./oauth-pkce-flow.js";
import {
  CredentialExpiredError,
  NoRefreshStrategyError,
  TokenRefreshService,
  TransientRefreshError,
  type TokenRefreshResult,
} from "./token-refresh.js";

/** Категории ошибок сервиса авторизации (без секретных значений). */
export type ProviderAuthErrorKind =
  | "PROVIDER_UNKNOWN"
  | "AUTH_METHOD_UNKNOWN"
  | "AUTH_METHOD_NOT_INTERACTIVE"
  | "AUTH_FLOW_NOT_FOUND"
  | "AUTH_FLOW_SESSION_MISMATCH"
  | "AUTH_FLOW_FINISHED"
  | "AUTH_FLOW_EXPIRED"
  | "AUTH_FLOW_START_FAILED"
  | "AUTH_FLOW_POLL_FAILED"
  | "AUTH_DISCONNECT_MISSING_CONFIG"
  | "AUTH_REFRESH_NO_STRATEGY"
  | "AUTH_REFRESH_EXPIRED"
  | "AUTH_REFRESH_TRANSIENT"
  | "AUTH_CREDENTIAL_MISSING"
  | "AUTH_CREDENTIAL_STORE_UNAVAILABLE";

/** Ошибка сервиса авторизации провайдеров. */
export class ProviderAuthError extends Error {
  public readonly kind: ProviderAuthErrorKind;
  public constructor(kind: ProviderAuthErrorKind) {
    super(`PROVIDER_AUTH_${kind}`);
    this.name = "ProviderAuthError";
    this.kind = kind;
  }
}

/** Входные данные запуска потока авторизации. */
export interface BeginAuthorizationInput {
  readonly providerId: string;
  readonly methodId: string;
  readonly sessionBinding: string;
}

/** Результат запуска потока: только публичные данные, без секретов. */
export interface BeginAuthorizationResult {
  readonly flowId: string;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
}

/** Исход опроса потока. */
export type PollAuthorizationResult = ProviderAuthFlowProjection;

/** Результат отключения провайдера. */
export interface ProviderDisconnectResult {
  readonly providerId: string;
  readonly localDisconnected: true;
  /** `LOCAL_DISCONNECTED` — upstream revoke endpoint отсутствует. */
  readonly remoteRevoke: "NOT_ATTEMPTED" | "LOCAL_DISCONNECTED";
  readonly revokedCredentialRefs: readonly string[];
}

/** Статусная проекция авторизации провайдера. */
export interface ProviderAuthStatusProjection {
  readonly providerId: string;
  readonly methodId: string;
  readonly hasCredential: boolean;
  readonly credentialStatus: "ACTIVE" | "DISCONNECTED" | "NONE";
  readonly activeFlows: readonly ProviderAuthFlowProjection[];
  readonly latestFlow?: ProviderAuthFlowProjection;
}

/** Зависимости сервиса авторизации. */
export interface ProviderAuthFlowDeps {
  readonly gateway: ProviderNetworkGateway;
  readonly store?: AuthFlowStore;
  readonly vault?: AuthFlowSecretVault;
  readonly credentialStore: ProviderCredentialStore;
  readonly settingsRepository: ProviderSettingsRepository;
  readonly now?: () => Date;
  readonly randomBytes?: (bytes: number) => Uint8Array;
  readonly sleepMs?: (ms: number) => Promise<void>;
  /**
   * Резолвер спецификаций OAuth-потоков. По умолчанию — каталог
   * `provider-auth-flow-specs`; внедряется в тестах для покрытия PKCE-пути.
   */
  readonly flowSpecResolver?: (providerId: string, methodId: string) => ProviderAuthFlowSpec | undefined;
}

/** Дефолтный срок действия потока (сек), если сервер не вернул expires_in. */
const DEFAULT_FLOW_TTL_SECONDS = 10 * 60;

/**
 * Сервис жизненного цикла авторизации провайдеров.
 */
export class ProviderAuthFlowService {
  private readonly store: AuthFlowStore;
  private readonly vault: AuthFlowSecretVault;
  private readonly credentialStore: ProviderCredentialStore;
  private readonly settingsRepository: ProviderSettingsRepository;
  private readonly deviceCodeFlow: DeviceCodeFlow;
  private readonly pkceFlow: PkceFlow;
  private readonly tokenRefresh: TokenRefreshService;
  private readonly now: () => Date;
  private readonly randomBytes: (bytes: number) => Uint8Array;
  private readonly resolveSpec: (providerId: string, methodId: string) => ProviderAuthFlowSpec | undefined;

  public constructor(deps: ProviderAuthFlowDeps) {
    this.store = deps.store ?? new InMemoryAuthFlowStore();
    this.vault = deps.vault ?? new AuthFlowSecretVault();
    this.credentialStore = deps.credentialStore;
    this.settingsRepository = deps.settingsRepository;
    const deviceCodeDeps = deps.now ? { now: deps.now } : {};
    this.deviceCodeFlow = new DeviceCodeFlow(deps.gateway, deviceCodeDeps);
    this.pkceFlow = new PkceFlow(deps.gateway);
    const refreshDeps = {
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleepMs ? { sleepMs: deps.sleepMs } : {}),
    };
    this.tokenRefresh = new TokenRefreshService(deps.gateway, deps.credentialStore, deps.settingsRepository, refreshDeps);
    this.now = deps.now ?? (() => new Date());
    this.randomBytes = deps.randomBytes ?? randomBytes;
    this.resolveSpec = deps.flowSpecResolver ?? getAuthFlowSpec;
  }

  /** Запускает интерактивный поток авторизации. */
  public async beginAuthorization(input: BeginAuthorizationInput): Promise<BeginAuthorizationResult> {
    const definition = getProvider(input.providerId);
    if (!definition) throw new ProviderAuthError("PROVIDER_UNKNOWN");
    const methodId = input.methodId as ProviderAuthMethod;
    const spec = this.resolveSpec(input.providerId, methodId);
    if (!definition.authMethods.includes(methodId) && !spec) {
      throw new ProviderAuthError("AUTH_METHOD_UNKNOWN");
    }
    if (!INTERACTIVE_AUTH_METHODS.includes(methodId)) {
      throw new ProviderAuthError("AUTH_METHOD_NOT_INTERACTIVE");
    }

    if (methodId === "oauth-device-code") {
      const deviceSpec: OAuthDeviceCodeSpec | undefined = spec !== undefined && spec.kind === "oauth-device-code" ? spec : undefined;
      if (!deviceSpec) throw new ProviderAuthError("AUTH_FLOW_START_FAILED");
      const started = await this.deviceCodeFlow.start(deviceSpec);
      const nowDate = this.now();
      const expiresAt = new Date(nowDate.getTime() + started.expiresInSeconds * 1000).toISOString();
      const record = this.store.create({
        providerId: input.providerId,
        methodId,
        sessionBinding: input.sessionBinding,
        expiresAt,
        pollIntervalSeconds: started.intervalSeconds,
        now: nowDate.toISOString(),
      });
      this.vault.set(record.flowId, { deviceCode: started.deviceCode });
      return {
        flowId: record.flowId,
        verificationUrl: started.verificationUrlComplete ?? started.verificationUrl,
        userCode: started.userCode,
        expiresAt,
        pollIntervalSeconds: started.intervalSeconds,
      };
    }

    // oauth-pkce: спецификация отсутствует в текущей инвентаризации 86
    // карточек; поток доступен для зарегистрированных PKCE-карточек через
    // резолвер спецификаций (см. specs-модуль и тесты).
    const pkceSpec = spec && spec.kind === "oauth-pkce" ? spec : undefined;
    if (!pkceSpec) throw new ProviderAuthError("AUTH_FLOW_START_FAILED");
    const started = this.pkceFlow.start(pkceSpec, { random: this.randomBytes });
    const nowDate = this.now();
    const expiresAt = new Date(nowDate.getTime() + DEFAULT_FLOW_TTL_SECONDS * 1000).toISOString();
    const record = this.store.create({
      providerId: input.providerId,
      methodId,
      sessionBinding: input.sessionBinding,
      expiresAt,
      pollIntervalSeconds: 0,
      now: nowDate.toISOString(),
    });
    this.vault.set(record.flowId, { verifier: started.verifier, challenge: started.challenge, state: started.state });
    return {
      flowId: record.flowId,
      verificationUrl: started.authorizationUrl,
      expiresAt,
      pollIntervalSeconds: 0,
    };
  }

  /** Возвращает безопасную проекцию потока (с проверкой сессии и срока). */
  public getFlowStatus(flowId: string, sessionBinding: string): ProviderAuthFlowProjection {
    const record = this.requireFlow(flowId, sessionBinding);
    const expired = record.status === "PENDING" && isFlowExpired(record, this.now());
    if (expired) {
      const updated = this.transition(record, "EXPIRED", "expired");
      return toSafeFlowProjection(updated);
    }
    return toSafeFlowProjection(record);
  }

  /** Опрашивает поток авторизации (device poll / PKCE). */
  public async pollAuthorization(flowId: string, sessionBinding: string): Promise<PollAuthorizationResult> {
    const record = this.requireFlow(flowId, sessionBinding);

    if (record.status !== "PENDING") {
      return toSafeFlowProjection(record);
    }
    if (isFlowExpired(record, this.now())) {
      const updated = this.transition(record, "EXPIRED", "expired");
      return toSafeFlowProjection(updated);
    }

    if (record.methodId === "oauth-device-code") {
      const spec = this.resolveSpec(record.providerId, record.methodId);
      const deviceSpec: OAuthDeviceCodeSpec | undefined = spec !== undefined && spec.kind === "oauth-device-code" ? spec : undefined;
      const deviceCode = this.vault.get(record.flowId)?.deviceCode;
      if (!deviceSpec || !deviceCode) {
        return toSafeFlowProjection(this.transition(record, "FAILED", "token-exchange"));
      }
      const outcome = await this.deviceCodeFlow.poll(deviceSpec, deviceCode);
      switch (outcome.outcome) {
        case "pending": {
          return toSafeFlowProjection(record);
        }
        case "complete": {
          try {
            await this.storeTokens(record, outcome.tokens.accessToken, outcome.tokens.refreshToken, deviceSpec);
          } catch (error) {
            if (error instanceof ProviderAuthError && error.kind === "AUTH_CREDENTIAL_STORE_UNAVAILABLE") throw error;
            return toSafeFlowProjection(this.transition(record, "FAILED", "token-exchange"));
          }
          this.vault.delete(record.flowId);
          return toSafeFlowProjection(this.transition(record, "COMPLETE"));
        }
        case "denied": {
          this.vault.delete(record.flowId);
          return toSafeFlowProjection(this.transition(record, "DENIED", "denied"));
        }
        case "expired": {
          this.vault.delete(record.flowId);
          return toSafeFlowProjection(this.transition(record, "EXPIRED", "expired"));
        }
        case "failed": {
          this.vault.delete(record.flowId);
          const kind = outcome.failureKind === "gateway" ? "gateway" : outcome.failureKind === "invalid-grant" ? "invalid-grant" : "token-exchange";
          return toSafeFlowProjection(this.transition(record, "FAILED", kind));
        }
      }
    }

    // PKCE: опрос не выполняет сетевых вызовов; состояние меняется только
    // через completeAuthorization (Task 6 callback) или истечение срока.
    return toSafeFlowProjection(record);
  }

  /**
   * Завершает PKCE-поток по callback (проверка origin и state one-use).
   * Вызывается маршрутом callback (Task 6) или тестами.
   */
  public async completeAuthorization(
    flowId: string,
    sessionBinding: string,
    params: { code?: string; state?: string; error?: string },
    actualOrigin: string,
  ): Promise<PollAuthorizationResult> {
    const record = this.requireFlow(flowId, sessionBinding);
    if (record.status !== "PENDING") {
      return toSafeFlowProjection(record);
    }
    if (isFlowExpired(record, this.now())) {
      return toSafeFlowProjection(this.transition(record, "EXPIRED", "expired"));
    }
    if (record.methodId !== "oauth-pkce") {
      throw new ProviderAuthError("AUTH_FLOW_FINISHED");
    }
    const spec = this.resolveSpec(record.providerId, record.methodId) as OAuthPkceSpec | undefined;
    const secrets = this.vault.get(record.flowId);
    if (!spec || !secrets || !secrets.state || !secrets.verifier) {
      this.vault.delete(record.flowId);
      return toSafeFlowProjection(this.transition(record, "FAILED", "state-mismatch"));
    }
    const expectedOrigin = expectedOriginOf(spec.redirectUri);
    const callbackParams: PkceCallbackParams = {
      ...(params.code !== undefined ? { code: params.code } : {}),
      ...(params.state !== undefined ? { state: params.state } : {}),
      ...(params.error !== undefined ? { error: params.error } : {}),
    };
    const outcome = await this.pkceFlow.complete(
      spec,
      callbackParams,
      expectedOrigin,
      actualOrigin,
      secrets.state,
      secrets.verifier,
    );
    this.vault.delete(record.flowId);
    if (!outcome.ok) {
      const kind = outcome.failureKind === "callback-origin" ? "callback-origin"
        : outcome.failureKind === "state-mismatch" ? "state-mismatch"
          : outcome.failureKind === "user-denied" ? "denied"
            : "token-exchange";
      const status = kind === "denied" ? "DENIED" : "FAILED";
      return toSafeFlowProjection(this.transition(record, status, kind === "denied" ? "denied" : kind));
    }
    try {
      await this.storeTokens(record, outcome.tokens.accessToken, outcome.tokens.refreshToken, undefined);
    } catch (error) {
      if (error instanceof ProviderAuthError && error.kind === "AUTH_CREDENTIAL_STORE_UNAVAILABLE") throw error;
      return toSafeFlowProjection(this.transition(record, "FAILED", "token-exchange"));
    }
    return toSafeFlowProjection(this.transition(record, "COMPLETE"));
  }

  /** Отменяет поток (только PENDING). Возвращает true при отмене. */
  public cancelAuthorization(flowId: string, sessionBinding: string): boolean {
    const record = this.requireFlow(flowId, sessionBinding);
    if (record.status !== "PENDING") return false;
    this.vault.delete(record.flowId);
    this.transition(record, "CANCELLED", "cancelled");
    return true;
  }

  /**
   * Отключает провайдера: отменяет активные потоки и удаляет локальные
   * credentials. Удалённый revoke не заявляется (в источнике endpoint
   * отсутствует) — результат `LOCAL_DISCONNECTED`.
   */
  public async disconnectProvider(providerId: string, sessionBinding: string): Promise<ProviderDisconnectResult> {
    const configuration = this.settingsRepository.getProviderConfiguration(providerId);
    if (!configuration) throw new ProviderConfigurationMissingError(providerId);

    for (const flow of this.store.listBySession(sessionBinding)) {
      if (flow.providerId === providerId && flow.status === "PENDING") {
        this.cancelAuthorization(flow.flowId, sessionBinding);
      }
    }

    const metadata = this.settingsRepository.listCredentialMetadata(providerId);
    const revokedRefs: string[] = [];
    for (const credential of metadata) {
      try {
        await this.credentialStore.deleteLocalCredential(providerId, credential.authMethodId);
      } catch (error) {
        if (error instanceof Error && error.name === "ProviderCredentialStoreUnavailableError") {
          throw new ProviderAuthError("AUTH_CREDENTIAL_STORE_UNAVAILABLE");
        }
        throw error;
      }
      revokedRefs.push(credential.referenceId);
    }
    return {
      providerId,
      localDisconnected: true,
      remoteRevoke: "LOCAL_DISCONNECTED",
      revokedCredentialRefs: revokedRefs,
    };
  }

  /** Выполняет refresh-ротацию. Возвращает только метаданные. */
  public async refreshCredential(providerId: string, methodId: string): Promise<TokenRefreshResult> {
    try {
      return await this.tokenRefresh.refreshCredential(providerId, methodId);
    } catch (error) {
      if (error instanceof NoRefreshStrategyError) throw new ProviderAuthError("AUTH_REFRESH_NO_STRATEGY");
      if (error instanceof CredentialExpiredError) throw new ProviderAuthError("AUTH_REFRESH_EXPIRED");
      if (error instanceof TransientRefreshError) throw new ProviderAuthError("AUTH_REFRESH_TRANSIENT");
      if (error instanceof ProviderCredentialMissingError) throw new ProviderAuthError("AUTH_CREDENTIAL_MISSING");
      throw error;
    }
  }

  /** Статусная проекция авторизации провайдера. */
  public getProviderAuthStatus(providerId: string, sessionBinding: string): ProviderAuthStatusProjection {
    const definition = getProvider(providerId);
    if (!definition) throw new ProviderAuthError("PROVIDER_UNKNOWN");
    const configuration = this.settingsRepository.getProviderConfiguration(providerId);
    const methodId = configuration?.selectedAuthMethod ?? definition.authMethods[0] ?? "api-key";
    const credential = this.settingsRepository.getCredentialMetadata(providerId, methodId);
    const flows = this.store.listBySession(sessionBinding).filter((flow) => flow.providerId === providerId);
    const projected = flows.map((flow) => toSafeFlowProjection(this.applyExpiry(flow)));
    return {
      providerId,
      methodId,
      hasCredential: credential !== undefined,
      credentialStatus: credential ? credential.status : "NONE",
      activeFlows: projected.filter((flow) => flow.status === "PENDING"),
      ...(projected.length > 0 ? { latestFlow: projected[projected.length - 1] } : {}),
    };
  }

  private applyExpiry(record: ProviderAuthFlowRecord): ProviderAuthFlowRecord {
    if (record.status === "PENDING" && isFlowExpired(record, this.now())) {
      return this.transition(record, "EXPIRED", "expired");
    }
    return record;
  }

  private requireFlow(flowId: string, sessionBinding: string): ProviderAuthFlowRecord {
    const record = this.store.get(flowId);
    if (!record) throw new ProviderAuthError("AUTH_FLOW_NOT_FOUND");
    if (record.sessionBinding !== sessionBinding) {
      throw new ProviderAuthError("AUTH_FLOW_SESSION_MISMATCH");
    }
    return record;
  }

  private transition(
    record: ProviderAuthFlowRecord,
    status: ProviderAuthFlowRecord["status"],
    failureKind?: ProviderAuthFlowRecord["failureKind"],
  ): ProviderAuthFlowRecord {
    const updated = this.store.update(record.flowId, {
      status,
      ...(failureKind ? { failureKind } : {}),
    });
    return updated ?? record;
  }

  private async storeTokens(
    record: ProviderAuthFlowRecord,
    accessToken: string,
    refreshToken: string | undefined,
    spec: OAuthDeviceCodeSpec | undefined,
  ): Promise<void> {
    const payload: Record<string, string> = {
      oauthAccessToken: accessToken,
      ...(refreshToken ? { oauthRefreshToken: refreshToken } : {}),
    };
    // Обмен короткоживущего bearer-токена выполняется только для Copilot
    // (tokenExchangeEndpoint карточки githubcopilot); для остальных
    // device-провайдеров токены хранятся как пара access/refresh.
    if (record.providerId === "githubcopilot" && spec?.tokenExchangeEndpoint) {
      const bearer = await this.deviceCodeFlow.exchangeCopilotBearer(spec, accessToken);
      if (bearer) payload.bearerToken = bearer;
    }
    await this.credentialStore.saveCredential(record.providerId, record.methodId, payload);
  }
}

function expectedOriginOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return redirectUri;
  }
}
