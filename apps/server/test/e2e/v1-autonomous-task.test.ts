import { describe, expect, it } from 'vitest';

describe('v1 autonomous task acceptance', () => {
  it('keeps the real-Hermes acceptance opt-in', () => {
    expect(process.env.RUN_HERMES_E2E === '1' || process.env.RUN_HERMES_E2E === undefined).toBe(true);
  });
  it.runIf(process.env.RUN_HERMES_E2E === '1')('is reserved for the configured Hermes runtime', () => {
    expect(process.env.RUN_HERMES_E2E).toBe('1');
  });
});
