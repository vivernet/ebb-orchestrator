import { useCallback } from 'react';
import { apiPaths, type EpicOverviewProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { ErrorAlert } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage, epicStageLabel, statusLabel, ru } from '../../i18n/ru.js';
import { useQuery } from '../../state/use-query.js';

interface EpicPageProps { id: string; }

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/** Представляет пользовательский экран EpicPage; авторитетные проверки выполняются backend. */
export default function EpicPage({ id }: EpicPageProps) {
  const epicPath = toClientPath(apiPaths.epic(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<EpicOverviewProjection>(epicPath, { signal }), [epicPath]);
  const query = useQuery(null, epicPath, undefined, fetcher);
  const projection = query.data;
  const epic = projection?.epic as { title?: string; display_id?: string; status?: string } | null | undefined;
  const notFound = query.status === 'success' && projection?.epic === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);

  return (
    <div className="epic-page">
      <h1>Эпик: {epic?.title ?? epic?.display_id ?? id}</h1>
      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить эпик: ${errorMessage(query.error)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Эпик не найден." onRetry={retry} />}
      <section aria-label="Сведения об эпике"><h2>Сведения</h2><p>{query.status === 'loading' || query.status === 'idle' ? 'Загрузка данных эпика…' : notFound ? 'Эпик не найден.' : epic ? `${statusLabel(epic.status)} · ${projection?.tasks?.length ?? 0} задач` : 'Данные эпика недоступны.'}</p>{projection && !notFound && <p>Использование: {projection.usage.totalTokens} токенов · ${projection.usage.cost.toFixed(2)}</p>}</section>
      <section aria-label="Жизненный цикл эпика и граф параллельной работы"><h2>Жизненный цикл / граф параллельной работы</h2><p>{notFound ? 'Жизненный цикл эпика недоступен.' : projection ? `${projection.lifecycle.stage ? epicStageLabel(projection.lifecycle.stage) : statusLabel(epic?.status)} · ${projection.tasks?.length ?? 0} задач` : 'Загрузка жизненного цикла эпика…'}</p><ol aria-label="Этапы жизненного цикла эпика">{projection && !notFound ? projection.lifecycle.stages?.map((stage) => <li key={stage.id} data-status={stage.status}>{epicStageLabel(stage.id)}: {statusLabel(stage.status)}</li>) : null}</ol></section>
      <section aria-label="Контракт эпика"><h2>Контракт эпика</h2><p>{notFound ? 'Контракт эпика недоступен.' : projection?.contract ? JSON.stringify(projection.contract) : query.status === 'success' ? 'Контракт не указан.' : 'Загрузка контракта эпика…'}</p></section>
      <section aria-label="Ветка и согласования эпика"><h2>Ветка / согласования / блокировки</h2><p>{notFound ? ru.epics.branchApprovalsUnavailable : projection ? `${projection.git.branch ?? 'Ветка не указана'} · ${projection.git.repositoryPath ?? 'Репозиторий не указан'} · ${projection.approvals.length} согласований · ${projection.blockers.length} блокировок` : 'Загрузка ветки и согласований эпика…'}</p></section>
      <section aria-label="События и этапы эпика"><h2>События / проверка / контроль качества / слияние</h2><p>{notFound ? 'События эпика недоступны.' : projection ? `${projection.events.length} событий` : 'Загрузка событий эпика…'}</p></section>
      <section aria-label="Задачи"><h2>Задачи</h2><ul>{notFound ? <li>Задачи недоступны.</li> : projection ? projection.tasks.length === 0 ? <li>Задач нет.</li> : projection.tasks.map((task) => { const label = task.title || task.display_id || task.id; return <li key={task.id}>{<Link to={`/tasks/${encodeURIComponent(task.id)}`}>{label}</Link>} · {statusLabel(task.status)}</li>; }) : <li>Загрузка задач…</li>}</ul></section>
    </div>
  );
}
