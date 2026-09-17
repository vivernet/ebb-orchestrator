import { useEffect, useState } from 'react';
import { apiClient } from '../../api/client.js';

interface ExecutionQueueEntry {
  id: string;
  role: string;
  taskId?: string;
  epicId?: string;
  status: 'queued' | 'waiting' | 'running' | 'blocked';
  waitReason?: {
    type: 'dependency' | 'role_slot' | 'global_limit' | 'approval' | 'budget' | 'resource_lock';
    message: string;
  };
  createdAt: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
}

interface ExecutionPageProps {
  projectId?: string;
}

export default function ExecutionPage({ projectId }: ExecutionPageProps) {
  const [queue, setQueue] = useState<ExecutionQueueEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const fetchQueue = async () => {
      try {
        const data = await apiClient.get<ExecutionQueueEntry[]>('/execution/queue');
        setQueue(data);
      } catch (e) {
        console.error('Failed to fetch execution queue:', e);
      } finally {
        setLoading(false);
      }
    };
    void fetchQueue();
  }, [projectId]);

  const handleCancel = async (id: string) => {
    try {
      await apiClient.post(`/execution/${encodeURIComponent(id)}/cancel`, {});
      setQueue((prev) => prev.filter((e) => e.id !== id));
    } catch (e) {
      console.error('Failed to cancel execution:', e);
    }
  };

  const handlePause = async (id: string) => {
    try {
      await apiClient.post(`/execution/${encodeURIComponent(id)}/pause`, {});
      setQueue((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, status: 'blocked' as const } : e
        )
      );
    } catch (e) {
      console.error('Failed to pause execution:', e);
    }
  };

  if (loading) {
    return <div>Loading execution queue...</div>;
  }

  return (
    <div className="execution-page">
      <h1>Execution Monitor</h1>

      {queue.length === 0 ? (
        <p>No items in execution queue.</p>
      ) : (
        <table className="execution-queue-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Target</th>
              <th>Status</th>
              <th>Wait Reason</th>
              <th>Priority</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((entry) => (
              <tr key={entry.id} className={`entry-status-${entry.status}`}>
                <td>{entry.role}</td>
                <td>
                  {entry.taskId && <span className="entry-task">Task: {entry.taskId}</span>}
                  {entry.epicId && <span className="entry-epic">Epic: {entry.epicId}</span>}
                </td>
                <td>{entry.status.toUpperCase()}</td>
                <td className="wait-reason">
                  {entry.waitReason ? (
                    <span title={entry.waitReason.message}>{entry.waitReason.type}</span>
                  ) : (
                    '-'
                  )}
                </td>
                <td className={`priority-${entry.priority}`}>{entry.priority.toUpperCase()}</td>
                <td className="entry-actions">
                  {entry.status !== 'blocked' && (
                    <button onClick={() => handlePause(entry.id)}>
                      Pause
                    </button>
                  )}
                  <button onClick={() => handleCancel(entry.id)}>Cancel</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="execution-summary">
        <h2>Summary</h2>
        <div className="summary-stats">
          <div className="stat">
            <span className="stat-value">{queue.filter((e) => e.status === 'running').length}</span>
            <span className="stat-label">Running</span>
          </div>
          <div className="stat">
            <span className="stat-value">{queue.filter((e) => e.status === 'queued' || e.status === 'waiting').length}</span>
            <span className="stat-label">Queued</span>
          </div>
          <div className="stat">
            <span className="stat-value">{queue.filter((e) => e.status === 'blocked').length}</span>
            <span className="stat-label">Blocked</span>
          </div>
        </div>
      </section>
    </div>
  );
}
