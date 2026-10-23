/**
 * Адаптер OAuth/device-flow провайдеров (plan-24, Task 3).
 *
 * Провод OpenAI-совместимый; аутентификация — bearer-токен OAuth
 * (oauthAccessToken), управляемый auth-потоком Task 4. Отсутствие токена
 * завершается типизированной ошибкой `AUTH_DEVICE_FLOW_TOKEN_MISSING`
 * на этапе прикрепления credential (см. `attachCredentialToRequest`).
 * Покрывает: chatgpt, githubcopilot, supergrok.
 */

import type { ProviderChatAdapter } from "../provider-runtime-port.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

export interface OAuthDeviceAdapterOptions {
  readonly providerId: string;
}

/**
 * Создаёт адаптер OAuth/device-flow провайдера (OpenAI-совместимый провод).
 */
export function createOAuthDeviceAdapter(options: OAuthDeviceAdapterOptions): ProviderChatAdapter {
  return createOpenAICompatibleAdapter({
    providerId: options.providerId,
    family: "openai-compatible",
    auth: { kind: "bearer" },
    chatPath: "/chat/completions",
    supportsStreaming: true,
    supportsToolCalls: true,
  });
}
