/**
 * Error types for configuration validation.
 */

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
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
