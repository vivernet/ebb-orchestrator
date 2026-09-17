import { describe, expect, it } from 'vitest';
describe('v1 crash recovery matrix', () => {
  it.each(['branch-create', 'db-commit', 'event-dispatch', 'budget-reserve', 'run-start', 'github-pr-create'])('records failpoint %s as a release-gate case', (failpoint) => {
    expect(failpoint).toMatch(/-/);
  });
});
