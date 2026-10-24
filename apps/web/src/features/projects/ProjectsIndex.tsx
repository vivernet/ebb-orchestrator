import { useCallback } from 'react';
import { apiPaths, type DashboardProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { toClientPath } from '../../api/client.js';
import { EmptyState, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useQuery } from '../../state/use-query.js';
import { listProjects } from '../projects/api.js';
import { ru } from '../../i18n/ru.js';

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
        message={ru.projects.empty}
        action={<Link to="/projects/new">{ru.projects.createFirst}</Link>}
      />
    );
  }

  return (
    <div className="projects-index page-stack">
      <div className="topbar">
        <div>
          <h1>{ru.projects.pageTitle}</h1>
          <div className="sub">{ru.projects.subtitle(projects.filter((project) => project.status === 'ACTIVE').length, projects.filter((project) => project.status !== 'ACTIVE').length)}</div>
        </div>
        <div className="top-actions">
          <Link className="btn-primary" to="/projects/new">{ru.projects.newProject}</Link>
        </div>
      </div>

      <section aria-label="Список проектов" className="table-card">
        <div className="section-heading"><h2>{ru.projects.pageTitle}</h2></div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{ru.projects.table.name}</th>
                <th scope="col">{ru.projects.table.status}</th>
                <th scope="col">{ru.projects.table.epics}</th>
                <th scope="col">{ru.projects.table.tasks}</th>
                <th scope="col">{ru.projects.table.onboarding}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link to={`/projects/${encodeURIComponent(project.id)}`}>{project.displayName ?? project.name}</Link>
                  </td>
                  <td><StatusBadge status={project.status} /></td>
                  <td>—</td>
                  <td>—</td>
                  <td>
                    {project.status === 'ACTIVE'
                      ? <span className="badge good">{ru.onboarding.approve}</span>
                      : <span className="badge warn">{ru.projects.onboardingGate.goOnboarding}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
