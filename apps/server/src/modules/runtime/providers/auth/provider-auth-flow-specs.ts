/**
 * Спецификации OAuth-потоков провайдеров (plan-24, Task 4).
 *
 * Поля извлекаются из закреплённого источника LobeHub (commit
 * `d1ffc35de345c9a590f79a24ec1c0dbaf9f5d1b1`, provider cards `chatGPT.ts`,
 * `githubCopilot.ts`, `superGrok.ts`) и не являются секретами:
 * `clientId` — публичный идентификатор OAuth-клиента (без client secret),
 * endpoint URL и scopes — несекретная конфигурация провайдера.
 *
 * Инварианты:
 *  - для каждого провайдера каталога с методом `oauth-device-code` обязана
 *    существовать спецификация здесь (проверяется тестами);
 *  - метод `oauth-pkce` в инвентаризации 86 провайдеров отсутствует; движок
 *    PKCE реализован как общий механизм с mock-wire тестами и может быть
 *    подключён к любому провайдеру при появлении соответствующей карточки;
 *  - все запросы к этим endpoint выполняются только через ProviderNetworkGateway.
 */

import type { ProviderAuthMethod } from "../provider-types.js";

/** Спецификация OAuth Device Flow (RFC 8628). */
export interface OAuthDeviceCodeSpec {
  readonly kind: "oauth-device-code";
  /** Публичный OAuth client_id. */
  readonly clientId: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  /**
   * Endpoint обмена короткоживущего токена (GitHub Copilot mintet
   * bearer-токена из OAuth access token по требованию). Опционален.
   */
  readonly tokenExchangeEndpoint?: string;
  readonly scopes: readonly string[];
  readonly defaultPollingInterval: number;
  /** true — сервер поддерживает refresh_token grant (refreshTokenGrant). */
  readonly refreshTokenGrant: boolean;
}

/** Спецификация OAuth Authorization Code + PKCE. */
export interface OAuthPkceSpec {
  readonly kind: "oauth-pkce";
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scopes: readonly string[];
  /** Точный redirect URI; origin используется для проверки callback-origin. */
  readonly redirectUri: string;
}

export type ProviderAuthFlowSpec = OAuthDeviceCodeSpec | OAuthPkceSpec;

/** Спецификации device-flow провайдеров (закреплённый источник LobeHub). */
export const PROVIDER_DEVICE_CODE_SPECS: Readonly<Record<string, OAuthDeviceCodeSpec>> = Object.freeze({
  chatgpt: Object.freeze({
    kind: "oauth-device-code",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    deviceAuthorizationEndpoint: "https://auth.openai.com/api/accounts/deviceauth/usercode",
    tokenEndpoint: "https://auth.openai.com/oauth/token",
    tokenExchangeEndpoint: "https://auth.openai.com/api/accounts/deviceauth/token",
    scopes: [],
    defaultPollingInterval: 8,
    refreshTokenGrant: true,
  }),
  githubcopilot: Object.freeze({
    kind: "oauth-device-code",
    clientId: "Iv1.b507a08c87ecfe98",
    deviceAuthorizationEndpoint: "https://github.com/login/device/code",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    tokenExchangeEndpoint: "https://api.github.com/copilot_internal/v2/token",
    scopes: ["read:user"],
    defaultPollingInterval: 5,
    refreshTokenGrant: false,
  }),
  supergrok: Object.freeze({
    kind: "oauth-device-code",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
    tokenEndpoint: "https://auth.x.ai/oauth2/token",
    scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
    defaultPollingInterval: 5,
    refreshTokenGrant: true,
  }),
});

/**
 * Возвращает спецификацию OAuth-потока для провайдера/auth-метода.
 * Для `oauth-device-code` спецификации фиксированы в каталоге; для
 * `oauth-pkce` спецификация передаётся явно при создании потока (в текущей
 * инвентаризации нет карточки с PKCE).
 */
export function getAuthFlowSpec(providerId: string, methodId: string): ProviderAuthFlowSpec | undefined {
  if (methodId === "oauth-device-code") {
    return PROVIDER_DEVICE_CODE_SPECS[providerId];
  }
  return undefined;
}

/** Возвращает спецификацию device-flow или undefined для не-device методов. */
export function getDeviceCodeSpec(providerId: string): OAuthDeviceCodeSpec | undefined {
  return PROVIDER_DEVICE_CODE_SPECS[providerId];
}

/** Список провайдеров каталога с методом `oauth-device-code`. */
export function listDeviceCodeProviderIds(): readonly string[] {
  return Object.keys(PROVIDER_DEVICE_CODE_SPECS);
}

/** Публичные методы OAuth-потоков, которыми управляет Task 4. */
export const INTERACTIVE_AUTH_METHODS: readonly ProviderAuthMethod[] = Object.freeze(["oauth-device-code", "oauth-pkce"]);
