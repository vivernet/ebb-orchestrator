/**
 * Адаптер LobeHub (plan-24, Task 3).
 *
 * Первый-party платформа: провод OpenAI-совместимый, credential —
 * subscription-токен (plan-token). Покрывает: lobehub.
 */

import type { ProviderChatAdapter } from "../provider-runtime-port.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

export interface LobeHubAdapterOptions {
  readonly providerId: string;
}

/**
 * Создаёт адаптер LobeHub (первый-party платформа).
 */
export function createLobeHubAdapter(options: LobeHubAdapterOptions): ProviderChatAdapter {
  return createOpenAICompatibleAdapter({
    providerId: options.providerId,
    family: "platform-cloud",
    auth: { kind: "bearer" },
    chatPath: "/chat/completions",
    supportsStreaming: true,
    supportsToolCalls: false,
  });
}
