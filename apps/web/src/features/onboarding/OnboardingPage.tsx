import { useState } from 'react';
import { apiClient, toClientPath } from '../../api/client.js';
import StatusBadge from '../../components/StatusBadge.js';
import { apiPaths } from '@ebb-orchestrator/contracts';

const onboardingDiscoverPath = toClientPath(apiPaths.onboardingDiscover);

interface OnboardingDiscoveryResult {
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
 * Инициализирует discovery по URL репозитория и возвращает предварительный анализ.
 * @param repositoryUrl URL репозитория (например, https://github.com/user/repo)
 * @returns Promise с результатом discovery
 */
async function initiateDiscovery(repositoryUrl: string): Promise<OnboardingDiscoveryResult> {
  const response = await apiClient.post<OnboardingDiscoveryResult>(onboardingDiscoverPath, { repositoryUrl });
  return response;
}

/**
 * Представляет экран онбординга проекта с формой discovery репозитория.
 */
export default function OnboardingPage() {
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OnboardingDiscoveryResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const discovery = await initiateDiscovery(repositoryUrl.trim());
      setResult(discovery);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка discovery');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="onboarding-page">
      <h1>Project Onboarding</h1>

      {!result ? (
        <section aria-label="Discover project">
          <h2>Discover project</h2>
          <form onSubmit={handleSubmit} aria-describedby="onboarding-instructions">
            <p id="onboarding-instructions">
              Введите URL репозитория для анализа и инициации наboarding.
            </p>
            <div>
              <label htmlFor="repository-url">URL репозитория</label>
              <input
                id="repository-url"
                type="url"
                value={repositoryUrl}
                onChange={(e) => setRepositoryUrl(e.target.value)}
                placeholder="https://github.com/user/repo"
                required
                aria-required="true"
              />
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Анализ...' : 'Начать анализ'}
            </button>
          </form>

          {error && (
            <section aria-label="Error">
              <h2>Ошибка</h2>
              <p>{error}</p>
              <button type="button" onClick={() => setError(null)}>Попытаться снова</button>
            </section>
          )}
        </section>
      ) : (
        <section aria-label="Discovery results">
          <h2>Результаты анализа</h2>

          <section aria-label="Repository">
            <h3>Репозиторий</h3>
            <p>{result.repository.path} ({result.repository.remoteUrl})</p>
          </section>

          <section aria-label="Detected">
            <h3>Обнаружено</h3>
            <p>Default branch: {result.detected.defaultBranch}</p>
            <p>Package manager: {result.detected.packageManager ?? 'Не обнаружен'}</p>
            <p>Test framework: {result.detected.testFramework ?? 'Не обнаружен'}</p>
            <p>Orchestrator config found: {result.detected.orchestratorConfigFound ? 'Да' : 'Нет'}</p>
          </section>

          <section aria-label="Proposed">
            <h3>Предложение</h3>
            <p>Default branch: {result.proposed.defaultBranch}</p>
            <p>Workflow: {result.proposed.workflow}</p>
            <p>Roles: {result.proposed.roles.join(', ')}</p>
            <p>Guidelines: {result.proposed.guidelines.length}</p>
          </section>

          <section aria-label="Approval status">
            <h3>Статус утверждения</h3>
            <p>Status: <StatusBadge status={result.approvalStatus} label={result.approvalStatus} /></p>
            <p>Semantic config approved: {result.semanticConfigApproved ? 'Да' : 'Нет'}</p>
          </section>
        </section>
      )}
    </main>
  );
}
