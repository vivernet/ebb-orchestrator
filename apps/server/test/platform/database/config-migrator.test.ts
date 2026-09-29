import { describe, expect, it } from 'vitest';
import { ConfigMigrator } from '../../../src/platform/database/config-migrator.js';

describe('ConfigMigrator', () => {
  const current = { schemaVersion: 3, project: { defaultBranch: 'master' } };

  it('returns supported config without changing its values', () => {
    expect(new ConfigMigrator(3).migrate(current)).toEqual({ status: 'SUPPORTED', config: current });
  });

  it('requires a user decision for an older semantic config', () => {
    expect(new ConfigMigrator(3).migrate({ ...current, schemaVersion: 2 })).toMatchObject({
      status: 'USER_DECISION_REQUIRED',
    });
  });

  it('rejects a config from a newer application version', () => {
    expect(new ConfigMigrator(3).migrate({ ...current, schemaVersion: 4 })).toMatchObject({
      status: 'UNSUPPORTED_NEWER_VERSION',
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid schema version %s', (schemaVersion) => {
    expect(new ConfigMigrator(3).migrate({ ...current, schemaVersion })).toMatchObject({
      status: 'INVALID_VERSION',
    });
  });
});
