import { describe, expect, it } from 'vitest';
describe('v1 security gate', () => {
  it('never permits real Hermes acceptance in ordinary CI', () => {
    expect(process.env.RUN_HERMES_E2E ?? '0').toBe('0');
  });
});
