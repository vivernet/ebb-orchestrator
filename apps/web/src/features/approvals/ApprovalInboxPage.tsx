import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { apiClient, toClientPath } from '../../api/client.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';

interface ApprovalRow {
  id: string;
  type: string;
  subject_id: string;
  subject_type: string;
  status: string;
  requested_by: string;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface Approval {
  id: string;
  scope: 'once' | 'run' | 'task' | 'epic' | 'project';
  action: string;
  description: string;
  requestedBy: string;
  context: string;
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  createdAt: string;
}

interface ApprovalInboxProps {
  projectId?: string;
}

const statusMap: Record<string, Approval['status']> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CHANGES_REQUESTED: 'changes_requested',
};

const scopeMap: Record<string, Approval['scope']> = {
  TASK: 'task',
  EPIC: 'epic',
  PROJECT: 'project',
  RUN: 'run',
};

/**
 * Представляет пользовательский экран ApprovalInboxPage; авторитетные проверки выполняются backend.
 */
export function mapApprovalRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    scope: scopeMap[row.subject_type] ?? 'once',
    action: row.type,
    description: `${row.subject_type} ${row.subject_id}`,
    requestedBy: row.requested_by,
    context: row.resolution_note ?? '',
    status: statusMap[row.status] ?? 'pending',
    createdAt: row.created_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Представляет пользовательский экран ApprovalInboxPage; авторитетные проверки выполняются backend.
 */
export default function ApprovalInboxPage({ projectId }: ApprovalInboxProps) {
  void projectId;
  const queryStore = useMemo(() => createQueryStore(), []);
  const approvalsPath = toClientPath(apiPaths.approvals);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<{ approvals: ApprovalRow[] }>(approvalsPath, { signal }), [approvalsPath]);
  const query = useQuery(queryStore, approvalsPath, undefined, fetcher);
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [mutationState, setMutationState] = useState<MutationState<unknown>>(() => mutationStore.get('approve'));
  useEffect(() => mutationStore.subscribe('approve', setMutationState), [mutationStore]);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const handleApprove = async (id: string) => {
    await mutationStore.execute('approve', () => apiClient.post(toClientPath(apiPaths.approvalApprove(id)), {}), query.refetch).catch(() => undefined);
  };

  const approvals = query.data?.approvals.map(mapApprovalRow) ?? [];
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  if (query.status === 'loading' || query.status === 'idle') return <div>Loading approvals...</div>;

  if (query.status === 'error' || !query.data) {
    return <div className="approval-inbox-page"><h1>Approval Inbox</h1><p role="alert">Unable to load approvals: {errorMessage(query.error)}</p><button type="button" onClick={retry}>Retry</button></div>;
  }

  return (
    <div className="approval-inbox-page">
      <h1>Approval Inbox</h1>
      {mutationState.status === 'error' && <p role="alert">Unable to update approval: {errorMessage(mutationState.error)} <button type="button" onClick={retry}>Retry</button></p>}
      {pendingApprovals.length === 0 ? <p>No pending approvals.</p> : (
        <ul className="approval-list">
          {pendingApprovals.map((approval) => (
            <li key={approval.id} className="approval-item">
              <div className="approval-header"><strong>{approval.action}</strong><span className="approval-scope">{approval.scope}</span></div>
              <p className="approval-description">{approval.description}</p>
              <div className="approval-context"><small>Requested by: {approval.requestedBy}</small></div>
              <div className="approval-actions"><button type="button" disabled={mutationState.status === 'pending'} onClick={() => void handleApprove(approval.id)}>Approve</button></div>
              <div className="approval-meta"><small>Created: {new Date(approval.createdAt).toLocaleString()}</small></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
