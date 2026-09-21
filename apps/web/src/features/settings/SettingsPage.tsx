import { useCallback, useMemo } from 'react';
import { apiPaths, type SettingsProjection } from '@ebb-orchestrator/contracts';
import { apiClient, toClientPath } from '../../api/client.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';

function valueOrUnavailable(value: unknown): string {
  return value === null || value === undefined ? 'Unavailable' : String(value);
}

/** Представляет read-only Settings projection; unsupported policy не выводится как факт. */
export default function SettingsPage() {
  const store = useMemo(() => createQueryStore(), []);
  const settingsPath = toClientPath(apiPaths.settings);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<SettingsProjection>(settingsPath, { signal }), [settingsPath]);
  const query = useQuery(store, settingsPath, undefined, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);

  if (query.status === 'loading' || query.status === 'idle') return <div>Loading settings...</div>;
  if (query.status === 'error' || !query.data) {
    return <div className="settings-page"><h1>Settings</h1><p role="alert">Unable to load settings: {query.error instanceof Error ? query.error.message : 'Data not available'}</p><button type="button" onClick={retry}>Retry</button></div>;
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
