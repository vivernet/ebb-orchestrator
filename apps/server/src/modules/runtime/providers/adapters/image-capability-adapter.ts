/**
 * Адаптеры image/video-провайдеров (plan-24, Task 3).
 *
 * Эти провайдеры (bfl, fal, replicate, comfyui) не поддерживают чат-провод.
 * Адаптеры существуют для конфигурации/каталога, но любой чат-запрос
 * завершается типизированной ошибкой `REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED`
 * (нет «тихого» скрытия: причина всегда точная).
 */

import { ProviderRuntimeError } from "../provider-error-mapper.js";
import type {
  ProviderChatAdapter,
  ProviderChatRequestInput,
  ProviderPreparedRequest,
  ProviderProtocolFamily,
  ProviderStreamParser,
} from "../provider-runtime-port.js";

export interface ImageCapabilityAdapterOptions {
  readonly providerId: string;
  readonly family: ProviderProtocolFamily;
  readonly capability: string;
}

/**
 * Создаёт адаптер image/video-провайдера (не-chat).
 */
export function createImageCapabilityAdapter(options: ImageCapabilityAdapterOptions): ProviderChatAdapter {
  const unsupported = (): never => {
    throw new ProviderRuntimeError(
      "REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED",
      `REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED:${options.providerId}:${options.capability}`,
    );
  };

  return {
    providerId: options.providerId,
    protocolFamily: options.family,
    auth: { kind: "none" },
    buildRequest(_input: ProviderChatRequestInput & { readonly endpoint: string }): ProviderPreparedRequest {
      return unsupported();
    },
    parseCompletion(_body: unknown): never {
      return unsupported();
    },
    createStreamParser(): ProviderStreamParser {
      return unsupported();
    },
  };
}
