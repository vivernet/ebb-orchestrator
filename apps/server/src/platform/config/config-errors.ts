/**
 * Типы ошибок валидации конфигурации.
 */

/**
 * Предоставляет публичный контракт модуля config-errors для взаимодействия слоёв приложения.
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}
