import { useEffect, useState } from 'react';
import { ApiError, apiClient } from '../../api/client.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';

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
      .catch((e: unknown) => setError(apiErrorMessage(e instanceof ApiError ? e.code : undefined)))
      .finally(() => setLoading(false));
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

  return (
    <div className="project-onboarding-page">
      <h1>Настройка проекта: {data.projectId}</h1>

      <section aria-label="Репозиторий">
        <h2>Репозиторий</h2>
        <p>{data.repository.path} ({data.repository.remoteUrl})</p>
      </section>

      <section aria-label="Обнаруженные сведения">
        <h2>Обнаружено</h2>
        <p>Основная ветка: {data.detected.defaultBranch}</p>
        <p>Менеджер пакетов: {data.detected.packageManager ?? 'Не обнаружен'}</p>
        <p>Тестовый фреймворк: {data.detected.testFramework ?? 'Не обнаружен'}</p>
        <p>Конфигурация оркестратора найдена: {data.detected.orchestratorConfigFound ? 'Да' : 'Нет'}</p>
      </section>

      <section aria-label="Предложенные рекомендации">
        <h2>Предложено</h2>
        <p>Основная ветка: {data.proposed.defaultBranch}</p>
        <p>Рабочий процесс: {data.proposed.workflow}</p>
        <p>Роли: {data.proposed.roles.join(', ')}</p>
        <p>Рекомендаций: {data.proposed.guidelines.length}</p>
      </section>

      <section aria-label="Статус согласования">
        <h2>Статус согласования</h2>
        <p>Статус: <StatusBadge status={data.approvalStatus} label={data.approvalStatus} /></p>
        <p>Семантическая конфигурация утверждена: {data.semanticConfigApproved ? 'Да' : 'Нет'}</p>
      </section>

      <section aria-label="Параметры безопасности">
        <h2>Безопасность</h2>
        <p>Локальный режим включён: {data.localModeEnabled ? 'Да' : 'Нет'}</p>
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
