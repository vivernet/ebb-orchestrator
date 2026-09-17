import { createSign } from 'node:crypto';
import type { SecretStore } from '../../platform/security/secret-store.js';

export interface InstallationToken { token: string; expiresAt: number; }
export interface GitHubTokenProviderOptions { now?: () => number; fetch?: typeof globalThis.fetch; apiBase?: string; }

function base64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** Creates short-lived GitHub App installation tokens; secrets never leave this adapter. */
export class GitHubAppTokenProvider {
  private cached: InstallationToken | undefined;
  private readonly now: () => number;
  private readonly request: typeof globalThis.fetch;
  private readonly apiBase: string;

  constructor(private readonly secrets: SecretStore, options: GitHubTokenProviderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.request = options.fetch ?? globalThis.fetch;
    this.apiBase = options.apiBase ?? 'https://api.github.com';
  }

  async getToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - now > 30_000) return this.cached.token;
    const appId = await this.required('app-id');
    const privateKey = await this.required('private-key');
    const installationId = await this.required('installation-id');
    const issuedAt = Math.floor(now / 1000) - 30;
    const payload = { iat: issuedAt, exp: issuedAt + 540, iss: appId };
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = base64Url(JSON.stringify(payload));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    const jwt = `${header}.${body}.${signer.sign(privateKey, 'base64url')}`;
    const response = await this.request(`${this.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: 'POST', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub installation token request failed: ${response.status}`);
    const data = await response.json() as { token?: string; expires_at?: string };
    if (!data.token) throw new Error('GitHub installation token response did not contain a token');
    const expiresAt = data.expires_at ? Date.parse(data.expires_at) : now + 3_300_000;
    this.cached = { token: data.token, expiresAt };
    return data.token;
  }

  clearCache(): void { this.cached = undefined; }

  private async required(name: string): Promise<string> {
    const value = await this.secrets.resolveForService('github', name);
    if (!value) throw new Error(`Missing GitHub secret: ${name}`);
    return value;
  }
}
