import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import { apiErrorMessage, ru, statusLabel } from '../../i18n/ru.js';
import { onboardingApi, type OnboardingDiscoveryResult } from './api.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import UnsupportedBlock from '../../components/ui/Unavailable.js';

/**
 * Представляет экран онбординга проекта с полным flow: discovery → review → approve → activate.
 */
export default function OnboardingPage({ projectId }: { projectId?: string }) {
  const [repositoryPath, setRepositoryPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OnboardingDiscoveryResult | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
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

  const steps = ru.onboarding.steps;
  const stepIndex = !result ? 0 : result.status === 'DRAFT' ? 2 : result.status === 'APPROVAL_PENDING' ? 3 : 4;
  const renderSteps = () => (
    <ol className="steps" aria-label="Этапы онбординга">
      {steps.map((label, index) => (
        <li key={label} className={`step${index < stepIndex ? ' done' : ''}${index === stepIndex ? ' cur' : ''}`}>
          <div className="n">{index < stepIndex ? '✓' : index + 1}</div>
          <div className="t">{label}</div>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="onboarding-page reference-screen reference-screen--onboarding">
      <header className="topbar">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>Настройка проекта</h1>
          <div className="sub">{`Онбординг проекта · шаг ${Math.min(stepIndex + 1, 5)} из 5`}</div>
        </div>
      </header>
      {renderSteps()}
      {!result && <UnsupportedBlock reason="UI_NOT_IMPLEMENTED" label="Этапы 3–5 (проверка и активация)" />}

      {!result ? (
        <div className="onboarding-layout">
          <section className="reference-panel onboarding-form-panel" aria-label="Поиск проекта">
            <div className="section-heading"><h2>Выберите репозиторий</h2><span>Локальный путь</span></div>
            <p id="onboarding-instructions">Укажите путь к репозиторию. Сначала Orchestrator покажет обнаруженные факты и отдельно — предлагаемые настройки.</p>
            <form onSubmit={handleSubmit} aria-describedby="onboarding-instructions">
              <label htmlFor="repository-path">Путь к репозиторию</label>
              <input
                id="repository-path"
                type="text"
                value={repositoryPath}
                onChange={(e) => setRepositoryPath(e.target.value)}
                placeholder="C:\путь\к\репозиторию"
                required
                aria-required="true"
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? 'onboarding-error' : 'onboarding-instructions'}
              />
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Анализ…' : 'Начать анализ'}
              </button>
            </form>
            {error && (
              <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-label="Ошибка">
                <h2>Ошибка анализа</h2>
                <p id="onboarding-error">{error}</p>
                <button type="button" className="btn-ghost" onClick={() => setError(null)}>Очистить</button>
              </div>
            )}
          </section>
          <aside className="reference-panel onboarding-guidance">
            <h2>Перед активацией</h2>
            <p>Факты, найденные в репозитории, останутся отдельно от предложений конфигурации.</p>
            <p>Переходы согласования и активации выполняются только через backend и требуют подтверждённого состояния проекта.</p>
          </aside>
        </div>
      ) : (
        <section aria-label="Результаты анализа" className="onboarding-layout onboarding-results">
          <div className="reference-column">
            <section className="reference-panel" aria-label="Репозиторий и обнаруженные факты">
              <div className="section-heading"><h2>Репозиторий</h2><StatusBadge status={result.status} label={result.status} /></div>
              <p className="repository-path">{result.repository.path ?? 'Не обнаружен'}</p>
              <div className="reference-facts">
                <div><span>Основная ветка</span><strong>{result.detected.defaultBranch}</strong></div>
                <div><span>Менеджер пакетов</span><strong>{result.detected.packageManager}</strong></div>
                <div><span>Существующая конфигурация</span><strong>{result.detected.untrustedExistingConfig ? 'Обнаружена · не доверена' : 'Не обнаружена'}</strong></div>
              </div>
            </section>

            <section className="reference-panel" aria-label="Предложения координатора">
              <div className="section-heading"><h2>Предложения координатора</h2><span>Не утверждённая конфигурация</span></div>
              <div className="reference-facts">
                <div><span>Рабочий процесс</span><strong>{result.proposed?.workflow ?? 'Не указано'}</strong></div>
                <div><span>Роли</span><strong>{result.proposed?.roles.join(', ') || 'Не указаны'}</strong></div>
                <div><span>Рекомендации</span><strong>{result.proposed?.guidelines.length ? result.proposed.guidelines.join(', ') : 'Не указаны'}</strong></div>
              </div>
            </section>
          </div>

          <div className="reference-column">
            <section className="reference-panel" aria-label="Статус согласования">
              <div className="section-heading"><h2>Статус проекта</h2><StatusBadge status={result.status} label={statusLabel(result.status)} /></div>
              <p>Семантическая конфигурация утверждена: {result.status === 'APPROVED' || result.status === 'ACTIVE' ? 'Да' : 'Нет'}</p>
              {result.status === 'DRAFT' && <button type="button" className="btn-primary" onClick={handleRequestApproval} disabled={loading}>Запросить согласование</button>}
              {result.status === 'APPROVAL_PENDING' && <button type="button" className="btn-primary" onClick={handleApprove} disabled={loading}>Утвердить</button>}
              {result.status === 'APPROVED' && <button type="button" className="btn-primary" onClick={handleActivate} disabled={loading}>Активировать</button>}
              {result.status === 'ACTIVE' && <p role="status">Проект активирован.</p>}
            </section>
            {error && (
              <section ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-label="Ошибка" className="reference-panel">
                <h2>Не удалось продолжить онбординг</h2>
                <p>{error}</p>
              </section>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
