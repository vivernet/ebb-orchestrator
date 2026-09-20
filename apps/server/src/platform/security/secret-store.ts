/**
 * Secure secret store implementation.
 * Secrets are stored in OS keyring when available, with SQLite only storing
 * metadata and reference IDs. No plaintext secrets are persisted in SQLite.
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
 * Result of storing a secret.
 */
export interface StoreResult {
  id: string;
  service: string;
  name: string;
}

/**
 * Metadata about a stored secret (no plaintext value).
 */
export interface SecretMetadata {
  referenceId: string;
  service: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Always absent from metadata; retained as an optional type guard for callers. */
  value?: never;
}

/**
 * Interface for secret storage backends.
 */
export interface SecretStore {
  /** Store a secret and return its reference ID. */
  store(service: string, name: string, value: string): Promise<StoreResult>;
  
  /** Resolve secrets for a specific service by name. */
  resolveForService(service: string, name: string): Promise<string | undefined>;
  
  /** Revoke (delete) a stored secret. */
  revoke(service: string, name: string): Promise<void>;
  
  /** List all secrets for a service (metadata only). */
  listMetadata(service: string): Promise<SecretMetadata[]>;
}

/**
 * In-memory secret store implementation for testing.
 * Secrets are kept in memory only - no persistence.
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

    // If database is available, store metadata only (not value)
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
    // Simple ID generation for testing
    return `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
