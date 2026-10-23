/**
 * Таксономия ошибок провайдера.
 *
 * Модуль предоставляет стабильную классификацию ошибок, распознаваемых в
 * bounded фрагменте stderr установленного Hermes. Текст ошибок не хранится:
 * классификация вычисляется на лету и содержит только фиксированные категории,
 * severity, attribution и стабильные числовые идентификаторы.
 */

/** Семантический бакет ошибки для нарезки дашбордов и реакций. */
export type ErrorCategory =
  | "auth" // учётные данные, аккаунт, права доступа
  | "quota" // баланс, биллинг, лимиты плана
  | "capacity" // rate-limit, перегрузка, отсутствие канала
  | "request" // формат входа, context-window, capability
  | "safety" // модерация контента
  | "network" // таймаут, соединение
  | "stream" // сбои на уровне стримингового протокола
  | "provider" // общая бизнес-ошибка провайдера (catch-all)
  | "config"; // неверная конфигурация пользователя

/** Уровень значимости ошибки: подсказка для логирования и алертинга. */
export type ErrorSeverity = "info" | "warning" | "error" | "critical";

/** Владелец исправления ошибки. */
export type ErrorAttribution = "user" | "provider" | "harness" | "system";

/** Стабильные коды таксономии (append-only). */
export const PROVIDER_ERROR_CODES = [
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_ACCOUNT_DEACTIVATED",
  "QUOTA_INSUFFICIENT",
  "CAPACITY_RATE_LIMIT_EXCEEDED",
  "REQUEST_CONTEXT_WINDOW_EXCEEDED",
  "NETWORK_CONNECTION_REFUSED",
] as const;
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];

/** Спецификация кода таксономии. */
export interface ProviderErrorSpec {
  readonly code: ProviderErrorCode;
  /**
   * Стабильный append-only числовой идентификатор; публичный вид — `E{numericId}`.
   * Первая цифра задаёт категорию (1=auth … 9=config), остальные — порядковый
   * номер внутри категории. Опубликованная пара (код, numericId) не изменяется.
   */
  readonly numericId: number;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly attribution: ErrorAttribution;
  readonly retryable: boolean;
}

/**
 * Append-only реестр спецификаций. Новая запись добавляется только в конец;
 * существующие коды и их numericId остаются неизменными.
 */
export const PROVIDER_ERROR_SPECS: Readonly<Record<ProviderErrorCode, ProviderErrorSpec>> = Object.freeze({
  AUTH_INVALID_CREDENTIALS: {
    code: "AUTH_INVALID_CREDENTIALS", numericId: 1001, category: "auth",
    severity: "warning", attribution: "user", retryable: false,
  },
  AUTH_ACCOUNT_DEACTIVATED: {
    code: "AUTH_ACCOUNT_DEACTIVATED", numericId: 1007, category: "auth",
    severity: "warning", attribution: "user", retryable: false,
  },
  QUOTA_INSUFFICIENT: {
    code: "QUOTA_INSUFFICIENT", numericId: 2001, category: "quota",
    severity: "warning", attribution: "user", retryable: false,
  },
  CAPACITY_RATE_LIMIT_EXCEEDED: {
    code: "CAPACITY_RATE_LIMIT_EXCEEDED", numericId: 3001, category: "capacity",
    severity: "warning", attribution: "user", retryable: true,
  },
  REQUEST_CONTEXT_WINDOW_EXCEEDED: {
    code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", numericId: 4001, category: "request",
    severity: "warning", attribution: "user", retryable: false,
  },
  NETWORK_CONNECTION_REFUSED: {
    code: "NETWORK_CONNECTION_REFUSED", numericId: 6001, category: "network",
    severity: "error", attribution: "system", retryable: true,
  },
});

/** Готовая к включению в диагностику классификация (без текста ошибки). */
export interface ProviderErrorClassification {
  /** Стабильный публичный идентификатор вида `E1001`. */
  readonly id: string;
  readonly code: ProviderErrorCode;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  readonly attribution: ErrorAttribution;
  readonly retryable: boolean;
}

/** Одна запись реестра паттернов распознавания. */
interface ProviderErrorPattern {
  readonly code: ProviderErrorCode;
  readonly phrase: string;
  /** true — совпадение всего слова по границам; false — совпадение подстроки. */
  readonly wholeWord: boolean;
}

/**
 * Реестр паттернов: first-match-wins, поряок записи важен.
 * Паттерны сгруппированы по категориям в порядке убывания приоритета:
 * auth → quota → request → capacity → network. Приоритет повторяет прежние
 * проверки `classifyHermesStderr`, чтобы legacy-контракт не изменился.
 */
