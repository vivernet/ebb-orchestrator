/** Provider-neutral Git hosting port. GitHub is an optional adapter, never workflow authority. */
export type GitHostingStatus = 'OK' | 'BLOCKED_AUTH' | 'BLOCKED_PERMISSION' | 'TRANSIENT_ERROR';

export interface IssueInput { title: string; body?: string; labels?: string[]; }
export interface PullRequestInput { head: string; base: string; title: string; body?: string; marker?: string; }
export interface PullRequest { id: number; number: number; url: string; state: 'open' | 'closed' | 'merged'; head: string; base: string; marker?: string; }
export interface HostingResult<T> { status: GitHostingStatus; value?: T; retryAt?: number; error?: string; }

export interface GitHosting {
  importIssues(repository: string): Promise<HostingResult<Array<{ id: number; title: string; body?: string; state: string }>>>;
  findPullRequest(repository: string, marker: string): Promise<HostingResult<PullRequest | undefined>>;
  createPullRequest(repository: string, input: PullRequestInput): Promise<HostingResult<PullRequest>>;
  updatePullRequest(repository: string, number: number, input: Partial<PullRequestInput>): Promise<HostingResult<PullRequest>>;
  mergePullRequest(repository: string, number: number, method?: 'merge' | 'squash' | 'rebase'): Promise<HostingResult<{ merged: boolean; sha?: string }>>;
  publishComment(repository: string, issueNumber: number, body: string, marker?: string): Promise<HostingResult<{ id: number }>>;
}
