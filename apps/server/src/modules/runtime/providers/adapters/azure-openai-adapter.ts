/**
 * Адаптер Azure OpenAI (plan-24, Task 3).
 *
 * Провод OpenAI-совместимый (`/openai/deployments/{deploymentName}/chat/completions`
 * с `api-version`); endpoint строится из config-полей resourceName/deploymentName
 * (см. resolveEndpoint в registry). Покрывает: azure, github (Azure-совместимый gateway).
 */

import type { ProviderChatAdapter } from "../provider-runtime-port.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

export interface AzureOpenAIAdapterOptions {
  readonly providerId: string;
  readonly apiVersion?: string;
}

/**
 * Создаёт адаптер Azure OpenAI.
 */
export function createAzureOpenAIAdapter(options: AzureOpenAIAdapterOptions): ProviderChatAdapter {
  return createOpenAICompatibleAdapter({
    providerId: options.providerId,
    family: "azure-openai",
    auth: { kind: "bearer" },
    chatPath: "/chat/completions",
    supportsStreaming: true,
    supportsToolCalls: true,
  });
}
