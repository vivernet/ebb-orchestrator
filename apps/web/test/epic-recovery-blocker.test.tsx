import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { apiClient } from '../src/api/client.js';
import EpicPage from '../src/features/epics/EpicPage.js';

afterEach(() => vi.restoreAllMocks());

describe('Epic recovery blocker projection', () => {
  it('shows a fixed recovery failure code instead of presenting the Epic as ordinary in progress', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      epic: { id: 'epic-1', title: 'Recovery Epic', status: 'IN_PROGRESS' },
      contract: null,
      lifecycle: { status: 'BLOCKED', stage: 'CHILDREN', updatedAt: '2026-09-30T00:00:00.000Z', recoveryFailureCode: 'EPIC_RECOVERY_FAILED', stages: [] },
      git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null },
      tasks: [], approvals: [], blockers: [], events: [],
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    });
    render(<EpicPage id="epic-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Восстановление Epic заблокировано');
    expect(screen.getByRole('alert')).toHaveTextContent('EPIC_RECOVERY_FAILED');
    expect(screen.getByRole('region', { name: 'Сведения об эпике' })).not.toHaveTextContent('Выполняется');
  });
});
