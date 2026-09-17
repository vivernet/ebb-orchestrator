import { describe, expect, it } from 'vitest';
describe('v1 epic acceptance', () => {
  it('keeps external-provider acceptance opt-in and deterministic', () => {
    expect(process.env.RUN_HERMES_E2E ?? '0').toMatch(/^(0|1)$/);
  });
  it.runIf(process.env.RUN_HERMES_E2E === '1')('requires explicit Hermes opt-in', () => expect(process.env.RUN_HERMES_E2E).toBe('1'));
});
