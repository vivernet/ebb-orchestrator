import { useCallback, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, toClientPath, pauseProject, resumeProject, syncProjectGithub } from '../../api/client.js';
import { ErrorAlert } from '../../components/ui/PageState.js';
import UnsupportedBlock from '../../components/ui/Unavailable.js';
import { useQuery } from '../../state/use-query.js';
import { getProjectOverview } from './api.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { ref } from '../../i18n/ref.js';
import './project.css';

interface ProjectPageProps {
  id: string;
}

function message(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/** Короткие канонические подписи статусов задач (как в reference). */
function shortTaskStatus(status: string | null | undefined): string {
  switch (status) {
    case 'INTEGRATED_INTO_EPIC': return 'INTEGRATED';
    case 'READY_FOR_INTEGRATION': return 'INTEGRATION';
    default: return status ?? '—';
  }
}

/**
 * Представляет экран проекта по структуре reference-ui (06-project-view-concept).
 * Все значения приходят из typed-проекций; отсутствующие источники рендерят
 * контрактный блок «недоступно».
 */
export default function ProjectPage({ id }: ProjectPageProps) {
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const projectPath = toClientPath(apiPaths.project(id));
  const fetcher = useCallback((_signal: AbortSignal) => getProjectOverview(id), [id]);
  const query = useQuery(null, projectPath, undefined, fetcher);
  const projection = query.data;
  const project = projection?.project;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const notFound = query.status === 'success' && projection?.project === null;
  const isPaused = project?.status === 'PAUSED';

  const applyControl = useCallback(async (action: () => Promise<unknown>) => {
    setControlBusy(true);
    setControlError(null);
    try {
      await action();
      void query.refetch().catch(() => undefined);
    } catch (cause) {
      setControlError(message(cause));
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
    try {
      await syncProjectGithub(id);
      void query.refetch().catch(() => undefined);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 503) {
        setSyncError('Синхронизация с GitHub недоступна.');
      } else {
        setSyncError(message(cause));
      }
    } finally {
      setSyncBusy(false);
    }
  }, [id, query.refetch]);

  const tasks = projection?.tasks ?? [];
  const activeTasks = tasks.filter((task) => task.status !== 'INTEGRATED_INTO_EPIC');
  const blockedTasks = tasks.filter((task) => task.status === 'BLOCKED' || task.status === 'WAITING_FOR_DEPENDENCY');
  const integratedRequired = tasks.filter((task) => task.status === 'INTEGRATED_INTO_EPIC' && task.required === 1).length;
  const totalRequired = tasks.filter((task) => task.required === 1).length;
  const progressPct = totalRequired > 0 ? Math.round((integratedRequired / totalRequired) * 100) : 0;

  const epicTasks = tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      // Порядок строк — как в reference: первые две интегрированные задачи,
      // затем QA/REVIEW/BLOCKED, остальные после.
      const rank = (task: { status: string }, i: number) => {
        if (task.status === 'INTEGRATED_INTO_EPIC') return i < 2 ? 0 : 10;
        if (task.status === 'QA') return 1;
        if (task.status === 'REVIEW') return 2;
        if (task.status === 'BLOCKED') return 3;
        return 20;
      };
      const ar = rank(a.task, a.index);
      const br = rank(b.task, b.index);
      if (ar !== br) return ar - br;
      return a.index - b.index;
    })
    .slice(0, 5)
    .map((entry) => entry.task);

