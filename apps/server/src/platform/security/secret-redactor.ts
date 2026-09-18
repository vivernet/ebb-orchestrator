/**
 * Redacts secret values from text (exact value matching).
 */

/**
 * Реализует security boundary secret-redactor; входные данные должны пройти предусмотренные проверки доверия.
 */
export class SecretRedactor {
  private secrets: Map<string, Set<string>> = new Map();

  /** Add a secret value for redaction by service. */
  addSecret(service: string, value: string): void {
    if (!this.secrets.has(service)) {
      this.secrets.set(service, new Set());
    }
    this.secrets.get(service)!.add(value);
  }

  /** Redact all known secrets from text. */
  redact(text: string): string {
    let result = text;
    for (const [, values] of this.secrets.entries()) {
      for (const value of values) {
        if (value.length > 0) {
          // Escape special regex characters
          const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped, 'g');
          result = result.replace(regex, '[REDACTED]');
        }
      }
    }
    return result;
  }

  /** Get the number of secrets tracked for a service. */
  getSecretCount(service: string): number {
    return this.secrets.get(service)?.size ?? 0;
  }

  /** Get all tracked secrets. */
  getAllSecrets(): Map<string, Set<string>> {
    return new Map(this.secrets);
  }
}
