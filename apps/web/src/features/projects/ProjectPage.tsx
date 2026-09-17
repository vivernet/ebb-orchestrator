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
      <section aria-label="Epics and tasks">
        <h2>Epics and Tasks</h2>
        <ul>{projection?.epics.map((epic) => <li key={String((epic as { id?: string }).id)}>{String((epic as { title?: string; display_id?: string }).title ?? (epic as { display_id?: string }).display_id ?? 'Epic')}</li>)}</ul>
        <ul>{projection?.tasks.map((task) => <li key={String((task as { id?: string }).id)}>{String((task as { title?: string; display_id?: string }).title ?? (task as { display_id?: string }).display_id ?? 'Task')}</li>)}</ul>
      </section>
    </div>
  );
}
