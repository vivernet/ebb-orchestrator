import { useCallback } from 'react';
import { apiPaths, type SettingsProjection } from '@ebb-orchestrator/contracts';
import { apiClient, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/PageState.js';
import { useQuery } from '../../state/use-query.js';

function valueOrUnavailable(value: unknown): string {
  return value === null || value === undefined ? 'Unavailable' : String(value);
}

/** Представляет read-only Settings projection; unsupported policy не выводится как факт. */
export default function SettingsPage() {
  const settingsPath = toClientPath(apiPaths.settings);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<SettingsProjection>(settingsPath, { signal }), [settingsPath]);
  const query = useQuery(null, settingsPath, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Loading settings..." />;
  if (query.status === 'error' || !query.data) {
    return <PageState status="error" title="Settings" message={`Unable to load settings: ${query.error instanceof Error ? query.error.message : 'Data not available'}`} onRetry={retry} />;
  }

  const { global } = query.data.effectiveHierarchy;
  const security = query.data.securitySettings;

  return (
    <div className="settings-page">
      <h1>Settings</h1>

      <section aria-label="Configuration hierarchy">
        <h2>Effective Hierarchy</h2>
        <h3>Global</h3>
        <p>Schema version: {valueOrUnavailable(global.schemaVersion)}</p>
        <p>Global max: {valueOrUnavailable(global.globalMax)}</p>
        <p>Project max: {valueOrUnavailable(global.projectMax)}</p>
        <p>Role capacity: {global.roleCapacity ? JSON.stringify(global.roleCapacity) : 'Unavailable'}</p>

        <h3>Project</h3>
        <p>Unavailable: project overrides are not exposed by this read-only endpoint.</p>

        <h3>Role</h3>
        <p>Unavailable: role overrides are not exposed by this read-only endpoint.</p>

        <h3>Task/Epic</h3>
        <p>Unavailable: task/epic overrides are not exposed by this read-only endpoint.</p>
      </section>

      <section aria-label="Security settings">
        <h2>Security</h2>
        <p><strong>Most-restrictive-wins:</strong> {valueOrUnavailable(security.mostRestrictiveWins)}</p>
        <p><strong>Local Mode:</strong> {valueOrUnavailable(security.localModeEnabled)}</p>
        <p>Security policy details are unavailable in this read-only Settings projection.</p>
      </section>
    </div>
  );
}
