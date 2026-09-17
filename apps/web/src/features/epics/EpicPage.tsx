import { useEffect, useState } from 'react';
import type { EpicOverviewProjection } from '@ebb-orchestrator/contracts';
import { apiClient } from '../../api/client.js';

interface EpicPageProps {
  id: string;
}

export default function EpicPage({ id }: EpicPageProps) {
  const [projection, setProjection] = useState<EpicOverviewProjection | null>(null);
  useEffect(() => { void apiClient.get<EpicOverviewProjection>(`/epics/${encodeURIComponent(id)}`).then(setProjection).catch(() => undefined); }, [id]);
  const epic = projection?.epic as { title?: string; display_id?: string; status?: string } | undefined;
  return (
    <div className="epic-page">
      <h1>Epic: {epic?.title ?? epic?.display_id ?? id}</h1>
      <section aria-label="Epic details">
        <h2>Details</h2>
        <p>{epic ? `${epic.status ?? 'Unknown'} · ${projection?.tasks.length ?? 0} tasks` : 'Loading epic projection…'}</p>
        {projection && <p>Usage: {projection.usage.totalTokens} tokens · ${projection.usage.cost.toFixed(2)}</p>}
      </section>
       <section aria-label="Epic lifecycle and parallel work graph"><h2>Lifecycle / parallel work graph</h2><p>{projection?.lifecycle.stage ?? epic?.status ?? 'No lifecycle stage recorded'} · {projection?.tasks.length ?? 0} tasks</p></section>
       <section aria-label="Epic Contract"><h2>Epic Contract</h2><p>{projection?.contract ? JSON.stringify(projection.contract) : 'No contract recorded.'}</p></section>
       <section aria-label="Epic branch and approvals"><h2>Branch / approvals / blockers</h2><p>{projection?.git.branch ?? 'No branch recorded'} · {projection?.git.repositoryPath ?? 'No repository recorded'} · {projection?.approvals.length ?? 0} approvals · {projection?.blockers.length ?? 0} blockers</p></section>
       <section aria-label="Epic events and stages"><h2>Events / review / QA / merge</h2><p>{projection?.events.length ?? 0} events</p></section>
      <section aria-label="Epic tasks">
        <h2>Tasks</h2>
        <ul>{projection?.tasks.map((task) => { const item = task as { id?: string; title?: string; display_id?: string; status?: string }; return <li key={item.id}>{item.title ?? item.display_id ?? item.id} · {item.status}</li>; })}</ul>
      </section>
    </div>
  );
}
