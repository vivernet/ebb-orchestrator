/**
 * Каркас конвейера контекста.
 *
 * Конвейер последовательно применяет процессоры к общему {@link PipelineContext}.
 * Каждый процессор реализует жизненный цикл validate → doProcess → validate:
 * предварительная валидация входов, основная работа и пост-валидация результата.
 * Ошибки, возникшие на любом шаге, оборачиваются в {@link ContextProcessorError}
 * с сохранением исходного сообщения, поля `cause` и метода `toJSON()` для диагностики.
 */

import type { Message } from "../../context/context-types.js";

/** Минимальный контракт шага конвейера контекста. */
export interface ContextProcessor {
  /** Стабильное имя процессора для диагностики и отладки. */
  readonly name: string;

  /**
   * Применяет процессор к контексту.
   *
   * @param context Текущее состояние конвейера.
   * @returns Обновлённый контекст (тот же объект).
   * @throws {ContextProcessorError} Если validate/doProcess/validate завершились ошибкой.
   */
  process(context: PipelineContext): Promise<PipelineContext>;
}

/**
 * Состояние конвейера, передаваемое между процессорами.
 * `initialState` неизменяем; `messages`, `metadata`, `isAborted` и `abortReason`
 * обновляются процессорами по мере продвижения. При `isAborted === true`
 * выполнение последующих процессоров пропускается.
 */
export interface PipelineContext {
  /** Неизменяемые входные данные конвейера. */
  readonly initialState: unknown;
  /** Сообщения конвейера (например, фрагменты или финальный prompt). */
  messages: Message[];
  /** Служебные данные, накапливаемые процессорами. */
  metadata: Record<string, unknown>;
  /** При true выполнение последующих процессоров пропускается. */
  isAborted: boolean;
  /** Причина прерывания; заполняется при `isAborted === true`. */
  abortReason: string | null;
}

/** Опции конструктора {@link ContextProcessorError}. */
export interface ContextProcessorErrorOptions {
  /** Исходная ошибка, ставшая причиной обёртки. */
  readonly cause?: unknown;
  /** Имя процессора, в котором возникла ошибка. */
  readonly processor?: string;
  /** Стабильный машинный код ошибки (опционально). */
  readonly code?: string;
}

/** Структурированное JSON-представление {@link ContextProcessorError}. */
export interface ContextProcessorErrorJson {
  name: string;
  message: string;
  processor?: string;
  code?: string;
  cause?: unknown;
}

/**
 * Ошибка процессора конвейера контекста.
 * Сохраняет исходное сообщение ошибки, оборачиваемой через `cause`,
 * и предоставляет `toJSON()` для безопасной диагностики без потери причины.
 */
export class ContextProcessorError extends Error {
  /** Имя процессора, в котором возникла ошибка. */
  readonly processor: string | undefined;
  /** Стабильный машинный код ошибки. */
  readonly code: string | undefined;
  /** Исходная ошибка-причина (если была). */
  readonly cause: unknown;

  constructor(message: string, options: ContextProcessorErrorOptions = {}) {
    super(message);
    this.name = "ContextProcessorError";
    this.processor = options.processor;
    this.code = options.code;
    this.cause = options.cause;
  }

  /**
   * Возвращает структурированное представление ошибки для диагностики.
   * Причина сериализуется безопасно: вложенные ContextProcessorError — через
   * их `toJSON()`, обычные Error — через name/message, прочие значения — строкой.
   */
  toJSON(): ContextProcessorErrorJson {
    const json: ContextProcessorErrorJson = {
      name: this.name,
      message: this.message,
    };
    if (this.processor !== undefined) json.processor = this.processor;
    if (this.code !== undefined) json.code = this.code;
    if (this.cause !== undefined) json.cause = serializeCause(this.cause);
    return json;
  }
}

/**
 * Базовый класс процессора с жизненным циклом validate → doProcess → validate.
 * Подклассы реализуют `doProcess` и при необходимости `preValidate`/`postValidate`;
 * любые выброшенные ошибки оборачиваются в {@link ContextProcessorError}
 * с сохранением исходного сообщения и причины.
 */
export abstract class BaseProcessor implements ContextProcessor {
  /** Стабильное имя процессора для диагностики и отладки. */
  abstract readonly name: string;

  /**
   * Предварительная валидация перед основной работой.
   * Если метод бросает ошибку, `doProcess` и `postValidate` не выполняются.
   *
   * @param context Текущее состояние конвейера.
   */
  protected preValidate?(context: PipelineContext): void;

  /** Основная работа процессора. */
  protected abstract doProcess(context: PipelineContext): void;

  /**
   * Пост-валидация результата работы.
   *
   * @param context Текущее состояние конвейера после `doProcess`.
   */
  protected postValidate?(context: PipelineContext): void;

  /**
   * Асинхронный контракт {@link ContextProcessor}.
   */
  async process(context: PipelineContext): Promise<PipelineContext> {
    return this.run(context);
  }

  /**
   * Синхронный драйвер жизненного цикла validate → doProcess → validate.
   * Используется там, где асинхронность невозможна (например, внутри
   * SQLite-транзакции при подготовке контекста Run).
   *
   * @param context Текущее состояние конвейера.
   * @returns Тот же объект контекста после выполнения процессора.
   * @throws {ContextProcessorError} Если validate/doProcess/validate завершились ошибкой.
   */
  run(context: PipelineContext): PipelineContext {
    if (context.isAborted) return context;
    try {
      this.preValidate?.(context);
      this.doProcess(context);
      this.postValidate?.(context);
      return context;
    } catch (error) {
      throw wrapProcessorError(this.name, error);
    }
  }
}

function wrapProcessorError(processor: string, error: unknown): ContextProcessorError {
  if (error instanceof ContextProcessorError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ContextProcessorError(message, { cause: error, processor });
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof ContextProcessorError) return cause.toJSON();
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return String(cause);
}