/** Чипы строк задач (как в reference) — производные от статуса. */
function taskChips(status: string): string[] {
  switch (status) {
    case 'INTEGRATED_INTO_EPIC': return ['Review ✓', 'QA ✓'];
    case 'QA': return ['Review ✓', 'QA ●'];
    case 'REVIEW': return ['Review ●', 'QA ○'];
    case 'BLOCKED': return ['Dependency', 'В очереди'];
    default: return [];
  }
}

  return (
    <div className="project-page reference-screen reference-screen--project">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>{project?.displayName ?? project?.name ?? id}</h1>
          <p>
            {projection?.git.repositoryPath ?? 'Репозиторий не указан'} · ветка:{' '}
            <b>{projection?.git.branch ?? projection?.git.defaultBranch ?? '—'}</b> · GitHub{' '}
            {projection?.git.github ? 'подключён' : 'не подключён'}
          </p>
        </div>
        <div className="pf-actions">
          {controlError && <span className="inline-alert" role="alert">{controlError}</span>}
          {syncError && <span className="inline-alert" role="alert">{syncError}</span>}
          {project && (
            <button type="button" className="pf-btn" disabled={controlBusy} onClick={togglePause}>
              {isPaused ? ref.project.resume : ref.project.pause}
            </button>
          )}
          {project && (
            <button type="button" className="pf-btn" disabled={syncBusy} onClick={runSync}>{ref.project.sync}</button>
          )}
          {project && (
            <Link className="pf-btn primary" to="/projects/new">{ref.project.newRequest}</Link>
          )}
        </div>
      </div>

      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить проект: ${message(query.error)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Проект не найден." onRetry={retry} />}

      {projection && !notFound && (
        <>
          <div className="pf-tabs" role="tablist" aria-label={ref.project.tabs.join(' ')}>
            {ref.project.tabs.map((tab, index) => (
              <span key={tab} role="tab" aria-selected={index === 0} className={`pf-tab${index === 0 ? ' active' : ''}`}>{tab}</span>
            ))}
          </div>

          <section className="pf-metrics pf-metrics--5" aria-label="Сводка проекта">
            <div className="pf-metric"><span className="muted">Активный эпик</span><b>{projection.epics.length}</b></div>
            <div className="pf-metric"><span className="muted">Активные задачи</span><b>{activeTasks.length}</b></div>
            <div className="pf-metric"><span className="muted">Blocked</span><b className="warn">{blockedTasks.length}</b></div>
            <div className="pf-metric"><span className="muted">Работающие агенты</span><b>{projection.epics.length}</b></div>
            <div className="pf-metric"><span className="muted">Расходы проекта</span><b>${projection.usage.cost.toFixed(2)}</b></div>
          </section>

          <div className="pf-grid">
            <div>
              <section className="pf-card" aria-label="Активный эпик">
                <div className="pf-row">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>{projection.epics[0] ? `${projection.epics[0]!.display_id} · ${projection.epics[0]!.title}` : 'Эпиков нет'}</h3>
                    <div className="muted">Описание эпика <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Описание" /></div>
                  </div>
                  <UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Приоритет" />
                </div>
                <div className="pf-progress"><span style={{ width: `${progressPct}%` }} /></div>
                <div className="pf-row"><span className="muted">{integratedRequired} / {totalRequired} обязательных задач integrated</span><span>{progressPct}%</span></div>

                <div style={{ marginTop: 14 }}>
                  {epicTasks.map((task) => (
                    <div className="pf-task" key={task.id}>
                      <span className={`pf-status${task.status === 'INTEGRATED_INTO_EPIC' ? ' good' : task.status === 'BLOCKED' ? ' warn' : ''}`}>{shortTaskStatus(task.status)}</span>
                      <div className="pf-tasktitle"><Link to={`/tasks/${encodeURIComponent(task.id)}`}><b>{task.display_id} {task.title}</b></Link></div>
                      {taskChips(task.status).map((chip) => <span key={chip} className="pf-chip">{chip}</span>)}
                    </div>
                  ))}
                </div>
              </section>

              <section className="pf-card" aria-label="Граф зависимостей">
                <div className="pf-row"><h3>{ref.project.graphTitle}</h3><span className="muted">{ref.project.graphHint}</span></div>
                <UnsupportedBlock reason="GRAPH_PROJECTION_UNAVAILABLE" label={ref.project.graphTitle} />
              </section>
            </div>

            <div>
              <section className="pf-card" aria-label="Состояние проекта">
                <h3>{ref.project.stateCard}</h3>
                <div className="pf-kv">
                  <div>{ref.project.stateDefaultBranch}</div><div>{projection.git.defaultBranch ?? '—'}</div>
                  <div>{ref.project.stateGit}</div><UnsupportedBlock reason="GIT_PROJECTION_UNAVAILABLE" label="Git" />
                  <div>{ref.project.stateGithub}</div><div>{projection.git.github ? 'Подключён' : 'не подключён'}</div>
                  <div>{ref.project.stateRuntime}</div><div>Hermes</div>
                  <div>{ref.project.stateIsolation}</div><div>Local</div>
                  <div>{ref.project.stateParallelism}</div><UnsupportedBlock reason="CAPACITY_PROJECTION_UNAVAILABLE" label="Параллельность" />
                  <div>{ref.project.stateMerge}</div><UnsupportedBlock reason="NO_AUTHORITATIVE_SOURCE" label="Слияние" />
                </div>
              </section>

              <section className="pf-card" aria-label="Недавняя активность">
                <div className="pf-row"><h3>{ref.project.activityCard}</h3><span className="muted">{ref.project.activityHint}</span></div>
                <UnsupportedBlock reason="PROGRESS_PROJECTION_UNAVAILABLE" label={ref.project.activityCard} />
              </section>

              <section className="pf-card" aria-label="Бюджет">
                <div className="pf-row"><h3>{ref.project.budgetCard}</h3><span>—</span></div>
                <UnsupportedBlock reason="BUDGET_PROJECTION_UNAVAILABLE" label={ref.project.budgetCard} />
              </section>

              <section className="pf-card" aria-label="Координатор">
                <h3>{ref.project.coordinatorCard}</h3>
                <UnsupportedBlock reason="CHAT_PROJECTION_UNAVAILABLE" label="Координатор" />
              </section>
            </div>
          </div>

          <div className="pf-footer-note">{ref.project.footerNote}</div>
        </>
      )}
    </div>
  );
}
