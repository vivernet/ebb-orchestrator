import { useEffect, useState } from 'react';
import type { TaskOverviewProjection } from '@ebb-orchestrator/contracts';
import { apiClient } from '../../api/client.js';
import WorkflowTimeline, { TASK_LIFECYCLE_STAGES } from '../../components/WorkflowTimeline.js';

interface TaskPageProps { id?: string; }
export default function TaskPage({ id = '' }: TaskPageProps) {
  const [projection, setProjection] = useState<TaskOverviewProjection | null>(null);
  useEffect(() => { if (id) void apiClient.get<TaskOverviewProjection>(`/tasks/${encodeURIComponent(id)}`).then(setProjection).catch(() => undefined); }, [id]);
  const task = projection?.task as { title?: string; display_id?: string; status?: string } | undefined;
  const contract = projection?.contract ? JSON.stringify(projection.contract) : 'No contract recorded.';
  return (
    <div className="task-page">
      <h1>Task: {(task?.title ?? task?.display_id ?? id) || 'Loading'}</h1>
      <section aria-label="Contract">
        <h2>Contract</h2>
        <p>{contract}</p>
      </section>
      <section aria-label="Workflow">
        <h2>Workflow</h2>
        <p>Status: {projection?.lifecycle.status ?? task?.status ?? 'Loading task projection…'}</p>
        {projection?.lifecycle.status && <WorkflowTimeline stages={TASK_LIFECYCLE_STAGES} currentStage={projection.lifecycle.stage ?? projection.lifecycle.status} />}
      </section>
      <section aria-label="Agent Runs">
        <h2>Agent Runs</h2>
        <ul>{projection?.runs.map((run) => { const item = run as { id?: string; role?: string; status?: string }; return <li key={item.id}>{item.role} · {item.status}</li>; })}</ul>
      </section>
      <section aria-label="Findings">
        <h2>Findings</h2>
        <p>{projection ? `${projection.findings.length} findings · ${projection.defects.length} defects` : 'Loading findings…'}</p>
      </section>
      <section aria-label="Dependencies and events"><h2>Dependencies / events</h2><p>{projection ? `${projection.dependencies.length} dependencies · ${projection.events.length} events · ${projection.approvals.length} approvals` : 'Loading dependencies and events…'}</p></section>
      <section aria-label="Git">
        <h2>Git</h2>
        <p>{projection?.git.branch ?? 'No branch recorded'} · {projection?.git.repositoryPath ?? 'No repository recorded'}{projection?.git.github?.url ? ` · ${projection.git.github.url}` : ''}</p>
      </section>
      <section aria-label="Recovery">
        <h2>Recovery</h2>
        <p>{projection?.waitReason?.message ?? 'No recovery state recorded.'}</p>
      </section>
      <section aria-label="Usage">
        <h2>Usage</h2>
        <p>{projection ? `${projection.usage.totalTokens} tokens · $${projection.usage.cost.toFixed(2)}` : 'Loading usage…'}</p>
      </section>
    </div>
  );
}
