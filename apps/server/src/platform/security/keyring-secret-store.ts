/**
 * Keyring-based secret store that uses @napi-rs/keyring on supported platforms.
 * Secrets are stored in the OS secure storage (keyring).
 * SQLite only stores metadata references.
 */

import { createRequire } from 'node:module';
import type { Database } from '../database/database.js';
import { SecretStoreUnavailableError, type SecretStore, type StoreResult, type SecretMetadata } from './secret-store.js';

/** Минимальный порт OS keyring, не позволяющий transport details проникнуть в domain. */
export interface KeyringBackend {
  setPassword(service: string, account: string, value: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | undefined>;
  deletePassword(service: string, account: string): Promise<void>;
}

export interface KeyringSecretStoreOptions {
  /** Явный backend нужен для deterministic tests; undefined означает fail-closed. */
  backend?: KeyringBackend | undefined;
}

/**
 * Реализует security boundary keyring-secret-store; входные данные должны пройти предусмотренные проверки доверия.
 */
export class KeyringSecretStore implements SecretStore {
  private readonly keyring: KeyringBackend | undefined;

  constructor(private db?: Database, options?: KeyringSecretStoreOptions) {
    if (options && Object.hasOwn(options, 'backend')) {
      this.keyring = options.backend;
      return;
    }

    try {
      const require = createRequire(import.meta.url);
      const { Entry } = require('@napi-rs/keyring') as {
        Entry: new (service: string, account: string) => {
          setPassword(value: string): void;
          getPassword(): string | undefined;
          deletePassword(): void;
        };
      };
      this.keyring = {
        async setPassword(service, account, value) {
          new Entry(service, account).setPassword(value);
        },
        async getPassword(service, account) {
          return new Entry(service, account).getPassword();
        },
        async deletePassword(service, account) {
          new Entry(service, account).deletePassword();
        },
      };
    } catch {
      this.keyring = undefined;
    }
  }

  private key(service: string, name: string): string {
    return `${service}/${name}`;
  }

  async store(service: string, name: string, value: string): Promise<StoreResult> {
    const id = `keyring_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const account = this.key(service, name);
    const now = Date.now();

    const keyring = this.requireKeyring();
    await keyring.setPassword(service, account, value);

    try {
      if (this.db) {
        this.db.run(
          `INSERT OR REPLACE INTO secrets (reference_id, service, name, created_at, updated_at)
           VALUES ($id, $service, $name, $created_at, $updated_at)`,
          { $id: id, $service: service, $name: name, $created_at: now, $updated_at: now }
        );
      }
    } catch (error) {
      try {
        await keyring.deletePassword(service, account);
      } catch {
        // Не скрывает исходную ошибку metadata и не сохраняет plaintext в логах.
      }
      throw error;
    }

    return { id, service, name };
  }

  async resolveForService(service: string, name: string): Promise<string | undefined> {
    const account = this.key(service, name);
    return this.requireKeyring().getPassword(service, account);
  }

  async revoke(service: string, name: string): Promise<void> {
    const account = this.key(service, name);
    await this.requireKeyring().deletePassword(service, account);
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

  private requireKeyring(): KeyringBackend {
    if (!this.keyring) throw new SecretStoreUnavailableError();
    return this.keyring;
  }
}
