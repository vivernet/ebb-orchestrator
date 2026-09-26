import { useCallback } from 'react';
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

/** Представляет пользовательский экран TaskPage; авторитетные проверки выполняются backend. */
export default function TaskPage({ id = '' }: TaskPageProps) {
  const taskPath = toClientPath(apiPaths.task(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<TaskOverviewProjection>(taskPath, { signal }), [taskPath]);
  const query = useQuery(null, taskPath, undefined, fetcher, { enabled: Boolean(id) });
  const projection = query.data;
  const task = projection?.task as { title?: string; display_id?: string; status?: string; project_id?: string; epic_id?: string | null } | null | undefined;
  const notFound = query.status === 'success' && projection?.task === null;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const refresh = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(refresh);
  const contract = notFound ? 'Контракт задачи недоступен.' : projection?.contract ? JSON.stringify(projection.contract) : query.status === 'success' ? 'Контракт не указан.' : 'Загрузка контракта задачи…';

  return (
    <div className="task-page">
      <h1>Задача: {(task?.title ?? task?.display_id ?? id) || ru.common.loading}</h1>
      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить задачу: ${errorMessage(query.error)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Задача не найдена." onRetry={retry} />}
      <section aria-label="Контракт"><h2>Контракт</h2><p>{contract}</p></section>
      <section aria-label="Рабочий процесс"><h2>Рабочий процесс</h2><p>{notFound ? 'Рабочий процесс задачи недоступен.' : projection ? `Статус: ${statusLabel(projection.lifecycle.status ?? task?.status)}` : `Статус: ${query.status === 'error' ? 'Недоступно' : 'Загрузка данных задачи…'}`}</p>{projection && !notFound && <WorkflowTimeline stages={TASK_LIFECYCLE_STAGES} currentStage={projection.lifecycle.stage ?? projection.lifecycle.status} />}</section>
      <section aria-label="Связанная работа"><h2>Связанная работа</h2>{notFound ? <p>{ru.tasks.relatedWorkUnavailable}</p> : <p>{task?.project_id ? <Link to={`/projects/${encodeURIComponent(task.project_id)}`}>Проект</Link> : null}{task?.project_id && task.epic_id ? ' · ' : ''}{task?.epic_id ? <Link to={`/epics/${encodeURIComponent(task.epic_id)}`}>Эпик</Link> : null}</p>}</section>
      <section aria-label="Запуски агента"><h2>Запуски агента</h2><ul>{notFound ? <li>Запуски агента недоступны.</li> : projection ? projection.runs.length === 0 ? <li>Запусков агента нет.</li> : projection.runs.map((run) => { const label = `${run.role} · ${statusLabel(run.status)}`; return <li key={run.id}><Link to={`/runs/${encodeURIComponent(run.id)}`}>{label}</Link></li>; }) : <li>Загрузка запусков агента…</li>}</ul></section>
      <section aria-label="Результаты проверки"><h2>Результаты проверки</h2><p>{notFound ? 'Результаты проверки недоступны.' : projection ? projection.findings.length === 0 && projection.defects.length === 0 ? 'Замечаний и дефектов нет.' : `${projection.findings.length} замечаний · ${projection.defects.length} дефектов` : 'Загрузка результатов проверки…'}</p></section>
      <section aria-label="Зависимости и события"><h2>Зависимости / события</h2><p>{notFound ? ru.tasks.dependenciesEventsUnavailable : projection ? `${projection.dependencies.length} зависимостей · ${projection.events.length} событий · ${projection.approvals.length} согласований` : 'Загрузка зависимостей и событий…'}</p>{projection && !notFound && projection.dependencies.length > 0 && <ul>{projection.dependencies.map((dependency) => <li key={dependency.id}><Link to={`/tasks/${encodeURIComponent(dependency.taskId)}`}>{dependency.taskId}</Link> зависит от <Link to={`/tasks/${encodeURIComponent(dependency.dependsOnTaskId)}`}>{dependency.dependsOnTaskId}</Link></li>)}</ul>}</section>
      <section aria-label="Git"><h2>Git</h2><p>{notFound ? 'Состояние Git недоступно.' : projection ? `${projection.git.branch ?? 'Ветка не указана'} · ${projection.git.repositoryPath ?? 'Репозиторий не указан'}${projection.git.github?.url ? ` · ${projection.git.github.url}` : ''}` : 'Загрузка состояния Git…'}</p></section>
      <section aria-label="Восстановление"><h2>Восстановление</h2><p>{notFound ? 'Состояние восстановления недоступно.' : !projection ? (query.status === 'success' ? 'Состояние восстановления не указано.' : 'Загрузка состояния восстановления…') : projection.scheduler.status === 'RUNNABLE' ? 'Задача готова к запуску.' : waitReasonLabel(projection.scheduler.reason.code)}</p></section>
      <section aria-label="Использование"><h2>Использование</h2><p>{notFound ? 'Данные об использовании недоступны.' : projection ? `${projection.usage.totalTokens} токенов · $${projection.usage.cost.toFixed(2)}` : 'Загрузка данных об использовании…'}</p></section>
    </div>
  );
}
