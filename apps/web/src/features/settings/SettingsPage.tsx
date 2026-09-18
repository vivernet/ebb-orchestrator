import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

interface EffectiveHierarchy {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
  role: Record<string, Record<string, unknown>>;
  taskEpic: Record<string, unknown>;
}

interface SecuritySettings {
  mostRestrictiveWins: boolean;
  localModeEnabled: boolean;
}

interface SettingsData {
  effectiveHierarchy: EffectiveHierarchy;
  securitySettings: SecuritySettings;
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void apiClient.get<SettingsData>('/settings')
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div>Loading settings...</div>;
  }

  if (error || !data) {
    return <div>Error: {error ?? 'Data not available'}</div>;
  }

  const hierarchy = data.effectiveHierarchy;
  const security = data.securitySettings;

  return (
    <div className="settings-page">
      <h1>Settings</h1>

      <section aria-label="Configuration hierarchy">
        <h2>Effective Hierarchy</h2>
        <h3>Global</h3>
        <pre>{JSON.stringify(hierarchy.global, null, 2)}</pre>

        <h3>Project</h3>
        <pre>{JSON.stringify(hierarchy.project, null, 2)}</pre>

        <h3>Role</h3>
        <pre>{JSON.stringify(hierarchy.role, null, 2)}</pre>

        <h3>Task/Epic</h3>
        <pre>{JSON.stringify(hierarchy.taskEpic, null, 2)}</pre>
      </section>

      <section aria-label="Security settings">
        <h2>Security</h2>
        <p>
          <strong>Most-restrictive-wins:</strong> {security.mostRestrictiveWins ? 'Enabled' : 'Disabled'}
        </p>
        <p>
          <strong>Local Mode:</strong> {security.localModeEnabled ? 'Enabled' : 'Disabled'}
        </p>
        {security.localModeEnabled && (
          <div className="local-mode-warning" style={{ border: '1px solid red', padding: '8px', margin: '8px 0' }}>
            <p><strong>Warning: Local Mode</strong></p>
            <p>
              Local Mode allows untrusted code execution from repository scripts, tests, and package managers.
              The Orchestrator provides policy, tool, and credential isolation, but this is NOT OS-level sandboxing.
            </p>
            <p>
              Consider using Container Mode for stronger isolation when working with untrusted repositories.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
