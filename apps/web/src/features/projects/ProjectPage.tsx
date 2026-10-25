import { useCallback, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, toClientPath, pauseProject, resumeProject, syncProjectGithub } from '../../api/client.js';
import { ErrorAlert, EmptyState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useQuery } from '../../state/use-query.js';
import { getProjectOverview } from './api.js';
import { apiErrorMessage, approvalTypeLabel, githubStatusLabel, ru, statusLabel } from '../../i18n/ru.js';
import ProjectConfigPanel from './ProjectConfigPanel.js';
import HumanFeedbackPanel from './HumanFeedbackPanel.js';
import UnsupportedBlock from '../../components/ui/Unavailable.js';
import CoordinatorRequestPanel from '../coordinator/CoordinatorRequestPanel.js';

interface ProjectPageProps {
  id: string;
}

/**
 * Представляет пользовательский экран ProjectPage; авторитетные проверки выполняются backend.
 */
export default function ProjectPage({ id }: ProjectPageProps) {
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const projectPath = toClientPath(apiPaths.project(id));
  const fetcher = useCallback((_signal: AbortSignal) => getProjectOverview(id), [id]);
  const query = useQuery(null, projectPath, undefined, fetcher);
  const projection = query.data;
  const project = projection?.project;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const notFound = query.status === 'success' && projection?.project === null;
  const onboardingBlocked = Boolean(project && project.status !== 'ACTIVE' && project.status !== 'PAUSED');
  const isPaused = project?.status === 'PAUSED';

  const applyControl = useCallback(async (action: () => Promise<unknown>) => {
    setControlBusy(true);
    setControlError(null);
    try {
      await action();
      void query.refetch().catch(() => undefined);
    } catch (cause) {
      setControlError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    } finally {
      setControlBusy(false);
    }
  }, [query.refetch]);

  const togglePause = useCallback(() => {
    void applyControl(isPaused ? () => resumeProject(id) : () => pauseProject(id));
  }, [applyControl, id, isPaused]);

  const runSync = useCallback(async () => {
    setSyncBusy(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const result = await syncProjectGithub(id);
      setSyncResult(result.status === 'SYNCED' ? 'Синхронизировано.' : 'Синхронизация уже выполняется.');
      void query.refetch().catch(() => undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setSyncError('Сначала укажите GitHub repository для проекта.');
      } else if (cause instanceof ApiError && cause.status === 503) {
        setSyncError('Синхронизация с GitHub недоступна.');
      } else {
        setSyncError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
      }
    } finally {
      setSyncBusy(false);
    }
  }, [id, query.refetch]);

  return (
    <div className="project-page page-stack reference-screen reference-screen--project">
      <div className="topbar">
        <div>
          <h1>{`Проект: ${project?.displayName ?? project?.name ?? id}`}</h1>
          <div className="sub">{project ? statusLabel(project.status) : ru.common.loading}</div>
        </div>
        <div className="top-actions">
          {project && (project.status === 'ACTIVE' || project.status === 'PAUSED') && (
            <button
              type="button"
              className="btn"
              disabled={controlBusy}
              onClick={togglePause}
            >
              {isPaused ? 'Возобновить проект' : 'Приостановить проект'}
            </button>
          )}
          {project && <StatusBadge status={project.status} />}
        </div>
      </div>
      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить проект: ${apiErrorMessage(query.error instanceof ApiError ? query.error.code : undefined)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Проект не найден." onRetry={retry} />}
      {controlError && <ErrorAlert message={`Не удалось изменить состояние проекта: ${controlError}`} onRetry={togglePause} />}
      {onboardingBlocked && (
        <section className="local-mode-warning reference-panel" role="note" aria-label="Онбординг проекта">
          <h2>{ru.projects.onboardingGate.title}</h2>
          <p>{ru.projects.onboardingGate.description}</p>
          <Link to={`/onboarding/${encodeURIComponent(project!.id)}`}>{ru.projects.onboardingGate.goOnboarding}</Link>
        </section>
      )}
      {projection && !notFound && (
        <>
        <section className="reference-metrics" aria-label="Сводка проекта">
          <div className="reference-metric"><span>Эпики</span><strong>{projection.epics.length}</strong></div>
          <div className="reference-metric"><span>Задачи</span><strong>{projection.tasks.length}</strong></div>
          <div className="reference-metric"><span>Блокировки</span><strong>{projection.blockers.length}</strong></div>
          <div className="reference-metric"><span>Использование</span><strong>${projection.usage.cost.toFixed(2)}</strong><small>{projection.usage.totalTokens.toLocaleString('ru-RU')} токенов</small></div>
        </section>
        <div className="grid2 reference-columns project-overview-grid">
          <section className="reference-panel" aria-label="Сведения о проекте">
            <div className="panel-head"><h3>{ru.projects.stateCard}</h3></div>
            <div className="row"><span className="muted">{ru.projects.table.status}</span><span>{project ? statusLabel(project.status) : '—'}</span></div>
            <div className="row"><span className="muted">{ru.projects.gitLabel}</span><span>{projection.git.repositoryPath ?? '—'}</span></div>
            <div className="row"><span className="muted">{ru.projects.table.tasks}</span><span>{projection.tasks.length} · {ru.projects.table.epics.toLowerCase()}: {projection.epics.length}</span></div>
            <UnsupportedBlock reason="BUDGET_PROJECTION_UNAVAILABLE" label="Бюджет и прогресс" />
            <UnsupportedBlock reason="GRAPH_PROJECTION_UNAVAILABLE" label="Граф зависимостей" />
          </section>
          <section className="reference-panel" aria-label="Репозиторий и GitHub">
            <div className="panel-head"><h3>{ru.projects.gitLabel}</h3></div>
            <div className="row">
              <span className="muted">Репозиторий / путь / ветка / GitHub</span>
              <span>{projection.git.repositoryPath ?? 'Репозиторий не указан'} · {projection.git.defaultBranch ?? 'Ветка по умолчанию не указана'} · {projection.git.github ? githubStatusLabel(projection.git.github.status) : 'GitHub не подключён'}</span>
            </div>
            {syncResult && <p className="muted">{syncResult}</p>}
            {syncError && <p role="alert">{syncError}</p>}
            <div>
              <button type="button" className="btn" disabled={syncBusy} onClick={runSync}>Синхронизировать сейчас</button>
            </div>
          </section>
          <section className="reference-panel" aria-label="Эпики и задачи">
            <div className="panel-head"><h3>{ru.projects.epicsCard}</h3></div>
            <ul>{projection.epics.length === 0 ? <li>{ru.projects.noEpics}</li> : projection.epics.map((epic) => <li key={epic.id}><Link to={`/epics/${encodeURIComponent(epic.id)}`}>{epic.title || epic.display_id}</Link></li>)}</ul>
            <div className="panel-head"><h3>{ru.projects.tasksCard}</h3></div>
            <ul>{projection.tasks.length === 0 ? <li>{ru.projects.noTasks}</li> : projection.tasks.map((task) => <li key={task.id}><Link to={`/tasks/${encodeURIComponent(task.id)}`}>{task.title || task.display_id}</Link></li>)}</ul>
          </section>
          <section className="reference-panel" aria-label="Блокировки">
            <div className="panel-head"><h3>{ru.epics.blockersTitle}</h3></div>
            {projection.blockers.length === 0
              ? <EmptyState message="Блокировок нет." />
              : (
                <ul>
                  {projection.blockers.map((blocker) => (
                    <li key={blocker.id}><StatusBadge status={blocker.status} />{blocker.reason ? ` · ${blocker.reason}` : ''}</li>
                  ))}
                </ul>
              )}
          </section>
          <section className="reference-panel" aria-label="Согласования">
            <div className="panel-head"><h3>Согласования</h3></div>
            {projection.approvals.length === 0
              ? <EmptyState message="Согласований нет." />
              : (
                <ul>
                  {projection.approvals.map((approval) => (
                    <li key={approval.id}><Link to={`/approvals/${encodeURIComponent(approval.id)}`}>{approvalTypeLabel(approval.type)}</Link> · <StatusBadge status={approval.status} /></li>
                  ))}
                </ul>
              )}
          </section>
          <section className="reference-panel" aria-label="Активность проекта">
            <div className="panel-head"><h3>{ru.projects.eventsCard}</h3></div>
            <ul>
              {projection.events.length === 0 ? <li>{ru.projects.noEvents}</li> : projection.events.map((event) => {
                const timestamp = Date.parse(event.createdAt);
                const displayTime = Number.isNaN(timestamp)
                  ? event.createdAt
                  : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
                return <li key={event.id}><span>{event.type}</span> · <time dateTime={event.createdAt}>{displayTime}</time></li>;
              })}
            </ul>
          </section>
        </div>
        </>
      )}
      {project && <ProjectConfigPanel projectId={id} />}
      {project && <CoordinatorRequestPanel key={id} projectId={id} />}
      {projection && !notFound && <HumanFeedbackPanel projectId={id} tasks={projection.tasks.map((task) => ({ id: task.id, title: task.title || task.display_id }))} epics={projection.epics.map((epic) => ({ id: epic.id, title: epic.title || epic.display_id }))} />}
    </div>
  );
}
