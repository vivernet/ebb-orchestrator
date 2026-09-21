/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

/**
 * Реализует security boundary secret-redactor; входные данные должны пройти предусмотренные проверки доверия.
 */
export class SecretRedactor {
  private secrets: Map<string, Set<string>> = new Map();

  /** Добавляет значение секрета для redaction в пределах service. */
  addSecret(service: string, value: string): void {
    if (!this.secrets.has(service)) {
      this.secrets.set(service, new Set());
    }
    this.secrets.get(service)!.add(value);
  }

  /** Удаляет из текста все известные секреты. */
  redact(text: string): string {
    let result = text;
    for (const [, values] of this.secrets.entries()) {
      for (const value of values) {
        if (value.length > 0) {
          // Выполняет соответствующую проверку или действие согласно контракту.
          const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped, 'g');
          result = result.replace(regex, '[REDACTED]');
        }
      }
    }
    return result;
  }

  /** Возвращает количество отслеживаемых секретов для service. */
  getSecretCount(service: string): number {
    return this.secrets.get(service)?.size ?? 0;
  }

  /** Возвращает все отслеживаемые секреты. */
  getAllSecrets(): Map<string, Set<string>> {
    return new Map(this.secrets);
  }
}
