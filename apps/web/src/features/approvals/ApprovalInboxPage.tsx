import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPaths } from '@ebb-orchestrator/contracts';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage, approvalSubjectLabel, approvalTypeLabel } from '../../i18n/ru.js';

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
  projectId?: never;
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

function approvalSubjectDescription(description: string): string {
  const separator = description.indexOf(' ');
  const type = separator < 0 ? description : description.slice(0, separator);
  const id = separator < 0 ? '' : description.slice(separator + 1);
  return [approvalSubjectLabel(type), id].filter(Boolean).join(' ');
}

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/**
 * Представляет пользовательский экран ApprovalInboxPage; авторитетные проверки выполняются backend.
 */
export default function ApprovalInboxPage(_props: ApprovalInboxProps) {
  const queryStore = useMemo(() => createQueryStore(), []);
  const approvalsPath = toClientPath(apiPaths.approvals);
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<{ approvals: ApprovalRow[] }>(approvalsPath, { signal }), [approvalsPath]);
  const query = useQuery(queryStore, approvalsPath, undefined, fetcher);
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [mutationState, setMutationState] = useState<MutationState<unknown>>(() => mutationStore.get('approve'));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => mutationStore.subscribe('approve', setMutationState), [mutationStore]);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const decisionBody = (id: string) => {
    const note = notes[id]?.trim();
    return note ? { note } : {};
  };

  const handleApprove = async (id: string) => {
    await mutationStore.execute('approve', () => apiClient.post(toClientPath(apiPaths.approvalApprove(id)), decisionBody(id)), query.refetch).catch(() => undefined);
  };

  const handleReject = async (id: string) => {
    await mutationStore.execute('reject', () => apiClient.post(toClientPath(apiPaths.approvals + '/' + id + '/reject'), decisionBody(id)), query.refetch).catch(() => undefined);
  };

  const handleRequestChanges = async (id: string) => {
    await mutationStore.execute('request-changes', () => apiClient.post(toClientPath(apiPaths.approvals + '/' + id + '/request-changes'), decisionBody(id)), query.refetch).catch(() => undefined);
  };

  const согласований = query.data?.approvals.map(mapApprovalRow) ?? [];
  const pendingApprovals = согласований.filter((approval) => approval.status === 'pending');
  const selectedApproval = pendingApprovals.find((approval) => approval.id === selectedId) ?? pendingApprovals[0] ?? null;

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка согласований…" />;

  if (query.status === 'error' || !query.data) {
    return <PageState status="error" title="Входящие согласования" message={`Не удалось загрузить согласования: ${errorMessage(query.error)}`} onRetry={retry} />;
  }

  return (
    <div className="approval-inbox-page page-stack reference-screen reference-screen--approvals">
      <div className="topbar">
        <div>
          <h1>Входящие согласования</h1>
          <div className="sub">{`${pendingApprovals.length} ожидают решения`}</div>
        </div>
      </div>
      {mutationState.status === 'error' && <ErrorAlert message={`Не удалось обновить согласование: ${errorMessage(mutationState.error)}`} onRetry={retry} />}
      {pendingApprovals.length === 0 ? <EmptyState message="Нет согласований, ожидающих решения." /> : (
        <div className="approval-layout">
          <section className="reference-panel approval-queue" aria-label="Очередь согласований">
            <div className="section-heading"><h2>Ожидают решения</h2><span>{pendingApprovals.length}</span></div>
            <ul className="approval-list">
              {pendingApprovals.map((approval) => (
                <li key={approval.id} className="approval-item">
                  <button
                    type="button"
                    className="approval-select"
                    aria-pressed={selectedApproval?.id === approval.id}
                    onClick={() => setSelectedId(approval.id)}
                  >
                    <span className="approval-select__title">{approvalTypeLabel(approval.action)}</span>
                    <span className="approval-select__subject">{approvalSubjectDescription(approval.description)}</span>
                    <span className="approval-select__meta">{approval.requestedBy} · <StatusBadge status={approval.scope} label={approval.scope} /></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {selectedApproval && (
            <section className="reference-panel approval-detail" aria-label="Детали согласования">
              <div className="section-heading">
                <div><h2>{approvalTypeLabel(selectedApproval.action)}</h2><p>{approvalSubjectDescription(selectedApproval.description)}</p></div>
                <StatusBadge status={selectedApproval.scope} label={selectedApproval.scope} />
              </div>
              <dl className="approval-facts">
                <div><dt>Запросил</dt><dd>{selectedApproval.requestedBy}</dd></div>
                <div><dt>Создано</dt><dd><time dateTime={selectedApproval.createdAt}>{new Date(selectedApproval.createdAt).toLocaleString()}</time></dd></div>
              </dl>
              <p className="reference-callout">Текущий API предоставляет только краткую запись согласования, без связанного evidence или истории изменений.</p>
              <div className="approval-content">
                <label htmlFor={`approval-note-${selectedApproval.id}`}>Комментарий к решению</label>
                <textarea
                  id={`approval-note-${selectedApproval.id}`}
                  value={notes[selectedApproval.id] ?? ''}
                  onChange={(event) => setNotes((prev) => ({ ...prev, [selectedApproval.id]: event.target.value }))}
                  placeholder="Комментарий (необязательно)…"
                  rows={3}
                  maxLength={2000}
                />
              </div>
              <div className="approval-actions">
                <button type="button" className="btn-good" disabled={mutationState.status === 'pending'} onClick={() => void handleApprove(selectedApproval.id)}>Согласовать</button>
                <button type="button" className="btn-bad" disabled={mutationState.status === 'pending'} onClick={() => void handleReject(selectedApproval.id)}>Отклонить</button>
                <button type="button" className="btn-ghost" disabled={mutationState.status === 'pending'} onClick={() => void handleRequestChanges(selectedApproval.id)}>Запросить изменения</button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
