/**
 * Keyring-based secret store that uses @napi-rs/keyring on supported platforms.
 * Secrets are stored in the OS secure storage (keyring).
 * SQLite only stores metadata references.
 */

import { createRequire } from 'node:module';
import type { Database } from '../database/database.js';
import type { SecretStore, StoreResult, SecretMetadata } from './secret-store.js';

/**
 * Реализует security boundary keyring-secret-store; входные данные должны пройти предусмотренные проверки доверия.
 */
export class KeyringSecretStore implements SecretStore {
  private keyring: { setPassword: (service: string, account: string, value: string) => Promise<void>; getPassword: (service: string, account: string) => Promise<string | undefined>; deletePassword: (service: string, account: string) => Promise<void>; } | undefined;

  constructor(private db?: Database) {
    // Try to load keyring - may not be available in all environments
    try {
      const require = createRequire(import.meta.url);
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

  async store(service: string, name: string, value: string): Promise<StoreResult> {
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

  async resolveForService(service: string, name: string): Promise<string | undefined> {
    if (!this.keyring) return undefined;
    const account = this.key(service, name);
    return this.keyring.getPassword(service, account);
  }

  async revoke(service: string, name: string): Promise<void> {
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

  async listMetadata(service: string): Promise<SecretMetadata[]> {
    if (!this.db) return [];
    const rows = await this.db.all<{ reference_id: string; service: string; name: string; created_at: number; updated_at: number }>(
      `SELECT reference_id, service, name, created_at, updated_at FROM secrets WHERE service = $service`,
      { service }
    );
    return rows.map(row => ({
      referenceId: row.reference_id,
      service: row.service,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
