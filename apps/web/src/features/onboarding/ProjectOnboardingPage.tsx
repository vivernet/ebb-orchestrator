import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

interface OnboardingProject {
  projectId: string;
  repository: { path: string; remoteUrl: string };
  detected: {
    defaultBranch: string;
    packageManager: string | null;
    testFramework: string | null;
    orchestratorConfigFound: boolean;
  };
  proposed: {
    defaultBranch: string;
    workflow: string;
    roles: string[];
    guidelines: string[];
  };
  approvalStatus: 'PENDING' | 'APPROVED';
  semanticConfigApproved: boolean;
  localModeEnabled: boolean;
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export default function ProjectOnboardingPage({ id }: { id: string }) {
  const [data, setData] = useState<OnboardingProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void apiClient.get<OnboardingProject>(`/onboarding/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load onboarding data'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div>Loading onboarding data...</div>;
  }

  if (error || !data) {
    return <div>Error: {error ?? 'Data not available'}</div>;
  }

  const canActivate = data.semanticConfigApproved;

  return (
    <div className="project-onboarding-page">
      <h1>Project Onboarding: {data.projectId}</h1>

      <section aria-label="Repository">
        <h2>Repository</h2>
        <p>{data.repository.path} ({data.repository.remoteUrl})</p>
      </section>

      <section aria-label="DETECTED findings">
        <h2>DETECTED</h2>
        <p>Default branch: {data.detected.defaultBranch}</p>
        <p>Package manager: {data.detected.packageManager ?? 'Not detected'}</p>
        <p>Test framework: {data.detected.testFramework ?? 'Not detected'}</p>
        <p>Orchestrator config found: {data.detected.orchestratorConfigFound ? 'Yes' : 'No'}</p>
      </section>

      <section aria-label="PROPOSED recommendations">
        <h2>PROPOSED</h2>
        <p>Default branch: {data.proposed.defaultBranch}</p>
        <p>Workflow: {data.proposed.workflow}</p>
        <p>Roles: {data.proposed.roles.join(', ')}</p>
        <p>Guidelines: {data.proposed.guidelines.length}</p>
      </section>

      <section aria-label="Approval status">
        <h2>Approval Status</h2>
        <p>Status: {data.approvalStatus}</p>
        <p>Semantic config approved: {data.semanticConfigApproved ? 'Yes' : 'No'}</p>
      </section>

      <section aria-label="Security settings">
        <h2>Security</h2>
        <p>Local mode enabled: {data.localModeEnabled ? 'Yes' : 'No'}</p>
      </section>

      <section aria-label="Actions">
        <h2>Actions</h2>
        <button
          type="button"
          onClick={() => void apiClient.post(`/onboarding/${data.projectId}/activate`)}
          disabled={!canActivate}
        >
          Activate Project
        </button>
        {!canActivate && (
          <p>
            Cannot activate until semantic configuration is approved. Review the DETECTED vs PROPOSED findings above.
          </p>
        )}
      </section>
    </div>
  );
}
