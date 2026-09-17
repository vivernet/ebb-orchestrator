/**
 * Secure secret store implementation.
 * Secrets are stored in OS keyring when available, with SQLite only storing
 * metadata and reference IDs. No plaintext secrets are persisted in SQLite.
 */

import type { Database } from '../database/database.js';

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
}

/**
 * Interface for secret storage backends.
 */
export interface SecretStore {
  /** Store a secret and return its reference ID. */
  set(service: string, name: string, value: string): Promise<StoreResult>;
  
  /** Retrieve a secret value by service and name. */
  get(service: string, name: string): Promise<string | undefined>;
  
  /** Get metadata about a stored secret (no value). */
  getMetadata(service: string, name: string): Promise<SecretMetadata | undefined>;
  
  /** List all secrets for a service. */
  list(service: string): Promise<SecretMetadata[]>;
  
  /** Delete a secret. */
  delete(service: string, name: string): Promise<void>;
}

/**
 * In-memory secret store implementation for testing.
 * Secrets are kept in memory only - no persistence.
 */
export class InMemorySecretStore implements SecretStore {
  private store: Map<string, string> = new Map();
  private metadata: Map<string, SecretMetadata> = new Map();

  constructor(private db?: Database) {}

  private key(service: string, name: string): string {
    return `${service}:${name}`;
  }

  async set(service: string, name: string, value: string): Promise<StoreResult> {
    const id = this.generateId();
    const key = this.key(service, name);
    const now = Date.now();

    this.store.set(key, value);
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

  async get(service: string, name: string): Promise<string | undefined> {
    const key = this.key(service, name);
    return this.store.get(key);
  }

  async getMetadata(service: string, name: string): Promise<SecretMetadata | undefined> {
    const key = this.key(service, name);
    return this.metadata.get(key);
  }

  async list(service: string): Promise<SecretMetadata[]> {
    const results: SecretMetadata[] = [];
    for (const [key, meta] of this.metadata.entries()) {
      if (meta.service === service) {
        results.push(meta);
      }
    }
    return results;
  }

  async delete(service: string, name: string): Promise<void> {
    const key = this.key(service, name);
    this.store.delete(key);
    this.metadata.delete(key);
    if (this.db) {
      this.db.run(
        `DELETE FROM secrets WHERE service = $service AND name = $name`,
        { $service: service, $name: name }
      );
    }
  }

  private generateId(): string {
    // Simple ID generation for testing
    return `sec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Keyring-based secret store that uses @napi-rs/keyring on supported platforms.
 * Secrets are stored in the OS secure storage (keyring).
 * SQLite only stores metadata references.
 */
export class KeyringSecretStore implements SecretStore {
  private keyring: { setPassword: (service: string, account: string, value: string) => Promise<void>; getPassword: (service: string, account: string) => Promise<string | undefined>; deletePassword: (service: string, account: string) => Promise<void>; } | undefined;

  constructor(private db?: Database) {
    // Try to load keyring - may not be available in all environments
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const keyring = require('@napi-rs/keyring');
      this.keyring = {
        setPassword: (service, account, value) => keyring.setPassword(service, account, value),
        getPassword: (service, account) => keyring.getPassword(service, account),
        deletePassword: (service, account) => keyring.deletePassword(service, account),
      };
    } catch {
      // Keyring not available - will need to use fallback
    }
  }

  private key(service: string, name: string): string {
    return `${service}/${name}`;
  }

  async set(service: string, name: string, value: string): Promise<StoreResult> {
    const id = `keyring_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const account = this.key(service, name);
    const now = Date.now();

    // Store in keyring
    if (this.keyring) {
      await this.keyring.setPassword(service, account, value);
    }

    // Store metadata in SQLite
    if (this.db) {
      this.db.run(
        `INSERT OR REPLACE INTO secrets (reference_id, service, name, created_at, updated_at)
         VALUES ($id, $service, $name, $created_at, $updated_at)`,
        { $id: id, $service: service, $name: name, $created_at: now, $updated_at: now }
      );
    }

    return { id, service, name };
  }

  async get(service: string, name: string): Promise<string | undefined> {
    if (!this.keyring) return undefined;
    const account = this.key(service, name);
    return this.keyring.getPassword(service, account);
  }

  async getMetadata(service: string, name: string): Promise<SecretMetadata | undefined> {
    if (!this.db) return undefined;
    const result = await this.db.get(
      `SELECT reference_id, service, name, created_at, updated_at FROM secrets WHERE service = ? AND name = ?`,
      [service, name]
    );
    return result ? {
      referenceId: result.reference_id,
      service: result.service,
      name: result.name,
      createdAt: result.created_at,
      updatedAt: result.updated_at,
    } : undefined;
  }

  async list(service: string): Promise<SecretMetadata[]> {
    if (!this.db) return [];
    const rows = await this.db.all(
      `SELECT reference_id, service, name, created_at, updated_at FROM secrets WHERE service = ?`,
      [service]
    );
    return rows.map(row => ({
      referenceId: row.reference_id,
      service: row.service,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async delete(service: string, name: string): Promise<void> {
    const account = this.key(service, name);
    if (this.keyring) {
      await this.keyring.deletePassword(service, account);
    }
    if (this.db) {
      this.db.run(
        `DELETE FROM secrets WHERE service = $service AND name = $name`,
        { $service: service, $name: name }
      );
    }
  }
}

/**
 * Redacts secret values from text (exact value matching).
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
