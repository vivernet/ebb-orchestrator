import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';
import { EmptyState, PageState } from '../../components/PageState.js';
import StatusBadge from '../../components/StatusBadge.js';

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
 * Представляет пользовательский экран ProjectOnboardingPage; авторитетные проверки выполняются backend.
 */
export default function ProjectOnboardingPage({ id }: { id: string }) {
  const [data, setData] = useState<OnboardingProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => Boolean(id));

  useEffect(() => {
    if (!id) {
      return;
    }

    void apiClient.get<OnboardingProject>(`/onboarding/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load onboarding data'))
      .finally(() => setLoading(false));
  }, [id]);

  if (!id) {
    return (
      <main className="project-onboarding-page">
        <h1>Project onboarding</h1>
        <EmptyState message="Select a project before opening its onboarding review. The current local API does not expose a project-discovery action, so this page never guesses an identifier or sends an invalid request." />
      </main>
    );
  }

  if (loading) {
    return <PageState status="loading" message="Loading onboarding data..." />;
  }

  if (error || !data) {
    return <PageState status="error" message={`Error: ${error ?? 'Data not available'}`} />;
  }

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
        <p>Status: <StatusBadge status={data.approvalStatus} label={data.approvalStatus} /></p>
        <p>Semantic config approved: {data.semanticConfigApproved ? 'Yes' : 'No'}</p>
      </section>

      <section aria-label="Security settings">
        <h2>Security</h2>
        <p>Local mode enabled: {data.localModeEnabled ? 'Yes' : 'No'}</p>
      </section>

      <section aria-label="Actions">
        <h2>Actions</h2>
        <p>
          Project activation is unavailable until the backend has a persisted semantic-approval authority. This view does not expose a client-side bypass for that policy.
        </p>
      </section>
    </div>
  );
}
