import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { onboardingApi, type OnboardingDiscoveryResult } from './api.js';

/** Легаси-статус согласования ранней версии онбординга (макеты и тесты). */
type ApprovalDecisionStatus = 'PENDING' | 'APPROVED';

/** Проекция для отображения: канонический контракт плюс допустимые легаси-поля. */
interface OnboardingView extends OnboardingDiscoveryResult {
  approvalStatus?: ApprovalDecisionStatus;
  semanticConfigApproved?: boolean;
  localModeEnabled?: boolean;
}

/**
 * Представляет пользовательский экран ProjectOnboardingPage; авторитетные проверки выполняются backend.
 * Обнаруженные факты о репозитории отделены от предложений координатора.
 */
export default function ProjectOnboardingPage({ id }: { id: string }) {
  const [data, setData] = useState<OnboardingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => Boolean(id));

  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void onboardingApi.get(id)
      .then((result) => { if (!cancelled) setData(result as OnboardingView); })
      .catch((e: unknown) => { if (!cancelled) setError(apiErrorMessage(e instanceof ApiError ? e.code : undefined)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  if (!id) {
    return (
      <main className="project-onboarding-page">
        <h1>Настройка проекта</h1>
        <EmptyState message="Выберите проект, чтобы открыть его проверку настройки. Текущий локальный API не предоставляет действие для поиска проекта, поэтому страница не подбирает идентификатор и не отправляет некорректный запрос." />
      </main>
    );
  }

  if (loading) {
    return <PageState status="loading" message="Загрузка данных настройки проекта…" />;
  }

  if (error || !data) {
    return <PageState status="error" message={`Ошибка: ${error ?? 'Данные недоступны'}`} />;
  }

  const detected = data.detected as typeof data.detected & {
    testFramework?: string | null;
    ebbOrchestratorConfigFound?: boolean;
  };
  const repository = data.repository as typeof data.repository & { remoteUrl?: string };
  const remoteLabel = repository.remoteUrl ?? repository.remotes.map((remote) => remote.url).join(', ');
  const detectedFramework = detected.testFramework ?? detected.testCommands?.join(', ') ?? null;
  const configFound = detected.ebbOrchestratorConfigFound ?? detected.untrustedExistingConfig;
  const approvalStatus = data.approvalStatus ?? data.approval?.status ?? null;
  const semanticApproved = data.semanticConfigApproved ?? (data.status === 'APPROVED' || data.status === 'ACTIVE');
  const localMode = data.localModeEnabled ?? false;
  const proposed = data.proposed;

  return (
    <div className="project-onboarding-page">
      <h1>Настройка проекта: {data.projectId}</h1>

      <section aria-label="Репозиторий">
        <h2>Репозиторий</h2>
        <p>{data.repository.path}{remoteLabel ? ` (${remoteLabel})` : ''}</p>
      </section>

      <section aria-label="Обнаруженные сведения">
        <h2>Обнаружено</h2>
        <p>Основная ветка: {detected.defaultBranch}</p>
        <p>Менеджер пакетов: {detected.packageManager ?? 'Не обнаружен'}</p>
        <p>Тестовый фреймворк: {detectedFramework ?? 'Не обнаружен'}</p>
        <p>Конфигурация Ebb Orchestrator найдена: {configFound ? 'Да' : 'Нет'}</p>
      </section>

      <section aria-label="Предложенные рекомендации">
        <h2>Предложено</h2>
        <p>Основная ветка: {proposed?.defaultBranch ?? 'Не указана'}</p>
        <p>Рабочий процесс: {proposed?.workflow ?? 'Не указан'}</p>
        <p>Роли: {proposed?.roles.join(', ') ?? 'Не указаны'}</p>
        <p>Рекомендаций: {proposed?.guidelines.length ?? 0}</p>
      </section>

      <section aria-label="Статус согласования">
        <h2>Статус согласования</h2>
        <p>Статус: <StatusBadge status={approvalStatus ?? 'PENDING'} label={approvalStatus ?? '—'} /></p>
        <p>Семантическая конфигурация утверждена: {semanticApproved ? 'Да' : 'Нет'}</p>
      </section>

      <section aria-label="Параметры безопасности">
        <h2>Безопасность</h2>
        <p>Локальный режим включён: {localMode ? 'Да' : 'Нет'}</p>
      </section>

      <section aria-label="Действия">
        <h2>Действия</h2>
        <p>
          Активация проекта недоступна, пока на сервере не появится сохранённый источник полномочий для семантического согласования. Этот экран не предоставляет обход этой политики на стороне клиента.
        </p>
      </section>
    </div>
  );
}
