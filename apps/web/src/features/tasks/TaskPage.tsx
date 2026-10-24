import { useCallback, useState } from 'react';
import { apiPaths, type TaskOverviewProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { ErrorAlert } from '../../components/ui/PageState.js';
import WorkflowTimeline, { TASK_LIFECYCLE_STAGES } from '../../components/WorkflowTimeline.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage, ru, statusLabel, waitReasonLabel } from '../../i18n/ru.js';
import { useQuery } from '../../state/use-query.js';

interface TaskPageProps { id?: string; }

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

type TaskTab = keyof typeof ru.tasks.tabs;

/**
 * Представляет пользовательский экран TaskPage; авторитетные проверки выполняются backend.
 */
export default function TaskPage({ id = '' }: TaskPageProps) {
  const [tab, setTab] = useState<TaskTab>('overview');
  const taskPath = toClientPath(apiPaths.task(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<TaskOverviewProjection>(taskPath, { signal }), [taskPath]);
  const query = useQuery(null, taskPath, undefined, fetcher, { enabled: Boolean(id) });
  const projection = query.data;
  const task = projection?.task as { title?: string; display_id?: string; status?: string; project_id?: string; epic_id?: string | null } | null | undefined;
  const notFound = query.status === 'success' && projection?.task === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);
  const contract = notFound ? 'Контракт задачи недоступен.' : projection?.contract ? JSON.stringify(projection.contract) : query.status === 'success' ? ru.tasks.noContract : ru.tasks.loadingContract;

  return (
    <div className="task-page page-stack">
      <div className="topbar">
        <div>
          <h1>{`Задача: ${(task?.title ?? task?.display_id ?? id) || ru.common.loading}`}</h1>
          {task && <div className="sub">{statusLabel(task.status)}</div>}
        </div>
        {task && <span className="badge accent">{statusLabel(task.status)}</span>}
      </div>
      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить задачу: ${errorMessage(query.error)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Задача не найдена." onRetry={retry} />}
      {projection && !notFound && (
        <>
          <div className="tabs" role="tablist" aria-label="Разделы задачи">
            {(Object.keys(ru.tasks.tabs) as TaskTab[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`tab${tab === key ? ' active' : ''}`}
                onClick={() => setTab(key)}
              >
                {ru.tasks.tabs[key]}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div className="grid2">
              <section aria-label="Рабочий процесс">
                <div className="panel-head"><h3>{ru.tasks.overview.process}</h3></div>
                <p>{`Статус: ${statusLabel(projection.lifecycle.status ?? task?.status)}`}</p>
                <WorkflowTimeline stages={TASK_LIFECYCLE_STAGES} currentStage={projection.lifecycle.stage ?? projection.lifecycle.status} />
                <div className="panel-head"><h3>{ru.tasks.overview.recovery}</h3></div>
                <p>{projection.scheduler.status === 'RUNNABLE' ? 'Задача готова к запуску.' : waitReasonLabel(projection.scheduler.reason.code)}</p>
                {projection.dependencies.length > 0 && (
                  <>
                    <div className="panel-head"><h3>{ru.tasks.overview.dependencies}</h3></div>
                    <ul>
                      {projection.dependencies.map((dependency) => (
                        <li key={dependency.id}>
                          <Link to={`/tasks/${encodeURIComponent(dependency.taskId)}`}>{dependency.taskId}</Link> зависит от <Link to={`/tasks/${encodeURIComponent(dependency.dependsOnTaskId)}`}>{dependency.dependsOnTaskId}</Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="panel-head"><h3>{ru.tasks.overview.events}</h3></div>
                <p>{`${projection.events.length} событий · ${projection.approvals.length} согласований`}</p>
              </section>
              <section aria-label="Связанная работа">
                <div className="panel-head"><h3>{ru.tasks.overview.related}</h3></div>
                <p>
                  {task?.project_id ? <Link to={`/projects/${encodeURIComponent(task.project_id)}`}>{ru.tasks.overview.project}</Link> : null}
                  {task?.project_id && task.epic_id ? ' · ' : ''}
                  {task?.epic_id ? <Link to={`/epics/${encodeURIComponent(task.epic_id)}`}>{ru.tasks.overview.epic}</Link> : null}
                </p>
                <div className="panel-head"><h3>{ru.tasks.overview.state}</h3></div>
                <div className="row"><span className="muted">План</span><span className="badge accent">{statusLabel(projection.lifecycle.status)}</span></div>
                <div className="row"><span className="muted">Run</span><span className="badge dim">{projection.runs.length > 0 ? statusLabel(projection.runs[projection.runs.length - 1]!.status) : '—'}</span></div>
                <div className="row"><span className="muted">Ветка</span><span className="badge dim">{projection.git.branch ?? '—'}</span></div>
              </section>
            </div>
          )}

          {tab === 'contract' && (
            <section aria-label="Контракт">
              <div className="panel-head"><h3>{ru.tasks.contractTitle}</h3></div>
              <p>{contract}</p>
            </section>
          )}

          {tab === 'runs' && (
            <section aria-label="Запуски агента">
              <div className="panel-head"><h3>{ru.tasks.runsTitle}</h3></div>
              <ul>
                {projection.runs.length === 0 ? <li>{ru.tasks.runsEmpty}</li> : projection.runs.map((run) => {
                  const label = `${run.role} · ${statusLabel(run.status)}`;
                  return <li key={run.id}><Link to={`/runs/${encodeURIComponent(run.id)}`}>{label}</Link></li>;
                })}
              </ul>
            </section>
          )}

          {tab === 'review' && (
            <section aria-label="Результаты проверки">
              <div className="panel-head"><h3>{ru.tasks.reviewTitle}</h3></div>
              <p>{projection.findings.length === 0 && projection.defects.length === 0 ? ru.tasks.reviewEmpty : `${projection.findings.length} замечаний · ${projection.defects.length} дефектов`}</p>
            </section>
          )}

          {tab === 'qa' && (
            <section aria-label="Контроль качества">
              <div className="panel-head"><h3>{ru.tasks.qaTitle}</h3></div>
              <p>{projection.defects.length === 0 ? ru.tasks.qaEmpty : `${projection.defects.length} дефектов`}</p>
            </section>
          )}

          {tab === 'git' && (
            <section aria-label="Git">
              <div className="panel-head"><h3>{ru.tasks.gitTitle}</h3></div>
              <p>{`${projection.git.branch ?? 'Ветка не указана'} · ${projection.git.repositoryPath ?? 'Репозиторий не указан'}${projection.git.github?.url ? ` · ${projection.git.github.url}` : ''}`}</p>
            </section>
          )}

          {tab === 'usage' && (
            <section aria-label="Использование">
              <div className="panel-head"><h3>{ru.tasks.usageTitle}</h3></div>
              <p>{`${projection.usage.totalTokens} токенов · $${projection.usage.cost.toFixed(2)}`}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
