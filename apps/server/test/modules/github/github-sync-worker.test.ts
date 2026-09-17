import { describe, expect, it, vi } from 'vitest';
import { GitHubSyncService } from '../../../src/modules/github/github-sync-service.js';
import type { GitHosting } from '../../../src/modules/github/git-hosting.js';

describe('GitHub sync idempotency', () => {
  it('discovers an existing PR after a crash instead of creating a duplicate', async () => {
    const hosting = {
      findPullRequest: vi.fn().mockResolvedValue({ status: 'OK', value: { id: 1, number: 7, url: 'u', state: 'open', head: 'h', base: 'main' } }),
      createPullRequest: vi.fn(),
    };
    const service = new GitHubSyncService(hosting as unknown as GitHosting);
    const result = await service.ensurePullRequest('o/r', 'task-1', { head: 'h', base: 'main', title: 'T' });
    expect(result.status).toBe('SUCCEEDED');
    expect(hosting.createPullRequest).not.toHaveBeenCalled();
  });
});
