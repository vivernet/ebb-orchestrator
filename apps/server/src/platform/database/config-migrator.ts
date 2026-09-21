export type ConfigMigrationStatus = 'SUPPORTED' | 'USER_DECISION_REQUIRED' | 'UNSUPPORTED_NEWER_VERSION';
export interface ConfigMigrationResult<T = unknown> { status: ConfigMigrationStatus; config?: T; reason?: string; }
export interface VersionedConfig { schemaVersion: number; [key: string]: unknown; }

/** Безопасно отказывает для новых конфигураций и отклоняет неоднозначные семантические изменения. */
export class ConfigMigrator {
  constructor(private readonly supportedVersion: number) {}
  migrate<T extends VersionedConfig>(input: T): ConfigMigrationResult<T> {
    if (input.schemaVersion > this.supportedVersion) return { status: 'UNSUPPORTED_NEWER_VERSION', reason: 'configuration was created by a newer orchestrator' };
    if (input.schemaVersion < this.supportedVersion) return { status: 'USER_DECISION_REQUIRED', reason: 'semantic configuration migration requires approval' };
    return { status: 'SUPPORTED', config: input };
  }
}
