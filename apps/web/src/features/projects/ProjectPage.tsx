import { useCallback } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { ApiError, toClientPath } from '../../api/client.js';
import { ErrorAlert } from '../../components/ui/PageState.js';
import { useQuery } from '../../state/use-query.js';
import { getProjectOverview } from './api.js';
import { apiErrorMessage, githubStatusLabel, statusLabel } from '../../i18n/ru.js';

interface ProjectPageProps {
  id: string;
}

/**
 * Представляет пользовательский экран ProjectPage; авторитетные проверки выполняются backend.
 */
export default function ProjectPage({ id }: ProjectPageProps) {
  const projectPath = toClientPath(apiPaths.project(id));
  const fetcher = useCallback((_signal: AbortSignal) => getProjectOverview(id), []);
  const query = useQuery(null, projectPath, undefined, fetcher);
  const projection = query.data;
  const project = projection?.project;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const notFound = query.status === 'success' && projection?.project === null;
  return (
    <div className="project-page">
      <h1>Проект: {project?.displayName ?? project?.name ?? id}</h1>
      {query.status === 'error' && <ErrorAlert message={`Не удалось загрузить проект: ${apiErrorMessage(query.error instanceof ApiError ? query.error.code : undefined)}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Проект не найден." onRetry={retry} />}
      <section aria-label="Сведения о проекте">
        <h2>Сведения</h2>
        <p>{query.status === 'loading' || query.status === 'idle' ? 'Загрузка данных проекта…' : notFound ? 'Данные проекта недоступны.' : project ? `${statusLabel(project.status)} · ${project.name}` : 'Данные проекта недоступны.'}</p>
        {projection && !notFound && <p>{projection.tasks.length} задач · {projection.epics.length} эпиков · ${projection.usage.cost.toFixed(2)} использовано</p>}
      </section>
      <section aria-label="Репозиторий и GitHub">
        <h2>Репозиторий / путь / ветка / GitHub</h2>
        <p>{projection && !notFound ? `${projection.git.repositoryPath ?? 'Репозиторий не указан'} · ${projection.git.defaultBranch ?? 'Ветка по умолчанию не указана'} · ${projection.git.github ? githubStatusLabel(projection.git.github.status) : 'GitHub не подключён'}` : notFound ? 'Проект не найден.' : 'Загрузка сведений о репозитории…'}</p>
      </section>
       <section aria-label="Зависимости и среда выполнения"><h2>Зависимости / среда выполнения</h2><p>{projection && !notFound ? `${projection.blockers.length} блокировок · ${projection.approvals.length} согласований` : notFound ? 'Зависимости проекта недоступны.' : 'Загрузка зависимостей проекта…'}</p></section>
       <section aria-label="Активность и бюджет"><h2>Активность / бюджет</h2><p>{projection && !notFound ? `${projection.events.length} событий · ${projection.usage.totalTokens} токенов` : notFound ? 'Данные об активности проекта недоступны.' : 'Загрузка активности проекта…'}</p></section>
      <section aria-label="Эпики и задачи">
        <h2>Эпики и задачи</h2>
        {projection && !notFound ? <><ul>{projection.epics.length === 0 ? <li>Эпиков нет.</li> : projection.epics.map((epic) => <li key={epic.id}><Link to={`/epics/${encodeURIComponent(epic.id)}`}>{epic.title || epic.display_id}</Link></li>)}</ul><ul>{projection.tasks.length === 0 ? <li>Задач нет.</li> : projection.tasks.map((task) => <li key={task.id}><Link to={`/tasks/${encodeURIComponent(task.id)}`}>{task.title || task.display_id}</Link></li>)}</ul></> : notFound ? <p>Рабочие элементы проекта недоступны.</p> : null}
      </section>
    </div>
  );
}
