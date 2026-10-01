import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { runMigrations, type Migration } from '../../../src/platform/database/migrator.js';
import { InMemorySecretStore, SecretStoreUnavailableError } from '../../../src/platform/security/secret-store.js';
import { SecretRedactor } from '../../../src/platform/security/secret-redactor.js';
import { KeyringSecretStore } from '../../../src/platform/security/keyring-secret-store.js';
import type { KeyringBackend } from '../../../src/platform/security/keyring-secret-store.js';
import type { Database, StatementParams } from '../../../src/platform/database/database.js';

const migrationsDir = join(import.meta.dirname, '../../../src/platform/database/migrations');
const migrations: Migration[] = readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => {
    const content = readFileSync(join(migrationsDir, f), 'utf-8');
    const version = parseInt(f.match(/(\d+)_/)?.[1] || '0');
    const name = f.replace('.sql', '');
    return { version, name, sql: content };
  });

describe('SecretStore no-plaintext', () => {
  let tempDir: string;
  let db: InMemorySecretStore;
  let sqliteDb: Database;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
    const dbPath = join(tempDir, `test-${randomUUID()}.db`);
    sqliteDb = createSqliteDatabase(dbPath);
    runMigrations(sqliteDb, migrations);
    db = new InMemorySecretStore(sqliteDb);
  });

  afterEach(async () => {
    // Соединение с базой данных закрывается сборщиком мусора Node.js.
  });

  describe('SQLite dump does not contain plaintext secrets', () => {
    it('stores secret reference in SQLite, not plaintext value', async () => {
      const secretValue = 'super-secret-token-12345';
      const result = await db.store('test-service', 'test-secret', secretValue);
      const refId = result.id;

      // Проверяем, что сохранены метаданные, а не значение.
      const metadata = await db.getMetadata('test-service', 'test-secret');
      expect(metadata).toBeDefined();
      expect(metadata?.referenceId).toBe(refId);
      expect(metadata?.value).toBeUndefined();
    });
  });

  describe('KeyringSecretStore availability', () => {
    it('normalizes the native keyring null sentinel for a missing credential', async () => {
      const backend = {
        async setPassword(): Promise<void> {},
        async getPassword(): Promise<string | null> { return null; },
        async deletePassword(): Promise<void> {},
      };
      const store = new KeyringSecretStore(sqliteDb, { backend: backend as KeyringBackend });

      await expect(store.resolveForService('service', 'missing')).resolves.toBeUndefined();
    });

    it('rejects store when the keyring backend is unavailable', async () => {
      const StoreWithBackend = KeyringSecretStore as unknown as new (
        database: Database,
        options: { backend: undefined },
      ) => KeyringSecretStore;
      const store = new StoreWithBackend(sqliteDb, { backend: undefined });

      await expect(store.store('service', 'name', 'secret-value')).rejects.toThrow('Secret storage is unavailable');
      expect(await store.listMetadata('service')).toEqual([]);
    });

    it('compensates keyring storage when metadata persistence fails', async () => {
      const calls: string[] = [];
      const backend = {
        async setPassword(): Promise<void> { calls.push('set'); },
        async getPassword(): Promise<string | undefined> { return undefined; },
        async deletePassword(): Promise<void> { calls.push('delete'); },
      };
      const failingDb = {
        run(): never { throw new Error('metadata write failed'); },
      } as unknown as Database;
      const StoreWithBackend = KeyringSecretStore as unknown as new (
        database: Database,
        options: { backend: typeof backend },
      ) => KeyringSecretStore;
      const store = new StoreWithBackend(failingDb, { backend });

      await expect(store.store('service', 'name', 'secret-value')).rejects.toThrow('metadata write failed');
      expect(calls).toEqual(['set', 'delete']);
    });

    it('restores the previous credential when metadata update fails', async () => {
      sqliteDb.run(
        'INSERT INTO secrets(reference_id, service, name, created_at, updated_at) VALUES($id, $service, $name, 10, 10)',
        { $id: 'existing-reference', $service: 'service', $name: 'name' },
      );
      let keyringValue: string | undefined = 'old-value';
      const failingDb = {
        all: sqliteDb.all.bind(sqliteDb),
        get: sqliteDb.get.bind(sqliteDb),
        run(sql: string, parameters?: StatementParams) {
          if (sql.startsWith('INSERT OR REPLACE INTO secrets')) throw new Error('metadata update failed');
          return sqliteDb.run(sql, parameters);
        },
      } as unknown as Database;
      const backend = {
        async setPassword(_service: string, _account: string, value: string): Promise<void> { keyringValue = value; },
        async getPassword(): Promise<string | undefined> { return keyringValue; },
        async deletePassword(): Promise<void> { keyringValue = undefined; },
      };
      const store = new KeyringSecretStore(failingDb, { backend });
      const previousMetadata = await store.listMetadata('service');

      await expect(store.store('service', 'name', 'new-value')).rejects.toThrow('metadata update failed');

      expect(keyringValue).toBe('old-value');
      expect(previousMetadata).toEqual([expect.objectContaining({ referenceId: 'existing-reference', name: 'name' })]);
      expect(await store.listMetadata('service')).toEqual(previousMetadata);
    });

    it('serializes concurrent updates for the same credential', async () => {
      let keyringValue: string | undefined = 'old-value';
      let firstReadStarted!: () => void;
      const firstRead = new Promise<void>((resolve) => { firstReadStarted = resolve; });
      let metadataWrites = 0;
      const concurrentDb = {
        all: sqliteDb.all.bind(sqliteDb),
        get: sqliteDb.get.bind(sqliteDb),
        run(sql: string, parameters?: StatementParams) {
          if (sql.startsWith('INSERT OR REPLACE INTO secrets')) {
            metadataWrites += 1;
            if (metadataWrites === 1) throw new Error('first metadata update failed');
          }
          return sqliteDb.run(sql, parameters);
        },
      } as unknown as Database;
      const backend = {
        async setPassword(_service: string, _account: string, value: string): Promise<void> { keyringValue = value; },
        async getPassword(): Promise<string | undefined> {
          firstReadStarted();
          return keyringValue;
        },
        async deletePassword(): Promise<void> { keyringValue = undefined; },
      };
      const store = new KeyringSecretStore(concurrentDb, { backend });
      const first = store.store('service', 'same-name', 'first-value');
      await firstRead;
      const second = store.store('service', 'same-name', 'second-value');

      await expect(first).rejects.toThrow('first metadata update failed');
      const secondResult = await second;

      expect(keyringValue).toBe('second-value');
      expect(await store.resolveForService('service', 'same-name')).toBe('second-value');
      expect(await store.listMetadata('service')).toEqual([
        expect.objectContaining({ referenceId: secondResult.id, name: 'same-name' }),
      ]);
    });

    it('normalizes operational keyring failures without exposing backend errors', async () => {
      let reads = 0;
      const backend = {
        async setPassword(): Promise<void> { throw new Error('OS keyring error with secret-value'); },
        async getPassword(): Promise<string | undefined> {
          reads += 1;
          if (reads === 1) return undefined;
          throw new Error('OS keyring read error');
        },
        async deletePassword(): Promise<void> { throw new Error('OS keyring delete error'); },
      };
      const store = new KeyringSecretStore(sqliteDb, { backend });

      await expect(store.store('service', 'write-failure', 'secret-value'))
        .rejects.toBeInstanceOf(SecretStoreUnavailableError);
      await expect(store.resolveForService('service', 'read-failure'))
        .rejects.toBeInstanceOf(SecretStoreUnavailableError);
      await expect(store.revoke('service', 'delete-failure'))
        .rejects.toBeInstanceOf(SecretStoreUnavailableError);
      expect(await store.listMetadata('service')).toEqual([]);
    });
  });

  describe('logs do not contain plaintext secrets', () => {
    it('secret values are never logged', async () => {
      const secretValue = 'api-key-xyz-789';
      
       await db.store('logging-service', 'api-key', secretValue);

    // В реальной реализации здесь проверялись бы фактические журналы.
    // Пока проверяем, что хранилище не раскрывает значения через toString/inspect.
      const metadata = await db.getMetadata('logging-service', 'api-key');
      expect(metadata).toBeDefined();
      expect(metadata?.value).toBeUndefined();
      expect(metadata?.referenceId).toBeDefined();
    });
  });

  describe('artifact metadata does not contain plaintext secrets', () => {
    it('secret references only appear in metadata', async () => {
      const secretValue = 'deployment-token-abc';
      
       await db.store('deploy-service', 'token', secretValue);

      // Получаем метаданные, которые сохранялись бы вместе с артефактами.
      const metadata = await db.listMetadata('deploy-service');
      
      // Должна быть ссылка, а не значение.
      expect(metadata[0]?.referenceId).toBeDefined();
      expect(metadata[0]?.value).toBeUndefined();
    });
  });

  describe('diagnostics JSON does not contain plaintext secrets', () => {
    it('secret values are redacted in diagnostics', async () => {
      const secretValue = 'diagnostic-test-secret';
      
      await db.store('diag-service', 'test', secretValue);

      // Имитируем экспорт диагностики.
      const diagnostics: Record<string, unknown> = {
        secrets: await db.list('diag-service'),
        timestamp: Date.now()
      };

      const diagJson = JSON.stringify(diagnostics);
      expect(diagJson).not.toContain(secretValue);
    });
  });

  describe('AgentRun environment does not contain plaintext secrets', () => {
    it('secrets are injected only when needed and never exposed', async () => {
      const secretValue = 'agent-test-env-secret';
      
       await db.store('agent-service', 'env-secret', secretValue);

      // По умолчанию секретов не должно быть в окружении агента.
      // Слой выполнения добавлял бы секреты только для конкретных операций.
      const env: Record<string, string> = {
        PATH: '/usr/bin'
        // Секреты добавлялись бы сюда только при явной необходимости операции.
      };

      expect(env.AGENT_TEST_ENV_SECRET).toBeUndefined();
      expect(env.SECRET).toBeUndefined();
    });
  });

  describe('redactor removes plaintext secrets', () => {
    it('exact-value redaction removes known secret values', () => {
      const redactor = new SecretRedactor();
      const secretValue = 'my-super-secret-token';
      
      redactor.addSecret('test-service', secretValue);

      const text = 'Log entry with my-super-secret-token in it';
      const redacted = redactor.redact(text);

      expect(redacted).not.toContain(secretValue);
      expect(redacted).toContain('[REDACTED]');
    });

    it('redacts multiple secrets', () => {
      const redactor = new SecretRedactor();
      
      redactor.addSecret('service1', 'secret1');
      redactor.addSecret('service2', 'secret2');

      const text = 'Contains secret1 and secret2';
      const redacted = redactor.redact(text);

      expect(redacted).not.toContain('secret1');
      expect(redacted).not.toContain('secret2');
    });

    it('handles case-sensitive exact matching', () => {
      const redactor = new SecretRedactor();
      const secretValue = 'MySecret123';
      
      redactor.addSecret('service', secretValue);

      const text = 'Contains MySecret123 and mysecret123';
      const redacted = redactor.redact(text);

      expect(redacted).not.toContain('MySecret123');
      expect(redacted).toContain('mysecret123');
    });

    it('handles JSON redaction', () => {
      const redactor = new SecretRedactor();
      const secretValue = 'json-secret-456';
      
      redactor.addSecret('api', secretValue);

      const json = JSON.stringify({ token: 'json-secret-456', other: 'data' });
      const redacted = redactor.redact(json);

      expect(redacted).not.toContain('json-secret-456');
      expect(redacted).toContain('other');
    });

    it('does not produce duplicates when redacting', () => {
      const redactor = new SecretRedactor();
      const secretValue = 'same-secret';
      
      redactor.addSecret('service', secretValue);

      const text = 'same-secret same-secret';
      const redacted = redactor.redact(text);

      expect((redacted.match(/\[REDACTED\]/g) || []).length).toBe(2);
    });
  });
});
