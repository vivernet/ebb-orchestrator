/**
 * Реализует безопасное хранилище секретов.
 * Если доступен OS keyring, секреты хранятся в нём, а SQLite сохраняет только
 * метаданные и reference ID; plaintext-секреты в SQLite не сохраняются.
 */

import type { Database } from '../database/database.js';

/** Сигнализирует, что production SecretStore не может безопасно выполнить операцию. */
export class SecretStoreUnavailableError extends Error {
  constructor() {
    super('Secret storage is unavailable');
    this.name = 'SecretStoreUnavailableError';
  }
}

/** Проверяет typed error без включения secret value в диагностическое сообщение. */
export function isSecretStoreUnavailableError(error: unknown): boolean {
  return error instanceof SecretStoreUnavailableError ||
    (error instanceof Error && error.name === 'SecretStoreUnavailableError');
}

/**
 * Результат сохранения секрета.
 */
export interface StoreResult {
  id: string;
  service: string;
  name: string;
}

/**
 * Метаданные сохранённого секрета без plaintext-значения.
 */
export interface SecretMetadata {
  referenceId: string;
  service: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Всегда отсутствует в метаданных; поле оставлено для optional type guard вызывающего кода. */
  value?: never;
}

/**
 * Интерфейс backend-реализаций хранилища секретов.
 */
export interface SecretStore {
  /** Сохраняет секрет и возвращает его reference ID. */
  store(service: string, name: string, value: string): Promise<StoreResult>;
  
  /** Находит секрет для указанного service и name. */
  resolveForService(service: string, name: string): Promise<string | undefined>;
  
  /** Отзывает и удаляет сохранённый секрет. */
  revoke(service: string, name: string): Promise<void>;
  
  /** Возвращает все секреты service только в виде метаданных. */
  listMetadata(service: string): Promise<SecretMetadata[]>;
}

/**
 * In-memory реализация хранилища секретов для тестов.
 * Секреты хранятся только в памяти и не сохраняются.
 */
export class InMemorySecretStore implements SecretStore {
  private values: Map<string, string> = new Map();
  private metadata: Map<string, SecretMetadata> = new Map();

  constructor(private db?: Database) {}

  private key(service: string, name: string): string {
    return `${service}:${name}`;
  }

  async store(service: string, name: string, value: string): Promise<StoreResult> {
    const id = this.generateId();
    const key = this.key(service, name);
    const now = Date.now();

    this.values.set(key, value);
    this.metadata.set(key, {
      referenceId: id,
      service,
      name,
      createdAt: now,
      updatedAt: now,
    });

    // Если доступна database, сохраняем только метаданные, не значение
    if (this.db) {
      this.db.run(
        `INSERT OR REPLACE INTO secrets (reference_id, service, name, created_at, updated_at)
         VALUES ($id, $service, $name, $created_at, $updated_at)`,
        { $id: id, $service: service, $name: name, $created_at: now, $updated_at: now }
      );
    }

    return { id, service, name };
  }

  async resolveForService(service: string, name: string): Promise<string | undefined> {
    const key = this.key(service, name);
    return this.values.get(key);
  }

  async revoke(service: string, name: string): Promise<void> {
    const key = this.key(service, name);
    this.values.delete(key);
    this.metadata.delete(key);
    if (this.db) {
      this.db.run(
        `DELETE FROM secrets WHERE service = $service AND name = $name`,
        { $service: service, $name: name }
      );
    }
  }

  async listMetadata(service: string): Promise<SecretMetadata[]> {
    const results: SecretMetadata[] = [];
    for (const meta of this.metadata.values()) {
      if (meta.service === service) {
        results.push(meta);
      }
    }
    return results;
  }

  async getMetadata(service: string, name: string): Promise<SecretMetadata | undefined> {
    return this.metadata.get(this.key(service, name));
  }

  async list(service: string): Promise<SecretMetadata[]> {
    return this.listMetadata(service);
  }

  private generateId(): string {
    // Простая генерация ID для тестов
    return `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
