/**
 * Адаптер Azure AI Inference (plan-24, Task 3).
 *
 * Провод OpenAI-совместимый (`/models/chat/completions` с `api-version`).
 * Покрывает: azureai.
 */

import type { ProviderChatAdapter } from "../provider-runtime-port.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

export interface AzureAIInferenceAdapterOptions {
  readonly providerId: string;
}

/**
 * Создаёт адаптер Azure AI Inference.
 */
export function createAzureAIInferenceAdapter(options: AzureAIInferenceAdapterOptions): ProviderChatAdapter {
  return createOpenAICompatibleAdapter({
    providerId: options.providerId,
    family: "azure-ai-inference",
    auth: { kind: "bearer" },
    chatPath: "/models/chat/completions",
    supportsStreaming: true,
    supportsToolCalls: true,
  });
}
