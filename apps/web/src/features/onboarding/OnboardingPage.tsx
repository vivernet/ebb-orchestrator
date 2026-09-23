import { useState } from 'react';
import { onboardingApi, type OnboardingDiscoveryResult } from './api.js';
import StatusBadge from '../../components/ui/StatusBadge.js';

/**
 * Представляет экран онбординга проекта с полным flow: discovery → review → approve → activate.
 */
export default function OnboardingPage() {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OnboardingDiscoveryResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const discovery = await onboardingApi.discover(repositoryPath.trim());
      setResult(discovery);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка discovery');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestApproval = async () => {
    if (!result?.projectId) return;
    setLoading(true);
    setError(null);
    try {
      await onboardingApi.requestApproval(result.projectId);
      const refreshed = await onboardingApi.get(result.projectId);
      setResult(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запроса approval');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!result?.projectId) return;
    setLoading(true);
    setError(null);
    try {
      await onboardingApi.approve(result.projectId);
      const refreshed = await onboardingApi.get(result.projectId);
      setResult(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка утверждения');
    } finally {
      setLoading(false);
    }
  };

  const handleActivate = async () => {
    if (!result?.projectId) return;
    setLoading(true);
    setError(null);
    try {
      await onboardingApi.activate(result.projectId);
      const refreshed = await onboardingApi.get(result.projectId);
      setResult(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка активации');
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
              Введите абсолютный путь к локальному репозиторию для анализа.
            </p>
            <div>
              <label htmlFor="repository-path">Путь к репозиторию</label>
              <input
                id="repository-path"
                type="text"
                value={repositoryPath}
                onChange={(e) => setRepositoryPath(e.target.value)}
                placeholder="/path/to/repo"
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
              <button type="button" onClick={() => setError(null)}>Очистить</button>
            </section>
          )}
        </section>
      ) : (
        <section aria-label="Discovery results">
          <h2>Результаты анализа</h2>

          <section aria-label="Repository">
            <h3>Репозиторий</h3>
            <p>{result.repository.path ?? 'Не обнаружен'}</p>
          </section>

          <section aria-label="Detected">
            <h3>Обнаружено</h3>
            <p>Default branch: {result.detected.defaultBranch ?? 'Не обнаружен'}</p>
            <p>Package manager: {result.detected.packageManager ?? 'Не обнаружен'}</p>
            <p>Orchestrator config found: {result.detected.orchestratorConfigFound ? 'Да' : 'Нет'}</p>
          </section>

          <section aria-label="Proposed">
            <h3>Предложение</h3>
            <p>Workflow: {result.proposed.workflow ?? 'Не указано'}</p>
            <p>Roles: {result.proposed.roles.join(', ') || 'Не указано'}</p>
          </section>

          <section aria-label="Approval status">
            <h3>Статус утверждения</h3>
            <p>Status: <StatusBadge status={result.approvalStatus} label={result.approvalStatus} /></p>
            <p>Semantic config approved: {result.semanticConfigApproved ? 'Да' : 'Нет'}</p>
          </section>

          {result.approvalStatus === 'PENDING' && !result.semanticConfigApproved && (
            <section aria-label="Actions">
              <h3>Действия</h3>
              <button type="button" onClick={handleRequestApproval} disabled={loading}>
                Запросить approval
              </button>
            </section>
          )}

          {result.approvalStatus === 'APPROVED' && !result.semanticConfigApproved && (
            <section aria-label="Actions">
              <h3>Действия</h3>
              <button type="button" onClick={handleApprove} disabled={loading}>
                Утвердить
              </button>
            </section>
          )}

          {result.semanticConfigApproved && (
            <section aria-label="Actions">
              <h3>Действия</h3>
              <button type="button" onClick={handleActivate} disabled={loading}>
                Активировать
              </button>
            </section>
          )}

          {error && (
            <section aria-label="Error">
              <h2>Ошибка</h2>
              <p>{error}</p>
            </section>
          )}
        </section>
      )}
    </main>
  );
}
