import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SecretStore } from '../../../src/platform/security/secret-store.js';
import { runKeyringSmoke } from '../../../scripts/keyring-smoke.js';

function createStore(options: { failAfterStore?: boolean; mismatchOnRead?: boolean; leaveEntryOnRevoke?: boolean } = {}) {
  let storedValue: string | undefined;
  const store: SecretStore = {
    async store(_service, _name, value) {
      storedValue = value;
      if (options.failAfterStore) throw new Error('simulated backend failure');
      return { id: 'ephemeral', service: 'test', name: 'test' };
    },
    async resolveForService() {
      if (options.mismatchOnRead && storedValue !== undefined) return 'mismatched-value';
      return storedValue;
    },
    async revoke() {
      if (!options.leaveEntryOnRevoke) storedValue = undefined;
    },
    async listMetadata() {
      return [];
    },
  };

  return { store, readStoredValue: () => storedValue };
}

describe('keyring production acceptance smoke', () => {
  it('stores, retrieves, revokes, and confirms absence without returning the value', async () => {
    const fake = createStore();

    await expect(runKeyringSmoke(fake.store)).resolves.toBeUndefined();
    expect(fake.readStoredValue()).toBeUndefined();
  });

  it('attempts and confirms cleanup after a failed retrieval check', async () => {
    const fake = createStore({ mismatchOnRead: true });

    await expect(runKeyringSmoke(fake.store)).rejects.toThrow('stage=retrieve cleanup=verified');
    expect(fake.readStoredValue()).toBeUndefined();
  });

  it('removes an entry even when store reports failure after writing it', async () => {
    const fake = createStore({ failAfterStore: true });

    await expect(runKeyringSmoke(fake.store)).rejects.toThrow('stage=store cleanup=verified');
    expect(fake.readStoredValue()).toBeUndefined();
  });

  it('fails closed when repeated cleanup cannot prove the entry was removed', async () => {
    const fake = createStore({ leaveEntryOnRevoke: true });

    await expect(runKeyringSmoke(fake.store)).rejects.toThrow('stage=verify-revoke cleanup=unverified');
    expect(fake.readStoredValue()).toBeDefined();
  });

  it('uses the isolated no-provider-secret OS matrix and runs the real smoke entrypoint', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../../../');
    const workflowPath = resolve(repositoryRoot, '.github/workflows/production-gates.yml');
    const workflowText = readFileSync(workflowPath, 'utf8');
    const keyringScript = readFileSync(resolve(repositoryRoot, 'apps/server/scripts/keyring-smoke.ts'), 'utf8');

    expect(workflowText).toContain('keyring-acceptance:');
    expect(workflowText).toContain('- os: ubuntu-latest');
    expect(workflowText).toContain('- os: windows-latest');
    expect(workflowText).toContain('pnpm exec tsx apps/server/scripts/keyring-smoke.ts');
    expect(workflowText).not.toMatch(/\$\{\{\s*secrets\./i);
    expect(keyringScript).toContain("await store.revoke(SERVICE, name)");
    expect(keyringScript).toContain("cleanup=verified");
    expect(keyringScript).not.toContain('process.stdout.write(value');
  });
});
