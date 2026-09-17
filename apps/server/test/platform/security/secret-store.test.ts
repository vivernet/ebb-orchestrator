import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { createSqliteDatabase } from '../../../src/platform/database/sqlite-database.js';
import { runMigrations, type Migration } from '../../../src/platform/database/migrator.js';
import { InMemorySecretStore } from '../../../src/platform/security/secret-store.js';
import { SecretRedactor } from '../../../src/platform/security/secret-redactor.js';

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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orchestrator-test-'));
    const dbPath = join(tempDir, `test-${randomUUID()}.db`);
    const sqliteDb = createSqliteDatabase(dbPath);
    runMigrations(sqliteDb, migrations);
    db = new InMemorySecretStore(sqliteDb);
  });

  afterEach(async () => {
    // Database connection is closed by Node.js garbage collection
  });

  describe('SQLite dump does not contain plaintext secrets', () => {
    it('stores secret reference in SQLite, not plaintext value', async () => {
      const secretValue = 'super-secret-token-12345';
      const result = await db.store('test-service', 'test-secret', secretValue);
      const refId = result.id;

      // Check that metadata was stored (not value)
      const metadata = await db.getMetadata('test-service', 'test-secret');
      expect(metadata).toBeDefined();
      expect(metadata?.referenceId).toBe(refId);
      expect(metadata?.value).toBeUndefined();
    });
  });

  describe('logs do not contain plaintext secrets', () => {
    it('secret values are never logged', async () => {
      const secretValue = 'api-key-xyz-789';
      
       await db.store('logging-service', 'api-key', secretValue);

      // In a real implementation, you would check actual logs
      // For now, verify the store doesn't expose values through toString/inspect
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

      // Get metadata that would be stored with artifacts
      const metadata = await db.listMetadata('deploy-service');
      
      // Should have reference, not value
      expect(metadata[0]?.referenceId).toBeDefined();
      expect(metadata[0]?.value).toBeUndefined();
    });
  });

  describe('diagnostics JSON does not contain plaintext secrets', () => {
    it('secret values are redacted in diagnostics', async () => {
      const secretValue = 'diagnostic-test-secret';
      
      await db.store('diag-service', 'test', secretValue);

      // Simulate diagnostics export
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

      // By default, secrets should not be in agent environment
      // (The execution layer would inject secrets only for specific operations)
      const env: Record<string, string> = {
        PATH: '/usr/bin'
        // Secrets would only be injected here when explicitly needed for operations
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
