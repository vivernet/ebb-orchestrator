import { useEffect, useState } from 'react';
import type { DashboardProjection, ExecutionQueueProjection } from '@ebb-orchestrator/contracts';
import { apiClient } from '../../api/client.js';

const empty: DashboardProjection = { activeAgents: [], activeWork: [], approvals: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }, projects: [] };

export default function DashboardPage() {
  const [projection, setProjection] = useState<DashboardProjection>(empty);
  const [queue, setQueue] = useState<ExecutionQueueProjection | null>(null);
  useEffect(() => {
    void apiClient.get<DashboardProjection>('/dashboard').then(setProjection).catch(() => undefined);
    void apiClient.get<ExecutionQueueProjection>('/execution').then(setQueue).catch(() => undefined);
  }, []);
  return (
    <div className="dashboard-page">
      <h1>Dashboard</h1>
      <section aria-label="Running agents">
        <h2>Running agents</h2>
        <p>{projection.activeAgents.length} active agent{projection.activeAgents.length === 1 ? '' : 's'}</p>
        <ul>{projection.activeAgents.map((agent) => <li key={agent.runId}>{agent.role} · {agent.status}</li>)}</ul>
      </section>
      <section aria-label="Active work">
        <h2>Active work</h2>
        <p>{projection.activeWork.length} work item{projection.activeWork.length === 1 ? '' : 's'}</p>
        <ul>{projection.activeWork.map((work) => <li key={work.id}>{work.title || work.id} · {work.status}</li>)}</ul>
      </section>
      <section aria-label="Need approval">
        <h2>Need approval</h2>
        <p>{projection.approvals} pending approval{projection.approvals === 1 ? '' : 's'}</p>
      </section>
      <section aria-label="AI spend">
        <h2>AI spend</h2>
        <p>{projection.usage.totalTokens} tokens · ${projection.usage.cost.toFixed(2)}</p>
      </section>
      <section aria-label="Active projects">
        <h2>Active projects</h2>
        <ul>{projection.projects.map((project) => <li key={project.id}>{project.displayName || project.name} · {project.status}</li>)}</ul>
      </section>
      <section aria-label="Queue">
        <h2>Queue</h2>
        <p>{queue ? `${queue.waiting.length} waiting, ${queue.blocked.length} blocked` : 'Loading queue…'}</p>
        <ul>{queue?.waiting.map((item) => <li key={`waiting-${item.taskId}`}>{item.taskId}: {item.reason.message}</li>)}</ul>
      </section>
      <section aria-label="Approval Inbox summary">
        <h2>Approval Inbox summary</h2>
        <p>{projection.approvals} approval{projection.approvals === 1 ? '' : 's'} require attention.</p>
      </section>
      <section aria-label="Agent Pool">
        <h2>Agent Pool</h2>
        <p>{projection.activeAgents.length} active of the available agent pool.</p>
      </section>
      <section aria-label="Coordinator Chat">
        <h2>Coordinator Chat</h2>
        <p><span>Coordinator</span>: submit a request for project work.</p>
      </section>
      <div className="dashboard-actions"><button type="button">Pause All</button><button type="button">New Request</button></div>
    </div>
  );
}
