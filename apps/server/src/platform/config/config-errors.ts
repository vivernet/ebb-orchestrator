/**
 * Error types for configuration validation.
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
