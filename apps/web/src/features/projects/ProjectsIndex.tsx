import { useCallback } from 'react';
import { apiPaths, type DashboardProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { toClientPath } from '../../api/client.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import { useQuery } from '../../state/use-query.js';
import { listProjects } from '../projects/api.js';

/**
 * Представляет пользовательский экран ProjectsIndex; авторитетные проверки выполняются backend.
 */
export default function ProjectsIndex() {
  const projectsPath = toClientPath(apiPaths.projectsCollection);
  const fetcher = useCallback((_signal: AbortSignal) => listProjects(), []);
  const query = useQuery<DashboardProjection['projects']>(null, projectsPath, undefined, fetcher);
  const projects = query.data ?? [];

  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);

  if (query.status === 'loading' || query.status === 'idle') {
    return <PageState status="loading" message="Загрузка проектов…" />;
  }

  if (query.status === 'error') {
    return (
      <PageState
        status="error"
        title="Не удалось загрузить проекты"
        message="Не удалось загрузить список проектов."
        onRetry={retry}
      />
    );
  }

  if (projects.length === 0) {
    return (
      <EmptyState
        message="Проектов пока нет."
        action={<Link to="/projects/new">Создать первый проект</Link>}
      />
    );
  }

  return (
    <div className="projects-index">
      <h1>Проекты</h1>
      <ul>
        {projects.map((project) => (
          <li key={project.id}>
            <Link to={`/projects/${encodeURIComponent(project.id)}`}>{project.displayName ?? project.name}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
