import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { onboardingApi, type OnboardingDiscoveryResult } from './api.js';
import StatusBadge from '../../components/ui/StatusBadge.js';

/**
 * Представляет экран онбординга проекта с полным flow: discovery → review → approve → activate.
 */
export default function OnboardingPage({ projectId }: { projectId?: string }) {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OnboardingDiscoveryResult | null>(null);
  const errorRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
    else if (result) headingRef.current?.focus();
  }, [error, result]);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    void onboardingApi.get(projectId).then(setResult).catch((e: unknown) => setError(apiErrorMessage(e instanceof ApiError ? e.code : undefined))).finally(() => setLoading(false));
  }, [projectId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const discovery = await onboardingApi.discover(repositoryPath.trim());
      setResult(discovery);
    } catch (e) {
      setError(apiErrorMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setLoading(false);
    }
  };

  const handleRequestApproval = async () => {
    if (!result?.projectId) return;
    setLoading(true);
    setError(null);
    try {
      await onboardingApi.requestApproval(result.projectId, result.proposed ?? { defaultBranch: result.detected.defaultBranch, workflow: 'standard', roles: ['Developer'], guidelines: [] });
      const refreshed = await onboardingApi.get(result.projectId);
      setResult(refreshed);
    } catch (e) {
      setError(apiErrorMessage(e instanceof ApiError ? e.code : undefined));
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
      setError(apiErrorMessage(e instanceof ApiError ? e.code : undefined));
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
      setError(apiErrorMessage(e instanceof ApiError ? e.code : undefined));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="onboarding-page">
      <h1 ref={headingRef} tabIndex={-1}>Настройка проекта</h1>

      {!result ? (
        <section aria-label="Поиск проекта">
          <h2>Поиск проекта</h2>
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
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? 'onboarding-error' : 'onboarding-instructions'}
              />
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Анализ...' : 'Начать анализ'}
            </button>
          </form>

          {error && (
            <section ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-label="Ошибка">
              <h2>Ошибка</h2>
              <p>{error}</p>
              <button type="button" onClick={() => setError(null)}>Очистить</button>
            </section>
          )}
        </section>
      ) : (
        <section aria-label="Результаты анализа">
          <h2>Результаты анализа</h2>

          <section aria-label="Репозиторий">
            <h3>Репозиторий</h3>
            <p>{result.repository.path ?? 'Не обнаружен'}</p>
          </section>

          <section aria-label="Обнаружено">
            <h3>Обнаружено</h3>
            <p>Основная ветка: {result.detected.defaultBranch}</p>
            <p>Менеджер пакетов: {result.detected.packageManager}</p>
            <p>Конфигурация оркестратора найдена: {result.detected.untrustedExistingConfig ? 'Да' : 'Нет'}</p>
          </section>

          <section aria-label="Предложение">
            <h3>Предложение</h3>
            <p>Рабочий процесс: {result.proposed?.workflow ?? 'Не указано'}</p>
            <p>Роли: {result.proposed?.roles.join(', ') || 'Не указано'}</p>
          </section>

          <section aria-label="Статус согласования">
            <h3>Статус утверждения</h3>
            <p>Статус: <StatusBadge status={result.status} label={result.status} /></p>
            <p>Семантическая конфигурация утверждена: {result.status === 'APPROVED' || result.status === 'ACTIVE' ? 'Да' : 'Нет'}</p>
          </section>

          {result.status === 'DRAFT' && (
            <section aria-label="Действия">
              <h3>Действия</h3>
              <button type="button" onClick={handleRequestApproval} disabled={loading}>
                Запросить согласование
              </button>
            </section>
          )}

          {result.status === 'APPROVAL_PENDING' && (
            <section aria-label="Действия">
              <h3>Действия</h3>
              <button type="button" onClick={handleApprove} disabled={loading}>
                Утвердить
              </button>
            </section>
          )}

          {result.status === 'APPROVED' && (
            <section aria-label="Действия">
              <h3>Действия</h3>
              <button type="button" onClick={handleActivate} disabled={loading}>
                Активировать
              </button>
            </section>
          )}

          {error && (
            <section ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-label="Ошибка">
              <h2>Ошибка</h2>
              <p>{error}</p>
            </section>
          )}
        </section>
      )}
    </main>
  );
}
