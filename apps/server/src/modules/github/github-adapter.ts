import type { GitHosting, HostingResult, PullRequest, PullRequestInput } from './git-hosting.js';
import { GitHubAppTokenProvider } from './github-app-token-provider.js';

export interface GitHubAdapterOptions { fetch?: typeof globalThis.fetch; apiBase?: string; sleep?: (ms: number) => Promise<void>; maxRetries?: number; }

/** REST-адаптер GitHub с status-aware errors и bounded transient retries. */
export class GitHubAdapter implements GitHosting {
  private readonly request: typeof globalThis.fetch;
  private readonly apiBase: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  constructor(private readonly tokens: GitHubAppTokenProvider, options: GitHubAdapterOptions = {}) {
    this.request = options.fetch ?? globalThis.fetch;
    this.apiBase = options.apiBase ?? 'https://api.github.com';
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
  }

  async importIssues(repository: string): Promise<HostingResult<Array<{ id: number; title: string; body?: string; state: string }>>> {
    return this.call(`/repos/${repository}/issues?state=all`, 'GET');
  }
  async findPullRequest(repository: string, marker: string): Promise<HostingResult<PullRequest | undefined>> {
    const result = await this.call<Array<Record<string, unknown>>>(`/repos/${repository}/pulls?state=all&per_page=100`, 'GET');
    if (result.status !== 'OK' || !result.value) return result as unknown as HostingResult<PullRequest | undefined>;
    const row = result.value.find((item) => String(item.body ?? '').includes(marker));
    return { status: 'OK', value: row ? this.toPullRequest(row) : undefined };
  }
  async createPullRequest(repository: string, input: PullRequestInput): Promise<HostingResult<PullRequest>> {
    const result = await this.call<Record<string, unknown>>(`/repos/${repository}/pulls`, 'POST', input);
    return result.status === 'OK' && result.value ? { status: 'OK', value: this.toPullRequest(result.value) } : result as unknown as HostingResult<PullRequest>;
  }
  async updatePullRequest(repository: string, number: number, input: Partial<PullRequestInput>): Promise<HostingResult<PullRequest>> {
    const result = await this.call<Record<string, unknown>>(`/repos/${repository}/pulls/${number}`, 'PATCH', input);
    return result.status === 'OK' && result.value ? { status: 'OK', value: this.toPullRequest(result.value) } : result as unknown as HostingResult<PullRequest>;
  }
  async mergePullRequest(repository: string, number: number, method = 'merge'): Promise<HostingResult<{ merged: boolean; sha?: string }>> {
    return this.call(`/repos/${repository}/pulls/${number}/merge`, 'PUT', { merge_method: method });
  }
  async publishComment(repository: string, issueNumber: number, body: string, marker?: string): Promise<HostingResult<{ id: number }>> {
    return this.call(`/repos/${repository}/issues/${issueNumber}/comments`, 'POST', { body: marker ? `${marker}\n${body}` : body });
  }

  private async call<T = unknown>(path: string, method: string, body?: unknown): Promise<HostingResult<T>> {
    let attempt = 0;
    while (true) {
      try {
        const token = await this.tokens.getToken();
        const init: RequestInit = { method, headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await this.request(`${this.apiBase}${path}`, init);
        if (response.ok) return { status: 'OK', value: await response.json() as T };
        if (response.status === 401) { this.tokens.clearCache(); return { status: 'BLOCKED_AUTH', error: 'GitHub authentication failed' }; }
        if (response.status === 403) {
          const reset = response.headers.get('x-ratelimit-reset');
          if (reset && attempt < this.maxRetries) { await this.sleep(Math.max(0, Number(reset) * 1000 - Date.now())); attempt++; continue; }
          const result: HostingResult<T> = { status: 'BLOCKED_PERMISSION', error: 'GitHub permission denied' };
          if (reset) result.retryAt = Number(reset) * 1000;
          return result;
        }
        if (response.status === 429 || response.status >= 500) {
          if (attempt++ < this.maxRetries) { await this.sleep(100 * 2 ** attempt); continue; }
          return { status: 'TRANSIENT_ERROR', error: `GitHub request failed: ${response.status}` };
        }
        return { status: 'TRANSIENT_ERROR', error: `GitHub request failed: ${response.status}` };
      } catch (error) {
        if (attempt++ < this.maxRetries) { await this.sleep(100 * 2 ** attempt); continue; }
        return { status: 'TRANSIENT_ERROR', error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  private toPullRequest(row: Record<string, unknown>): PullRequest {
    const result: PullRequest = { id: Number(row.id), number: Number(row.number), url: String(row.html_url ?? row.url ?? ''), state: row.merged_at ? 'merged' : row.state === 'closed' ? 'closed' : 'open', head: String((row.head as Record<string, unknown> | undefined)?.ref ?? ''), base: String((row.base as Record<string, unknown> | undefined)?.ref ?? '') };
    const marker = String(row.body ?? '').match(/ORCHESTRATOR:[^\s]+/)?.[0];
    if (marker) result.marker = marker;
    return result;
  }
}
