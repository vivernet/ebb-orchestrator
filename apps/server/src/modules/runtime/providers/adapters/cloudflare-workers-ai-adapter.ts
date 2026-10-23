/**
 * Адаптер Cloudflare Workers AI (plan-24, Task 3).
 *
 * Провод OpenAI-совместимый: `/accounts/{accountId}/ai/v1/chat/completions`.
 * endpoint строится из config-поля accountId (см. resolveEndpoint в registry).
 * Покрывает: cloudflare.
 */

import type { ProviderChatAdapter } from "../provider-runtime-port.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

export interface CloudflareWorkersAIAdapterOptions {
  readonly providerId: string;
}

/**
 * Создаёт адаптер Cloudflare Workers AI.
 */
export function createCloudflareWorkersAIAdapter(options: CloudflareWorkersAIAdapterOptions): ProviderChatAdapter {
  return createOpenAICompatibleAdapter({
    providerId: options.providerId,
    family: "cloudflare-workers-ai",
    auth: { kind: "bearer" },
    chatPath: "/chat/completions",
    supportsStreaming: true,
    supportsToolCalls: true,
  });
}
