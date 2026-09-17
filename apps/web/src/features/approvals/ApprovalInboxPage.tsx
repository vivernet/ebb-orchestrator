import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

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

export default function ApprovalInboxPage({ projectId }: ApprovalInboxProps) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const fetchApprovals = async () => {
      try {
        const data = await apiClient.get<Approval[]>('/approvals');
        setApprovals(data);
      } catch (e) {
        console.error('Failed to fetch approvals:', e);
      } finally {
        setLoading(false);
      }
    };
    void fetchApprovals();
  }, [projectId]);

  const handleAction = async (id: string, action: 'approve' | 'reject' | 'changes_requested') => {
    try {
      await apiClient.post(`/approvals/${encodeURIComponent(id)}/${action}`, {});
      setApprovals((prev) =>
        prev.map((a) =>
          a.id === id ? { ...a, status: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested' } : a
        )
      );
    } catch (e) {
      console.error('Failed to update approval:', e);
    }
  };

  const pendingApprovals = approvals.filter((a) => a.status === 'pending');

  if (loading) {
    return <div>Loading approvals...</div>;
  }

  return (
    <div className="approval-inbox-page">
      <h1>Approval Inbox</h1>

      {pendingApprovals.length === 0 ? (
        <p>No pending approvals.</p>
      ) : (
        <ul className="approval-list">
          {pendingApprovals.map((approval) => (
            <li key={approval.id} className="approval-item">
              <div className="approval-header">
                <strong>{approval.action}</strong>
                <span className="approval-scope">{approval.scope}</span>
              </div>
              <p className="approval-description">{approval.description}</p>
              <div className="approval-context">
                <small>Requested by: {approval.requestedBy}</small>
              </div>
              <div className="approval-actions">
                <button onClick={() => handleAction(approval.id, 'approve')}>Approve</button>
                <button onClick={() => handleAction(approval.id, 'reject')}>Reject</button>
                <button onClick={() => handleAction(approval.id, 'changes_requested')}>Request Changes</button>
              </div>
              <div className="approval-meta">
                <small>Created: {new Date(approval.createdAt).toLocaleString()}</small>
              </div>
            </li>
          ))}
        </ul>
      )}

      {approvals.filter((a) => a.status !== 'pending').length > 0 && (
        <section>
          <h2>Previous Approvals</h2>
          <ul className="approval-list">
            {approvals
              .filter((a) => a.status !== 'pending')
              .map((approval) => (
                <li key={approval.id} className="approval-item">
                  <div className="approval-header">
                    <strong>{approval.action}</strong>
                    <span className={`approval-status status-${approval.status}`}>{approval.status}</span>
                  </div>
                  <p className="approval-description">{approval.description}</p>
                  <div className="approval-meta">
                    <small>Created: {new Date(approval.createdAt).toLocaleString()}</small>
                  </div>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
