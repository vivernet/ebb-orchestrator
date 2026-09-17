import { useEffect, useState } from 'react';
import type { ProjectOverviewProjection } from '@ebb-orchestrator/contracts';
import { apiClient } from '../../api/client.js';

interface ProjectPageProps {
  id: string;
}

export default function ProjectPage({ id }: ProjectPageProps) {
  const [projection, setProjection] = useState<ProjectOverviewProjection | null>(null);
  useEffect(() => { void apiClient.get<ProjectOverviewProjection>(`/projects/${encodeURIComponent(id)}`).then(setProjection).catch(() => undefined); }, [id]);
  const project = projection?.project;
  return (
    <div className="project-page">
      <h1>Project: {project?.displayName ?? project?.name ?? id}</h1>
      <section aria-label="Project details">
        <h2>Details</h2>
        <p>{project ? `${project.status} · ${project.name}` : 'Loading project projection…'}</p>
        {projection && <p>{projection.tasks.length} tasks · {projection.epics.length} epics · ${projection.usage.cost.toFixed(2)} used</p>}
      </section>
      <section aria-label="Repository and GitHub">
        <h2>Repository / path / branch / GitHub</h2>
        <p>{(project as typeof project & { repository?: string; path?: string; defaultBranch?: string; githubStatus?: string } | undefined)?.repository ?? 'Repository'} · {(project as typeof project & { path?: string } | undefined)?.path ?? 'Path'} · {(project as typeof project & { defaultBranch?: string } | undefined)?.defaultBranch ?? 'Default branch'} · {(project as typeof project & { githubStatus?: string } | undefined)?.githubStatus ?? 'GitHub status unavailable'}</p>
      </section>
      <nav aria-label="Project tabs"><h2>Project tabs</h2><p>Overview · Epics · Tasks · Runs · Git · Guidelines · Usage</p></nav>
      <section aria-label="Dependency and runtime settings"><h2>Dependency / runtime settings</h2><p>Dependencies, runtime, isolation, parallelism and merge policy</p></section>
      <section aria-label="Activity and budget"><h2>Activity / budget</h2><p>Project activity and usage budget are projection-backed.</p></section>
      <section aria-label="Epics and tasks">
        <h2>Epics and Tasks</h2>
        <ul>{projection?.epics.map((epic) => <li key={String((epic as { id?: string }).id)}>{String((epic as { title?: string; display_id?: string }).title ?? (epic as { display_id?: string }).display_id ?? 'Epic')}</li>)}</ul>
        <ul>{projection?.tasks.map((task) => <li key={String((task as { id?: string }).id)}>{String((task as { title?: string; display_id?: string }).title ?? (task as { display_id?: string }).display_id ?? 'Task')}</li>)}</ul>
      </section>
    </div>
  );
}
