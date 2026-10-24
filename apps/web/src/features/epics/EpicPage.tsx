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
  const recoveryFailureCode = projection?.lifecycle?.recoveryFailureCode;
  const notFound = query.status === 'success' && projection?.epic === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);

  return (
    <div className="epic-page page-stack">
      <div className="topbar">
        <div>
          <h1>{`Эпик: ${epic?.title ?? epic?.display_id ?? id}`}</h1>
          {epic && <div className="sub">{statusLabel(recoveryFailureCode ? 'BLOCKED' : epic.status)}</div>}
        </div>
        {epic && <span className="badge accent">{statusLabel(recoveryFailureCode ? 'BLOCKED' : epic.status)}</span>}
      </div>
      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить эпик: ${errorMessage(query.error)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Эпик не найден." onRetry={retry} />}
      {recoveryFailureCode && <p role="alert">Восстановление Epic заблокировано. Код ошибки: <code>{recoveryFailureCode}</code>.</p>}
      {projection && !notFound && (
        <div className="grid2">
          <section aria-label="Жизненный цикл эпика и граф параллельной работы">
            <div className="panel-head"><h3>{ru.epics.lifecycleTitle}</h3></div>
            <p>{`${projection.lifecycle.stage ? epicStageLabel(projection.lifecycle.stage) : statusLabel(epic?.status)} · ${projection.tasks?.length ?? 0} задач`}</p>
            <ol aria-label="Этапы жизненного цикла эпика">
              {projection.lifecycle.stages?.map((stage) => <li key={stage.id} data-status={stage.status}>{epicStageLabel(stage.id)}: {statusLabel(stage.status)}</li>) ?? null}
            </ol>
            <div className="row"><span className="muted">Использование</span><span>{`${projection.usage.totalTokens} токенов · $${projection.usage.cost.toFixed(2)}`}</span></div>
          </section>
          <section aria-label="Контракт эпика">
            <div className="panel-head"><h3>{ru.epics.contractTitle}</h3></div>
            <p>{projection.contract ? JSON.stringify(projection.contract) : ru.epics.noContract}</p>
          </section>
          <section aria-label="Ветка / согласования / блокировки">
            <div className="panel-head"><h3>{ru.epics.branchTitle}</h3></div>
            <p>{`${projection.git.branch ?? 'Ветка не указана'} · ${projection.git.repositoryPath ?? 'Репозиторий не указан'} · ${projection.approvals.length} согласований · ${projection.blockers.length} блокировок`}</p>
            <div className="panel-head"><h3>{ru.epics.blockersTitle}</h3></div>
            <ul>
              {projection.blockers.length === 0 ? <li>Блокировок нет.</li> : projection.blockers.map((blocker) => <li key={blocker.id}>{blocker.reason ?? blocker.status}</li>)}
            </ul>
          </section>
          <section aria-label="События / проверка / контроль качества / слияние">
            <div className="panel-head"><h3>{ru.epics.eventsTitle}</h3></div>
            <p>{`${projection.events.length} событий`}</p>
            <ul>
              {projection.events.length === 0 ? <li>Событий нет.</li> : projection.events.map((event) => <li key={event.id}>{event.type} · <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></li>)}
            </ul>
          </section>
          <section aria-label="Задачи">
            <div className="panel-head"><h3>{ru.epics.tasksTitle}</h3></div>
            <ul>
              {projection.tasks.length === 0 ? <li>{ru.epics.tasksEmpty}</li> : projection.tasks.map((task) => {
                const label = task.title || task.display_id || task.id;
                return <li key={task.id}>{<Link to={`/tasks/${encodeURIComponent(task.id)}`}>{label}</Link>} · {statusLabel(task.status)}</li>;
              })}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
