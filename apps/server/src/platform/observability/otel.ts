/**
 * Опциональная интеграция OpenTelemetry (OTLP HTTP: trace + metrics).
 *
 * Модуль включается только при наличии `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (check `isOtelEnabled`): без него `registerOtel` возвращает no-op shutdown,
 * а API-вызовы `@opentelemetry/api` остаются no-op. Это гарантирует,
 * что локальный запуск и тесты без экспортёра не меняют поведение сервера.
 *
 * Экспортируются только allowlisted атрибуты:
 * - `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
 *   (числовые токены; без model/provider ID, prompt, URL, headers,
 *   finish-reason и динамических пользовательских строк);
 * - constant service-атрибут `service.name`.
 *
 * Ошибки экспортёра никогда не блокируют startup/run и не меняют
 * бизнес-результат: все точки эмиссии best-effort, а shutdown
 * ограничен по времени (`OTEL_SHUTDOWN_TIMEOUT_MS`).
 */

import { metrics, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/** Статическое имя сервиса: постоянный атрибут `service.name`. */
export const OTEL_SERVICE_NAME = "ebb-orchestrator";

/** Статическое имя операции (span name) для Run-level gen_ai телеметрии. */
export const OTEL_OPERATION_RUN_SPAN_NAME = "gen_ai.client.operation";

/** Статическое имя операции (span name) для middleware-трейсинга HTTP. */
export const OTEL_HTTP_REQUEST_SPAN_NAME = "http.server.request";

/** Имя гистограммы длительности HTTP-запроса. */
export const OTEL_HTTP_REQUEST_DURATION_HISTOGRAM = "http.server.request.duration";

/** Allowlisted атрибут: входные токены. */
export const OTEL_GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";

/** Allowlisted атрибут: выходные токены. */
export const OTEL_GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";

const TRACER_NAME = OTEL_SERVICE_NAME;
const METER_NAME = OTEL_SERVICE_NAME;

/** Лимит ожидания flush/shutdown SDK, чтобы не блокировать lifecycle сервера. */
const OTEL_SHUTDOWN_TIMEOUT_MS = 3000;

/** Функция корректного завершения OTel SDK. */
export type ShutdownFn = () => Promise<void>;

/** Параметры регистрации OTel. */
export interface OtelOptions {
  /** Статическое имя сервиса для `service.name`; по умолчанию `ebb-orchestrator`. */
  serviceName?: string;
}

/**
 * Определяет, включён ли OTel экспорт: только при непустом
 * `OTEL_EXPORTER_OTLP_ENDPOINT` в окружении.
 *
 * @param env Окружение процесса; по умолчанию `process.env`.
 */
export function isOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === "string"
    && env.OTEL_EXPORTER_OTLP_ENDPOINT.trim().length > 0;
}

/**
 * Регистрирует OTel SDK (OTLP HTTP trace+metrics), если включён endpoint.
 *
 * Конфигурация экспортёров берётся из окружения SDK:
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`.
 * Без endpoint возвращает no-op shutdown и не создаёт SDK.
 *
 * @param options Параметры регистрации.
 * @returns Promise на функцию shutdown; shutdown ограничен по времени
 *          и никогда не бросает исключений.
 */
export async function registerOtel(options: OtelOptions = {}): Promise<ShutdownFn> {
  if (!isOtelEnabled()) return async () => {};
  // Сбрасываем глобальные no-op/ранее зарегистрированные провайдеры, чтобы
  // повторная регистрация SDK в одном процессе надёжно активировалась.
  trace.disable();
  metrics.disable();
  const sdk = new NodeSDK({
    serviceName: options.serviceName ?? OTEL_SERVICE_NAME,
    // Минимальный ресурс без авто-детекции: SDK собирает только
    // `service.name` + `telemetry.sdk.*` и не экспортирует process/host
    // атрибуты (process.pid, process.command_args, process.owner, host.*).
    autoDetectResources: false,
  });
  try {
    sdk.start();
  } catch {
    return async () => {};
  }
  return () => withShutdownTimeout(() => sdk.shutdown());
}

/**
 * Выполняет shutdown с ограничением по времени и без проброса ошибок.
 *
 * Если `shutdown` не завершился за `timeoutMs` мс (по умолчанию
 * `OTEL_SHUTDOWN_TIMEOUT_MS`), ожидание прерывается и функция резолвится.
 * Ошибки внутри `shutdown` игнорируются: shutdown не должен блокировать
 * завершение сервера.
 *
 * @param shutdown Функция корректного завершения OTel SDK.
 * @param timeoutMs Лимит ожидания в миллисекундах.
 */
export async function withShutdownTimeout(
  shutdown: () => Promise<void>,
  timeoutMs = OTEL_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Экспортёр недоступен: shutdown не должен блокировать завершение сервера.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Начинает middleware-трейсинг HTTP-запроса: span с постоянными
 * атрибутами и тайминг для гистограммы длительности.
 *
 * Возвращает финализатор: `finish()` вызывается в onResponse и
 * завершает span и записывает наблюдение гистограммы. Без
 * зарегистрированного SDK все операции no-op.
 */
export function beginHttpRequestTracing(): { finish(): void } {
  const startedNs = process.hrtime.bigint();
  const span = trace.getTracer(TRACER_NAME).startSpan(OTEL_HTTP_REQUEST_SPAN_NAME, {
    attributes: { [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME },
  });
  return {
    finish: () => {
      span.end();
      const durationSeconds = Number(process.hrtime.bigint() - startedNs) / 1e9;
      try {
        // Инструмент создаётся от текущего (актуального) meter provider:
        // кэширование инструмента между перерегистрациями SDK привело бы
        // к наблюдениям в устаревший/но-op provider.
        metrics.getMeter(METER_NAME)
          .createHistogram(OTEL_HTTP_REQUEST_DURATION_HISTOGRAM, {
            description: "Длительность HTTP-запроса в секундах.",
            unit: "s",
          })
          .record(durationSeconds);
      } catch {
        // Измерение метрик не является authority для ответа HTTP.
      }
    },
  };
}

/**
 * Эмитит Run-level gen_ai телеметрию: только allowlisted числовые токены
 * и constant service-атрибут. Без зарегистрированного SDK — no-op.
 *
 * Вызов никогда не бросает исключений: ошибка OTel не должна менять
 * или блокировать завершение Run (best-effort).
 *
 * @param inputTokens Количество входных токенов (неотрицательное целое).
 * @param outputTokens Количество выходных токенов (неотрицательное целое).
 */
export function recordGenAiUsageTelemetry(inputTokens: number, outputTokens: number): void {
  try {
    const span = trace.getTracer(TRACER_NAME).startSpan(OTEL_OPERATION_RUN_SPAN_NAME, {
      attributes: {
        [ATTR_SERVICE_NAME]: OTEL_SERVICE_NAME,
        [OTEL_GEN_AI_USAGE_INPUT_TOKENS]: inputTokens,
        [OTEL_GEN_AI_USAGE_OUTPUT_TOKENS]: outputTokens,
      },
    });
    span.end();
  } catch {
    console.error("[ebb-orchestrator] OTEL_GEN_AI_TELEMETRY_FAILED");
  }
}
