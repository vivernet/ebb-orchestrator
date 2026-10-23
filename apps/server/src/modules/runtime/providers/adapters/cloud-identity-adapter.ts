/**
 * Адаптер-скелетон cloud-identity провайдеров (plan-24, Task 3).
 *
 * Покрывает: bedrock (aws-bedrock), vertexai (google-vertex).
 *
 * До включения/настройки cloud-identity (AWS SigV4 / Google ADC) любой
 * чат-запрос завершается типизированной ошибкой
 * `PROVIDER_CLOUD_IDENTITY_CREDENTIALS_UNAVAILABLE`. Вызовы не фейкаются
 * и не отправляются: конфигурация cloud-identity — отдельная задача
 * (Task 4/5), а не подмена credentials.
 */

import { ProviderRuntimeError } from "../provider-error-mapper.js";
import type {
  ProviderChatAdapter,
  ProviderChatRequestInput,
  ProviderPreparedRequest,
  ProviderProtocolFamily,
  ProviderStreamParser,
} from "../provider-runtime-port.js";

export interface CloudIdentityAdapterOptions {
  readonly providerId: string;
  readonly family: ProviderProtocolFamily;
}

/**
 * Создаёт адаптер-скелетон cloud-identity провайдера.
 */
export function createCloudIdentityAdapter(options: CloudIdentityAdapterOptions): ProviderChatAdapter {
  const unavailable = (): never => {
    throw new ProviderRuntimeError(
      "PROVIDER_CLOUD_IDENTITY_CREDENTIALS_UNAVAILABLE",
      `PROVIDER_CLOUD_IDENTITY_CREDENTIALS_UNAVAILABLE:${options.providerId}:${options.family}`,
    );
  };

  return {
    providerId: options.providerId,
    protocolFamily: options.family,
    auth: { kind: "none" },
    buildRequest(_input: ProviderChatRequestInput & { readonly endpoint: string }): ProviderPreparedRequest {
      return unavailable();
    },
    parseCompletion(_body: unknown): never {
      return unavailable();
    },
    createStreamParser(): ProviderStreamParser {
      return unavailable();
    },
  };
}
