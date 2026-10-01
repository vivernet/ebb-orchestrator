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

  it('imports comments only from real Issues and follows pagination', async () => {
    const tokens = { getToken: vi.fn().mockResolvedValue('opaque'), clearCache: vi.fn() } as unknown as GitHubAppTokenProvider;
    const issuePageOne = Array.from({ length: 100 }, (_, index) => ({ number: index + 5 }));
    const commentPageOne = Array.from({ length: 100 }, (_, index) => ({
      id: index + 100,
      issue_url: 'https://api.github.com/repos/o/r/issues/106',
      body: 'older comment',
      user: { type: 'User' },
    }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(issuePageOne), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { number: 105 },
        { number: 106, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/106' } },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(commentPageOne), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 201, issue_url: 'https://api.github.com/repos/o/r/issues/105', html_url: 'https://github.com/o/r/issues/105#issuecomment-201', created_at: '2026-09-29T10:00:00Z', updated_at: '2026-09-29T10:01:00Z', body: 'human', user: { type: 'User', login: 'alice' } },
        { id: 202, issue_url: 'https://api.github.com/repos/o/r/issues/106', body: 'PR conversation', user: { type: 'User' } },
      ]), { status: 200 }));
    const adapter = new GitHubAdapter(tokens, { fetch });

    const result = await adapter.listIssueComments('o/r');

    expect(result).toEqual({ status: 'OK', value: [{ id: 201, issueNumber: 105, body: 'human', authorType: 'User', authorLogin: 'alice', sourceUrl: 'https://github.com/o/r/issues/105#issuecomment-201', sourceCreatedAt: '2026-09-29T10:00:00Z', sourceUpdatedAt: '2026-09-29T10:01:00Z' }] });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('page=1');
    expect(String(fetch.mock.calls[1]?.[0])).toContain('page=2');
    expect(String(fetch.mock.calls[2]?.[0])).toContain('page=1');
    expect(String(fetch.mock.calls[3]?.[0])).toContain('page=2');
  });
});
