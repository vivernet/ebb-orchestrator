import { useCallback } from 'react';
import { apiPaths, type ProjectOverviewProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import { apiClient, toClientPath } from '../../api/client.js';
import { ErrorAlert } from '../../components/PageState.js';
import { useQuery } from '../../state/use-query.js';

interface ProjectPageProps {
  id: string;
}

/**
 * Представляет пользовательский экран ProjectPage; авторитетные проверки выполняются backend.
 */
export default function ProjectPage({ id }: ProjectPageProps) {
  const projectPath = toClientPath(apiPaths.project(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<ProjectOverviewProjection>(projectPath, { signal }), [projectPath]);
  const query = useQuery(null, projectPath, undefined, fetcher);
  const projection = query.data;
  const project = projection?.project;
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  const notFound = query.status === 'success' && projection?.project === null;
  return (
    <div className="project-page">
      <h1>Project: {project?.displayName ?? project?.name ?? id}</h1>
      {query.status === 'error' && <ErrorAlert message={`Unable to load project: ${query.error instanceof Error ? query.error.message : 'unknown error'}`} onRetry={retry} />}
      {notFound && <ErrorAlert message="Project not found." onRetry={retry} />}
      <section aria-label="Project details">
        <h2>Details</h2>
        <p>{query.status === 'loading' || query.status === 'idle' ? 'Loading project projection…' : notFound ? 'No project projection is available.' : project ? `${project.status} · ${project.name}` : 'No project projection is available.'}</p>
        {projection && !notFound && <p>{projection.tasks.length} tasks · {projection.epics.length} epics · ${projection.usage.cost.toFixed(2)} used</p>}
      </section>
      <section aria-label="Repository and GitHub">
        <h2>Repository / path / branch / GitHub</h2>
        <p>{projection && !notFound ? `${projection.git.repositoryPath ?? 'No repository recorded'} · ${projection.git.defaultBranch ?? 'No default branch recorded'} · ${projection.git.github?.status ?? 'GitHub not connected'}` : notFound ? 'Project not found.' : 'Loading project repository details…'}</p>
      </section>
       <section aria-label="Dependency and runtime settings"><h2>Dependency / runtime settings</h2><p>{projection && !notFound ? `${projection.blockers.length} blockers · ${projection.approvals.length} approvals` : notFound ? 'Project dependencies unavailable.' : 'Loading project dependencies…'}</p></section>
       <section aria-label="Activity and budget"><h2>Activity / budget</h2><p>{projection && !notFound ? `${projection.events.length} events · ${projection.usage.totalTokens} tokens` : notFound ? 'Project activity unavailable.' : 'Loading project activity…'}</p></section>
      <section aria-label="Epics and tasks">
        <h2>Epics and Tasks</h2>
        {projection && !notFound ? <><ul>{projection.epics.length === 0 ? <li>No epics.</li> : projection.epics.map((epic) => <li key={epic.id}><Link to={`/epics/${encodeURIComponent(epic.id)}`}>{epic.title || epic.display_id}</Link></li>)}</ul><ul>{projection.tasks.length === 0 ? <li>No tasks.</li> : projection.tasks.map((task) => <li key={task.id}><Link to={`/tasks/${encodeURIComponent(task.id)}`}>{task.title || task.display_id}</Link></li>)}</ul></> : notFound ? <p>Project work items unavailable.</p> : null}
      </section>
    </div>
  );
}
