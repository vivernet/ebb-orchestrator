import { useCallback, useEffect, useState } from 'react';
import type { DashboardProjection, ExecutionQueueProjection } from '@ebb-orchestrator/contracts';
import { apiClient } from '../../api/client.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export default function DashboardPage() {
  const [projection, setProjection] = useState<DashboardProjection | null>(null);
  const [queue, setQueue] = useState<ExecutionQueueProjection | null>(null);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  const fetchProjection = useCallback(async () => {
    setProjectionError(null);
    try {
      setProjection(await apiClient.get<DashboardProjection>('/dashboard'));
    } catch (error) {
      setProjectionError(message(error));
    }
  }, []);

  const fetchQueue = useCallback(async () => {
    setQueueError(null);
    try {
      setQueue(await apiClient.get<ExecutionQueueProjection>('/execution'));
    } catch (error) {
      setQueueError(message(error));
    }
  }, []);

  useEffect(() => {
    void fetchProjection();
    void fetchQueue();
  }, [fetchProjection, fetchQueue]);

  useOnSSEReconnect(() => {
    void fetchProjection();
    void fetchQueue();
  });

  return (
    <div className="dashboard-page">
      <h1>Dashboard</h1>
      <section aria-label="Running agents"><h2>Running agents</h2>{projectionError ? <p role="alert">Unable to load dashboard: {projectionError}</p> : projection ? <><p>{projection.activeAgents.length} active agent{projection.activeAgents.length === 1 ? '' : 's'}</p><ul>{projection.activeAgents.map((agent) => <li key={agent.runId}>{agent.role} · {agent.status}</li>)}</ul></> : <p>Loading dashboard…</p>}</section>
      <section aria-label="Active work"><h2>Active work</h2>{projection && <><p>{projection.activeWork.length} work item{projection.activeWork.length === 1 ? '' : 's'}</p><ul>{projection.activeWork.map((work) => <li key={work.id}>{work.title || work.id} · {work.status}</li>)}</ul></>}</section>
      <section aria-label="Need approval"><h2>Need approval</h2>{projection && <p>{projection.approvals} pending approval{projection.approvals === 1 ? '' : 's'}</p>}</section>
      <section aria-label="AI spend"><h2>AI spend</h2>{projection && <p>{projection.usage.totalTokens} tokens · ${projection.usage.cost.toFixed(2)}</p>}</section>
      <section aria-label="Active projects"><h2>Active projects</h2>{projection && <ul>{projection.projects.map((project) => <li key={project.id}>{project.displayName || project.name} · {project.status}</li>)}</ul>}</section>
      <section aria-label="Queue"><h2>Queue</h2>{queueError ? <><p role="alert">Unable to load queue: {queueError}</p><button type="button" onClick={() => void fetchQueue()}>Retry</button></> : queue ? <><p>{`${queue.waiting.length} waiting, ${queue.blocked.length} blocked`}</p><ul>{queue.waiting.map((item) => <li key={`waiting-${item.taskId}`}>{item.taskId}: {item.reason.message}</li>)}</ul></> : <p>Loading queue…</p>}</section>
      <section aria-label="Approval Inbox summary"><h2>Approval Inbox summary</h2>{projection && <p>{projection.approvals} approval{projection.approvals === 1 ? '' : 's'} require attention.</p>}</section>
      <section aria-label="Agent Pool"><h2>Agent Pool</h2>{projection && <p>{projection.activeAgents.length} active of the available agent pool.</p>}</section>
      <section aria-label="Coordinator Chat"><h2>Coordinator Chat</h2><p><span>Coordinator</span>: submit a request for project work.</p></section>
      {projectionError && <button type="button" onClick={() => void fetchProjection()}>Retry</button>}
    </div>
  );
}
