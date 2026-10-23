/**
 * Конвейер контекста.
 *
 * Последовательно применяет процессоры к общему {@link PipelineContext}.
 * Поддерживает асинхронный запуск (`run`) и синхронный драйвер (`runSync`)
 * для мест, где асинхронность невозможна (например, внутри SQLite-транзакции
 * при подготовке контекста Run). При `isAborted === true` конвейер останавливается
 * и возвращает текущий контекст без выполнения последующих процессоров.
 */

import { ContextProcessorError } from "./context-processor.js";
import type { ContextProcessor, PipelineContext } from "./context-processor.js";

/** Процессор, поддерживающий синхронное выполнение через `run`. */
export interface SyncContextProcessor extends ContextProcessor {
  /**
   * Синхронно применяет процессор к контексту.
   *
   * @param context Текущее состояние конвейера.
   * @returns Обновлённый контекст (тот же объект).
   */
  run(context: PipelineContext): PipelineContext;
}

/**
 * Конвейер контекста: упорядоченный набор процессоров над общим состоянием.
 */
export class ContextPipeline {
  /** Процессоры конвейера в порядке применения. */
  private readonly processors: readonly ContextProcessor[];

  /**
   * Создаёт конвейер с заданным порядком процессоров.
   *
   * @param processors Процессоры в порядке применения.
   */
  constructor(processors: readonly ContextProcessor[]) {
    this.processors = processors;
  }

  /**
   * Асинхронно выполняет все процессоры конвейера.
   * Останавливается при `isAborted === true`.
   *
   * @param context Начальное состояние конвейера.
   * @returns Финальное состояние после прохода всех процессоров.
   */
  async run(context: PipelineContext): Promise<PipelineContext> {
    let current = context;
    for (const processor of this.processors) {
      if (current.isAborted) break;
      current = await processor.process(current);
    }
    return current;
  }

  /**
   * Синхронно выполняет все процессоры конвейера.
   * Требует, чтобы каждый процессор реализовывал {@link SyncContextProcessor} (`run`);
   * иначе бросает {@link ContextProcessorError} с кодом `SYNC_PROCESSOR_REQUIRED`.
   *
   * @param context Начальное состояние конвейера.
   * @returns Финальное состояние после прохода всех процессоров.
   * @throws {ContextProcessorError} Если процессор не поддерживает синхронный `run`.
   */
  runSync(context: PipelineContext): PipelineContext {
    let current = context;
    for (const processor of this.processors) {
      if (current.isAborted) break;
      if (typeof (processor as SyncContextProcessor).run !== "function") {
        throw new ContextProcessorError(
          `Processor ${processor.name} does not implement synchronous run().`,
          {
            code: "SYNC_PROCESSOR_REQUIRED",
            processor: processor.name,
            cause: new TypeError("Sync pipeline requires processors implementing run()."),
          },
        );
      }
      current = (processor as SyncContextProcessor).run(current);
    }
    return current;
  }
}
