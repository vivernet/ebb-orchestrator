/**
 * Адаптер HuggingFace Inference (plan-24, Task 3).
 *
 * Провод OpenAI-совместимый (`/v1/chat/completions`).
 * Покрывает: huggingface.
 */

import type { ProviderChatAdapter } from "../provider-runtime-port.js";
import { createOpenAICompatibleAdapter } from "./openai-compatible-adapter.js";

export interface HuggingFaceInferenceAdapterOptions {
  readonly providerId: string;
}

/**
 * Создаёт адаптер HuggingFace Inference.
 */
export function createHuggingFaceInferenceAdapter(options: HuggingFaceInferenceAdapterOptions): ProviderChatAdapter {
  return createOpenAICompatibleAdapter({
    providerId: options.providerId,
    family: "huggingface-inference",
    auth: { kind: "bearer" },
    chatPath: "/chat/completions",
    supportsStreaming: true,
    supportsToolCalls: false,
  });
}