const ERROR_PATTERNS: readonly ProviderErrorPattern[] = [
  // auth: учётные данные
  { code: "AUTH_INVALID_CREDENTIALS", phrase: "401", wholeWord: true },
  { code: "AUTH_INVALID_CREDENTIALS", phrase: "unauthorized", wholeWord: true },
  { code: "AUTH_INVALID_CREDENTIALS", phrase: "authentication failed", wholeWord: true },
  { code: "AUTH_INVALID_CREDENTIALS", phrase: "invalid api key", wholeWord: true },
  { code: "AUTH_INVALID_CREDENTIALS", phrase: "invalid_api_key", wholeWord: false },
  // auth: аккаунт приостановлен/деактивирован
  { code: "AUTH_ACCOUNT_DEACTIVATED", phrase: "account is suspended", wholeWord: true },
  { code: "AUTH_ACCOUNT_DEACTIVATED", phrase: "account suspended", wholeWord: true },
  { code: "AUTH_ACCOUNT_DEACTIVATED", phrase: "account deactivated", wholeWord: true },
  { code: "AUTH_ACCOUNT_DEACTIVATED", phrase: "has been deactivated", wholeWord: true },
  { code: "AUTH_ACCOUNT_DEACTIVATED", phrase: "please reactivate", wholeWord: true },
  // quota: баланс / биллинг
  { code: "QUOTA_INSUFFICIENT", phrase: "insufficient balance", wholeWord: true },
  { code: "QUOTA_INSUFFICIENT", phrase: "insufficient quota", wholeWord: true },
  { code: "QUOTA_INSUFFICIENT", phrase: "quota exceeded", wholeWord: true },
  { code: "QUOTA_INSUFFICIENT", phrase: "billing hard limit", wholeWord: true },
  { code: "QUOTA_INSUFFICIENT", phrase: "insufficient credits", wholeWord: true },
  { code: "QUOTA_INSUFFICIENT", phrase: "account overdue", wholeWord: true },
  // request: превышение context-window
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "maximum context length", wholeWord: true },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "context length exceeded", wholeWord: true },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "context_length_exceeded", wholeWord: false },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "prompt is too long", wholeWord: true },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "input is too long", wholeWord: true },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "too many input tokens", wholeWord: true },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "context window exceeds", wholeWord: true },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "exceeds the context window", wholeWord: true },
  { code: "REQUEST_CONTEXT_WINDOW_EXCEEDED", phrase: "request too large for model", wholeWord: true },
  // capacity: rate-limit / перегрузка
  { code: "CAPACITY_RATE_LIMIT_EXCEEDED", phrase: "429", wholeWord: true },
  { code: "CAPACITY_RATE_LIMIT_EXCEEDED", phrase: "rate limit", wholeWord: true },
  { code: "CAPACITY_RATE_LIMIT_EXCEEDED", phrase: "rate_limit", wholeWord: false },
  { code: "CAPACITY_RATE_LIMIT_EXCEEDED", phrase: "too many requests", wholeWord: true },
  { code: "CAPACITY_RATE_LIMIT_EXCEEDED", phrase: "concurrency limit", wholeWord: true },
  { code: "CAPACITY_RATE_LIMIT_EXCEEDED", phrase: "request limit reached", wholeWord: true },
  // network: соединение / сеть
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "connection error", wholeWord: true },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "connection refused", wholeWord: true },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "network unreachable", wholeWord: true },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "name resolution", wholeWord: true },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "dns error", wholeWord: true },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "ssl error", wholeWord: true },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "econnrefused", wholeWord: false },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "socket hang up", wholeWord: true },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "getaddrinfo", wholeWord: false },
  { code: "NETWORK_CONNECTION_REFUSED", phrase: "connect etimedout", wholeWord: false },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternMatches(pattern: ProviderErrorPattern, text: string): boolean {
  if (pattern.wholeWord) {
    return new RegExp(`\\b${escapeRegExp(pattern.phrase)}\\b`, "u").test(text);
  }
  return text.includes(pattern.phrase);
}

/**
 * Классифицирует stderr-текст по таксономии. Возвращает первую подходящую
 * спецификацию или `undefined`, если текст не распознан. Текст ошибки нигде
 * не сохраняется — только классификация.
 */
export function classifyProviderError(stderr: string): ProviderErrorClassification | undefined {
  if (!stderr) return undefined;
  const text = stderr.slice(0, 8_192).toLowerCase();
  for (const pattern of ERROR_PATTERNS) {
    if (!patternMatches(pattern, text)) continue;
    const spec = PROVIDER_ERROR_SPECS[pattern.code];
    return {
      id: `E${spec.numericId}`,
      code: spec.code,
      category: spec.category,
      severity: spec.severity,
      attribution: spec.attribution,
      retryable: spec.retryable,
    };
  }
  return undefined;
}

/** Обнаруживаемый namespace предикатов классификации по тексту сообщения. */
export const ErrorClassifier = {
  /** Короткое окно rate-limit (RPM/TPM/concurrency); транзиентно, retryable. */
  isRateLimitExceeded(message: string): boolean {
    return classifyProviderError(message)?.code === "CAPACITY_RATE_LIMIT_EXCEEDED";
  },

  /** Prompt + tool payload превышает context-window модели. */
  isExceededContextWindow(message: string): boolean {
    return classifyProviderError(message)?.code === "REQUEST_CONTEXT_WINDOW_EXCEEDED";
  },

  /** Баланс аккаунта / биллинговая квота исчерпаны. */
  isInsufficientQuota(message: string): boolean {
    return classifyProviderError(message)?.code === "QUOTA_INSUFFICIENT";
  },

  /** Аккаунт провайдера приостановлен или деактивирован. */
  isAccountDeactivated(message: string): boolean {
    return classifyProviderError(message)?.code === "AUTH_ACCOUNT_DEACTIVATED";
  },

  /** Ошибка учётных данных (категория auth). */
  isAuthError(message: string): boolean {
    return classifyProviderError(message)?.category === "auth";
  },

  /** Ошибка сети/соединения (категория network). */
  isNetworkError(message: string): boolean {
    return classifyProviderError(message)?.category === "network";
  },
};
