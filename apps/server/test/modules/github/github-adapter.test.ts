import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { InMemorySecretStore } from '../../../src/platform/security/secret-store.js';
import { GitHubAppTokenProvider } from '../../../src/modules/github/github-app-token-provider.js';
import { GitHubAdapter } from '../../../src/modules/github/github-adapter.js';

describe('GitHub adapter', () => {
  it('refreshes an expired installation token without assuming token format', async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store('github', 'app-id', '123');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await secrets.store('github', 'private-key', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    await secrets.store('github', 'installation-id', '456');
    const tokenFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'opaque-token', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'opaque-token-2', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 }));
    const provider = new GitHubAppTokenProvider(secrets, { fetch: tokenFetch, now: () => Date.now() });
    expect(await provider.getToken()).toBe('opaque-token');
    provider.clearCache();
    expect(await provider.getToken()).toBe('opaque-token-2');
    expect(tokenFetch).toHaveBeenCalledTimes(2);
  });

  it('maps 401 and 403 to explicit blocked states', async () => {
    const tokens = { getToken: vi.fn().mockResolvedValue('opaque'), clearCache: vi.fn() } as unknown as GitHubAppTokenProvider;
    const unauthorized = new GitHubAdapter(tokens, { fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 401 })), maxRetries: 0 });
    expect((await unauthorized.importIssues('o/r')).status).toBe('BLOCKED_AUTH');
    const forbidden = new GitHubAdapter(tokens, { fetch: vi.fn().mockResolvedValue(new Response('{}', { status: 403 })), maxRetries: 0 });
    expect((await forbidden.importIssues('o/r')).status).toBe('BLOCKED_PERMISSION');
  });
});
