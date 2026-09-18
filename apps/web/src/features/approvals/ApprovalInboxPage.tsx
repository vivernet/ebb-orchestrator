import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

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
  scope: 'once' | 'run' | 'task' | 'project';
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
  EPIC: 'project',
  PROJECT: 'project',
  RUN: 'run',
};

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
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
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export default function ApprovalInboxPage({ projectId }: ApprovalInboxProps) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiClient.get<{ approvals: ApprovalRow[] }>('/approvals');
      setApprovals(data.approvals.map(mapApprovalRow));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchApprovals();
  }, [fetchApprovals, projectId]);

  const handleApprove = async (id: string) => {
    setMutationError(null);
    try {
      await apiClient.post(`/approvals/${encodeURIComponent(id)}/approve`, {});
      setApprovals((prev) => prev.map((approval) => approval.id === id ? { ...approval, status: 'approved' } : approval));
    } catch (error) {
      setMutationError(errorMessage(error));
    }
  };

  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  if (loading) return <div>Loading approvals...</div>;

  if (loadError) {
    return <div className="approval-inbox-page"><h1>Approval Inbox</h1><p role="alert">Unable to load approvals: {loadError}</p><button type="button" onClick={() => void fetchApprovals()}>Retry</button></div>;
  }

  return (
    <div className="approval-inbox-page">
      <h1>Approval Inbox</h1>
      {mutationError && <p role="alert">Unable to update approval: {mutationError} <button type="button" onClick={() => { setMutationError(null); void fetchApprovals(); }}>Retry</button></p>}
      {pendingApprovals.length === 0 ? <p>No pending approvals.</p> : (
        <ul className="approval-list">
          {pendingApprovals.map((approval) => (
            <li key={approval.id} className="approval-item">
              <div className="approval-header"><strong>{approval.action}</strong><span className="approval-scope">{approval.scope}</span></div>
              <p className="approval-description">{approval.description}</p>
              <div className="approval-context"><small>Requested by: {approval.requestedBy}</small></div>
              <div className="approval-actions"><button type="button" onClick={() => void handleApprove(approval.id)}>Approve</button></div>
              <div className="approval-meta"><small>Created: {new Date(approval.createdAt).toLocaleString()}</small></div>
            </li>
          ))}
        </ul>
      )}
      {approvals.some((approval) => approval.status !== 'pending') && (
        <section><h2>Previous Approvals</h2><ul className="approval-list">
          {approvals.filter((approval) => approval.status !== 'pending').map((approval) => (
            <li key={approval.id} className="approval-item"><div className="approval-header"><strong>{approval.action}</strong><span className={`approval-status status-${approval.status}`}>{approval.status}</span></div><p className="approval-description">{approval.description}</p><div className="approval-meta"><small>Created: {new Date(approval.createdAt).toLocaleString()}</small></div></li>
          ))}
        </ul></section>
      )}
    </div>
  );
}
