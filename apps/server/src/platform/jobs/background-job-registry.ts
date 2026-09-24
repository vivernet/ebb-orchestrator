/**
 * Typed registry для регистрации и поиска обработчиков фоновых задач.
 */

import type { BackgroundJobRow, JobHandler } from "./job-types.js";

/**
 * Typed job type key.
 */
export type JobTypeKey = string;

/**
 * Typed payload type for a specific job type.
 */
export type JobPayloadMap = Record<JobTypeKey, unknown>;

/**
 * Interface for a typed background job.
 */
export interface TypedBackgroundJob<T extends JobTypeKey> {
  type: T;
  payload: JobPayloadMap[T];
}

/**
 * Registry для управления обработчиками фоновых задач.
 */
export class BackgroundJobRegistry {
  private readonly handlers: Map<JobTypeKey, JobHandler> = new Map();

  /**
   * Регистрирует обработчик для конкретного типа задачи.
   */
  register<T extends JobTypeKey>(type: T, handler: (job: BackgroundJobRow) => Promise<void>): void {
    if (this.handlers.has(type)) {
      throw new Error(`Handler for job type "${type}" is already registered`);
    }
    this.handlers.set(type, handler);
  }

  /**
   * Убирает обработчик для типа задачи.
   */
  unregister(type: JobTypeKey): void {
    this.handlers.delete(type);
  }

  /**
   * Проверяет, зарегистрирован ли обработчик для типа задачи.
   */
  hasHandler(type: JobTypeKey): boolean {
    return this.handlers.has(type);
  }

  /**
   * Получает обработчик для типа задачи.
   */
  getHandler(type: JobTypeKey): JobHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * Получает все зарегистрированные типы задач.
   */
  getRegisteredTypes(): JobTypeKey[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Сбрасывает все зарегистрированные обработчики.
   */
  clear(): void {
    this.handlers.clear();
  }
}
