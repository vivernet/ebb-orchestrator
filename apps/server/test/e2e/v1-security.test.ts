import { describe, expect, it } from 'vitest';
import { InMemorySecretStore } from '../../src/platform/security/secret-store.js';
import { SecretRedactor } from '../../src/platform/security/secret-redactor.js';
import { createLocalSession } from '../../src/platform/security/local-session.js';

describe('v1 security matrix', () => {
  it('keeps session and CSRF credentials distinct and ephemeral', () => {
    const first = createLocalSession({ host: '127.0.0.1', port: 3000 });
    const second = createLocalSession({ host: '127.0.0.1', port: 3000 });
    expect(first.token).not.toBe(first.csrfToken);
    expect(first.token).not.toBe(second.token);
    expect(first.csrfToken).not.toBe(second.csrfToken);
  });

  it('never exposes stored secret values through metadata', async () => {
    const store = new InMemorySecretStore();
    const value = 'v1-secret-value';
    const result = await store.store('v1', 'token', value);
    const metadata = await store.listMetadata('v1');
    expect(metadata).toEqual([{ referenceId: result.id, service: 'v1', name: 'token', createdAt: expect.any(Number), updatedAt: expect.any(Number) }]);
    expect(JSON.stringify(metadata)).not.toContain(value);
  });

  it('redacts exact secret values from diagnostics text', () => {
    const redactor = new SecretRedactor();
    redactor.addSecret('v1', 'private-value');
    expect(redactor.redact('error: private-value')).toBe('error: [REDACTED]');
  });
});
