import type { GitHosting, GitHubIssueComment, HostingResult, PullRequest, PullRequestInput } from './git-hosting.js';
import { GitHubAppTokenProvider } from './github-app-token-provider.js';

export interface GitHubAdapterOptions { fetch?: typeof globalThis.fetch; apiBase?: string; sleep?: (ms: number) => Promise<void>; maxRetries?: number; }

interface RemoteIssueRecord { number: number; pull_request?: unknown; }
interface RemoteIssueCommentRecord { id: number; issue_url: string; body?: string | null; user?: { type?: string } | null; }

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
  /** Загружает комментарии реальных Issues, исключая discussion comments у pull requests. */
  async listIssueComments(repository: string): Promise<HostingResult<GitHubIssueComment[]>> {
    const issues = await this.callAllPages<RemoteIssueRecord>(`/repos/${repository}/issues?state=all`);
    if (issues.status !== 'OK' || !issues.value) return issues as unknown as HostingResult<GitHubIssueComment[]>;
    const issueNumbers = new Set(issues.value
      .filter((issue) => issue.pull_request === undefined && Number.isSafeInteger(issue.number))
      .map((issue) => issue.number));
    const comments = await this.callAllPages<RemoteIssueCommentRecord>(`/repos/${repository}/issues/comments`);
    if (comments.status !== 'OK' || !comments.value) return comments as unknown as HostingResult<GitHubIssueComment[]>;
    const mapped: GitHubIssueComment[] = [];
    for (const comment of comments.value) {
      const match = /\/issues\/(\d+)$/.exec(comment.issue_url);
      const issueNumber = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(comment.id) || !issueNumbers.has(issueNumber)) continue;
      mapped.push({
        id: comment.id,
        issueNumber,
        body: typeof comment.body === 'string' ? comment.body : '',
        authorType: typeof comment.user?.type === 'string' ? comment.user.type : 'Unknown',
      });
    }
    return { status: 'OK', value: mapped };
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

  private async callAllPages<T>(path: string): Promise<HostingResult<T[]>> {
    const values: T[] = [];
    for (let page = 1; page <= 1_000; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const result = await this.call<unknown>(`${path}${separator}per_page=100&page=${page}`, 'GET');
      if (result.status !== 'OK') return result as HostingResult<T[]>;
      if (!Array.isArray(result.value)) return { status: 'TRANSIENT_ERROR', error: 'GitHub returned an invalid list response' };
      values.push(...result.value as T[]);
      if (result.value.length < 100) return { status: 'OK', value: values };
    }
    return { status: 'TRANSIENT_ERROR', error: 'GitHub pagination exceeded the bounded page limit' };
  }

  private toPullRequest(row: Record<string, unknown>): PullRequest {
    const result: PullRequest = { id: Number(row.id), number: Number(row.number), url: String(row.html_url ?? row.url ?? ''), state: row.merged_at ? 'merged' : row.state === 'closed' ? 'closed' : 'open', head: String((row.head as Record<string, unknown> | undefined)?.ref ?? ''), base: String((row.base as Record<string, unknown> | undefined)?.ref ?? '') };
    const marker = String(row.body ?? '').match(/ORCHESTRATOR:[^\s]+/)?.[0];
    if (marker) result.marker = marker;
    return result;
  }
}
