/**
 * Маппинг ошибок провайдеров в типизированные безопасные диагностики
 * (plan-24, Task 3).
 *
 * Классификация использует таксономию `provider-errors.ts` (append-only).
 * Инварианты:
 *  - сырой текст ошибки/ответа провайдера нигде не сохраняется и не
 *    экспортируется наружу — только фиксированные коды/категории;
 *  - `ProviderRuntimeError.message` содержит только стабильный код, а не
 *    текст ошибки провайдера.
 */

import {
  PROVIDER_ERROR_SPECS,
  type ErrorCategory,
  type ProviderErrorClassification,
  type ProviderErrorCode,
  type ProviderErrorSpec,
} from "../provider-errors.js";
import { ProviderGatewayError, type ProviderGatewayErrorKind } from "./provider-network-gateway.js";

/** Класс ошибки провайдера с классификацией. */
export class ProviderRuntimeError extends Error {
  public readonly classification: ProviderErrorClassification;
  public readonly code: ProviderErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ProviderErrorCode, message?: string) {
    const spec: ProviderErrorSpec = PROVIDER_ERROR_SPECS[code];
    super(message ?? `E${spec.numericId}:${code}`);
    this.name = "ProviderRuntimeError";
    this.code = code;
    this.classification = {
      id: `E${spec.numericId}`,
      code: spec.code,
      category: spec.category,
      severity: spec.severity,
      attribution: spec.attribution,
      retryable: spec.retryable,
    };
    this.retryable = spec.retryable;
  }
}

function classificationFor(spec: ProviderErrorSpec): ProviderErrorClassification {
  return {
    id: `E${spec.numericId}`,
    code: spec.code,
    category: spec.category,
    severity: spec.severity,
    attribution: spec.attribution,
    retryable: spec.retryable,
  };
}

/** Классификация по HTTP-статусу ответа провайдера. */
export function classifyHttpStatus(status: number): ProviderErrorClassification | undefined {
  if (status === 401 || status === 403) {
    return classificationFor(PROVIDER_ERROR_SPECS.AUTH_INVALID_CREDENTIALS);
  }
  if (status === 429) {
    return classificationFor(PROVIDER_ERROR_SPECS.CAPACITY_RATE_LIMIT_EXCEEDED);
  }
  if (status === 402 || status === 409) {
    // 402 Payment Required / 409 conflict (quota-подобные сценарии)
    return classificationFor(PROVIDER_ERROR_SPECS.QUOTA_INSUFFICIENT);
  }
  if (status === 400 || status === 413) {
    return classificationFor(PROVIDER_ERROR_SPECS.REQUEST_CONTEXT_WINDOW_EXCEEDED);
  }
  if (status >= 500) {
    return classificationFor(PROVIDER_ERROR_SPECS.PROVIDER_API_ERROR);
  }
  return undefined;
}

/** Классификация HTTP-ошибки по статусу и подсказкам тела (без текста наружу). */
export function classifyHttpError(status: number, hints?: {
  readonly auth?: boolean;
  readonly quota?: boolean;
  readonly rateLimit?: boolean;
  readonly contextWindow?: boolean;
}): ProviderErrorClassification {
  if (hints?.auth) return classificationFor(PROVIDER_ERROR_SPECS.AUTH_INVALID_CREDENTIALS);
  if (hints?.quota) return classificationFor(PROVIDER_ERROR_SPECS.QUOTA_INSUFFICIENT);
  if (hints?.rateLimit) return classificationFor(PROVIDER_ERROR_SPECS.CAPACITY_RATE_LIMIT_EXCEEDED);
  if (hints?.contextWindow) return classificationFor(PROVIDER_ERROR_SPECS.REQUEST_CONTEXT_WINDOW_EXCEEDED);
  return classifyHttpStatus(status) ?? classificationFor(PROVIDER_ERROR_SPECS.PROVIDER_API_ERROR);
}

/** Маппинг кодов шлюза на таксономию. */
const GATEWAY_ERROR_CODE_TO_TAXONOMY: Readonly<Record<ProviderGatewayErrorKind, ProviderErrorCode>> = {
  "malformed-url": "CONFIG_ENDPOINT_MISSING",
  "forbidden-destination": "NETWORK_FORBIDDEN_DESTINATION",
  "dns-resolution-failed": "NETWORK_DNS_RESOLUTION_FAILED",
  "redirect-policy": "NETWORK_FORBIDDEN_DESTINATION",
  timeout: "NETWORK_REQUEST_TIMEOUT",
  "response-too-large": "NETWORK_RESPONSE_TOO_LARGE",
  transport: "NETWORK_CONNECTION_REFUSED",
};

/** Классификация ошибки сетевого шлюза. */
export function classifyGatewayError(error: ProviderGatewayError): ProviderErrorClassification {
  const code = GATEWAY_ERROR_CODE_TO_TAXONOMY[error.kind] ?? "NETWORK_CONNECTION_REFUSED";
  return classificationFor(PROVIDER_ERROR_SPECS[code]);
}

/** Классификация низкоуровневой транспортной ошибки (по коду/признакам). */
export function classifyTransportError(error: unknown): ProviderErrorClassification {
  if (error instanceof ProviderGatewayError) return classifyGatewayError(error);
  if (error instanceof ProviderRuntimeError) return error.classification;
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (typeof code === "string") {
    const upper = code.toUpperCase();
    if (upper === "ECONNREFUSED" || upper === "ECONNRESET") {
      return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_CONNECTION_REFUSED);
    }
    if (upper === "ETIMEDOUT" || upper === "ESOCKETTIMEDOUT") {
      return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_REQUEST_TIMEOUT);
    }
    if (upper === "ENOTFOUND" || upper === "EAI_AGAIN" || upper === "DNS_LOOKUP_FAILED") {
      return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_DNS_RESOLUTION_FAILED);
    }
    if (upper === "CERT_HAS_EXPIRED" || upper === "DEPTH_ZERO_SELF_SIGNED_CERT" || upper === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
      return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_CONNECTION_REFUSED);
    }
  }
  if (lower.includes("dns") || lower.includes("getaddrinfo") || lower.includes("enotfound")) {
    return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_DNS_RESOLUTION_FAILED);
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_REQUEST_TIMEOUT);
  }
  if (lower.includes("refused") || lower.includes("econnrefused") || lower.includes("socket hang up")) {
    return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_CONNECTION_REFUSED);
  }
  return classificationFor(PROVIDER_ERROR_SPECS.NETWORK_CONNECTION_REFUSED);
}

/** Классификация ошибки парсинга ответа/стрима. */
export function classifyParseError(): ProviderErrorClassification {
  return classificationFor(PROVIDER_ERROR_SPECS.PROVIDER_RESPONSE_PARSE_ERROR);
}

/** Классификация ошибки протокола стрима. */
export function classifyStreamProtocolError(): ProviderErrorClassification {
  return classificationFor(PROVIDER_ERROR_SPECS.STREAM_PROTOCOL_ERROR);
}

/** Типизированная диагностика для RunOutcome.diagnostics.providerError. */
export function toProviderErrorDiagnostic(classification: ProviderErrorClassification): {
  readonly id: string;
  readonly code: ProviderErrorCode;
  readonly category: ErrorCategory;
} {
  return { id: classification.id, code: classification.code, category: classification.category };
}
