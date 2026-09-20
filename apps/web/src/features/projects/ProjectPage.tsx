import { useEffect, useState } from 'react';
import type { ProjectOverviewProjection } from '@ebb-orchestrator/contracts';
import { apiClient } from '../../api/client.js';

interface ProjectPageProps {
  id: string;
}

/**
 * Представляет пользовательский экран ProjectPage; авторитетные проверки выполняются backend.
 */
export default function ProjectPage({ id }: ProjectPageProps) {
  const [projection, setProjection] = useState<ProjectOverviewProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setError(null);
    void apiClient.get<ProjectOverviewProjection>(`/projects/${encodeURIComponent(id)}`).then(setProjection).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'unknown error');
    });
  }, [id, retry]);
  const project = projection?.project;
  return (
    <div className="project-page">
      <h1>Project: {project?.displayName ?? project?.name ?? id}</h1>
      {error && <p className="inline-alert" role="alert">Unable to load project: {error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
      <section aria-label="Project details">
        <h2>Details</h2>
        <p>{project ? `${project.status} · ${project.name}` : 'Loading project projection…'}</p>
        {projection && <p>{projection.tasks.length} tasks · {projection.epics.length} epics · ${projection.usage.cost.toFixed(2)} used</p>}
      </section>
      <section aria-label="Repository and GitHub">
        <h2>Repository / path / branch / GitHub</h2>
        <p>{projection?.git.repositoryPath ?? 'No repository recorded'} · {projection?.git.defaultBranch ?? 'No default branch recorded'} · {projection?.git.github?.status ?? 'GitHub not connected'}</p>
      </section>
      <nav aria-label="Project tabs"><h2>Project tabs</h2><p>Overview · Epics · Tasks · Runs · Git · Guidelines · Usage</p></nav>
       <section aria-label="Dependency and runtime settings"><h2>Dependency / runtime settings</h2><p>{projection?.blockers.length ?? 0} blockers · {projection?.approvals.length ?? 0} approvals</p></section>
       <section aria-label="Activity and budget"><h2>Activity / budget</h2><p>{projection?.events.length ?? 0} events · {projection?.usage.totalTokens ?? 0} tokens</p></section>
      <section aria-label="Epics and tasks">
        <h2>Epics and Tasks</h2>
        <ul>{projection?.epics.map((epic) => <li key={String((epic as { id?: string }).id)}>{String((epic as { title?: string; display_id?: string }).title ?? (epic as { display_id?: string }).display_id ?? 'Epic')}</li>)}</ul>
        <ul>{projection?.tasks.map((task) => <li key={String((task as { id?: string }).id)}>{String((task as { title?: string; display_id?: string }).title ?? (task as { display_id?: string }).display_id ?? 'Task')}</li>)}</ul>
      </section>
    </div>
  );
}
