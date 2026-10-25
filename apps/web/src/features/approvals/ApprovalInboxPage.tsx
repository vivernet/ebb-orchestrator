import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  apiPaths,
  approvalDetailProjectionSchema,
  approvalInboxProjectionSchema,
  type ApprovalDetailProjection,
  type ApprovalInboxItemProjection,
} from '@ebb-orchestrator/contracts';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage, approvalSubjectLabel, approvalTypeLabel, ru } from '../../i18n/ru.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Сводка inbox независимо от wire-формы (typed projection или legacy approvals). */
interface InboxSummary {
  totalPending: number;
  totalResolved: number;
  oldestPendingCreatedAt: string | null;
}

/** Единое представление записи очереди для UI. */
interface ApprovalItemView {
  id: string;
  status: 'PENDING' | 'RESOLVED';
  priority: string | null;
  category: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** Legacy-строка для обратно-совместимого отображения детали без detail-эндпоинта. */
  legacy: Approval | null;
}

function normalizeInboxPayload(raw: unknown, filter: 'pending' | 'resolved'): { items: ApprovalItemView[]; summary: InboxSummary } {
  const typed = approvalInboxProjectionSchema.safeParse(raw);
  if (typed.success) {
    const data = typed.data;
    const items: ApprovalItemView[] = data.items
      .filter((item) => (filter === 'pending' ? item.status === 'PENDING' : item.status === 'RESOLVED'))
      .map((item: ApprovalInboxItemProjection) => ({
        id: item.id,
        status: item.status,
        priority: item.priority,
        category: item.category,
        title: item.title,
        projectId: item.projectId,
        createdAt: item.createdAt,
        resolvedAt: item.resolvedAt,
        legacy: null,
      }));
    return {
      items,
      summary: {
        totalPending: data.summary.totalPending,
        totalResolved: data.summary.totalResolved,
        oldestPendingCreatedAt: data.summary.oldestPendingCreatedAt,
      },
    };
  }
  if (isRecord(raw) && Array.isArray(raw.approvals)) {
    const rows = (raw.approvals as unknown[]).map((row) => mapApprovalRow(row as ApprovalRow));
    const matching = rows.filter((row) => (filter === 'pending' ? row.status === 'pending' : row.status !== 'pending'));
    const pending = matching.filter((row) => row.status === 'pending');
    const resolved = matching.filter((row) => row.status !== 'pending');
    let oldest: string | null = null;
    for (const row of pending) {
      if (oldest === null || row.createdAt < oldest) oldest = row.createdAt;
    }
    return {
      items: matching.map((row): ApprovalItemView => ({
        id: row.id,
        status: row.status === 'pending' ? 'PENDING' : 'RESOLVED',
        priority: null,
        category: row.action,
        title: `${approvalTypeLabel(row.action)} · ${approvalSubjectDescription(row.description)}`,
        projectId: null,
        createdAt: row.createdAt,
        resolvedAt: row.context || null,
        legacy: row,
      })),
      summary: { totalPending: pending.length, totalResolved: resolved.length, oldestPendingCreatedAt: oldest },
    };
  }
  throw new ApiError(ru.errors.default, 0, 'INVALID_RESPONSE');
}

const priorityLabels: Record<string, string> = {
  LOW: 'Низкий', MEDIUM: 'Средний', HIGH: 'Высокий', CRITICAL: 'Критический',
};

const outcomeLabels: Record<string, string> = {
  APPROVED: 'Согласовано', REJECTED: 'Отклонено', CHANGES_REQUESTED: 'Запрошены изменения',
};

/**
 * Представляет пользовательский экран ApprovalInboxPage; авторитетные проверки выполняются backend.
 */
export default function ApprovalInboxPage(_props: ApprovalInboxProps) {
  const queryStore = useMemo(() => createQueryStore(), []);
  const [filter, setFilter] = useState<'pending' | 'resolved'>('pending');
  const approvalsPath = toClientPath(filter === 'pending' ? apiPaths.approvals : apiPaths.approvalsList('resolved'));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<unknown>(approvalsPath, { signal }).then((raw) => normalizeInboxPayload(raw, filter)), [approvalsPath, filter]);
  const query = useQuery(queryStore, approvalsPath, undefined, fetcher);
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [mutationState, setMutationState] = useState<MutationState<unknown>>(() => mutationStore.get('approve'));
  useEffect(() => mutationStore.subscribe('approve', setMutationState), [mutationStore]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisionBlocked, setDecisionBlocked] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error';
    data: ApprovalDetailProjection | null;
    error: unknown | null;
  }>({ status: 'idle', data: null, error: null });
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const items = query.data?.items ?? [];
  const summary = query.data?.summary;
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  const loadDetail = useCallback((id: string) => {
    setDetail({ status: 'loading', data: null, error: null });
    apiClient.get<unknown>(toClientPath(apiPaths.approval(id)))
      .then((raw) => {
        const parsed = approvalDetailProjectionSchema.safeParse(raw);
        if (!parsed.success) throw new ApiError(ru.errors.default, 0, 'INVALID_RESPONSE');
        setDetail({ status: 'success', data: parsed.data, error: null });
      })
      .catch((error: unknown) => setDetail({ status: 'error', data: null, error }));
  }, []);

  const selectItem = useCallback((id: string) => {
    setSelectedId(id);
    setDecisionBlocked(null);
    loadDetail(id);
  }, [loadDetail]);

  const switchFilter = useCallback((next: 'pending' | 'resolved') => {
    setFilter(next);
    setSelectedId(null);
    setDetail({ status: 'idle', data: null, error: null });
    setDecisionBlocked(null);
  }, []);

  const decisionBody = (id: string) => {
    const note = notes[id]?.trim();
    return note ? { note } : {};
  };

  const effectiveStatus = detail.data ? detail.data.status : selected?.status ?? 'PENDING';

  /**
   * Проверяет текущее состояние перед решением: если запись уже решена
   * (по списку или по подтверждённой детальной проекции), команда не отправляется.
   */
  const runDecision = async (id: string, action: 'approve' | 'reject' | 'request-changes') => {
    if (effectiveStatus !== 'PENDING') {
      setDecisionBlocked('Это согласование уже решено; действие не отправлено.');
      return;
    }
    setDecisionBlocked(null);
    const key = action === 'approve' ? 'approve' : action === 'reject' ? 'reject' : 'request-changes';
    const path = action === 'approve'
      ? toClientPath(apiPaths.approvalApprove(id))
      : action === 'reject'
        ? toClientPath(apiPaths.approvalReject(id))
        : toClientPath(apiPaths.approvalRequestChanges(id));
    await mutationStore.execute(key, () => apiClient.post(path, decisionBody(id)), query.refetch).catch(() => undefined);
  };

  const handleApprove = (id: string) => void runDecision(id, 'approve');
  const handleReject = (id: string) => void runDecision(id, 'reject');
  const handleRequestChanges = (id: string) => void runDecision(id, 'request-changes');

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка согласований…" />;

  if (query.status === 'error' || !query.data) {
    return <PageState status="error" title="Входящие согласования" message={`Не удалось загрузить согласования: ${errorMessage(query.error)}`} onRetry={retry} />;
  }

  const pendingCount = summary?.totalPending ?? items.filter((item) => item.status === 'PENDING').length;
  const resolvedCount = summary?.totalResolved ?? items.filter((item) => item.status === 'RESOLVED').length;
  const highPriority = items.filter((item) => item.priority === 'HIGH' || item.priority === 'CRITICAL').length;
  const oldestAt = summary?.oldestPendingCreatedAt ?? null;
  const isResolvedView = filter === 'resolved';

  return (
    <div className="approval-inbox-page page-stack reference-screen reference-screen--approvals">
      <div className="topbar">
        <div>
          <h1>Входящие согласования</h1>
          <div className="sub">{`${pendingCount} ожидают решения`}</div>
        </div>
        <div className="top-actions">
          <Link className="btn-ghost" to="/settings">Политики согласований</Link>
        </div>
      </div>

      <section className="reference-metrics" aria-label="Сводка согласований">
        <div className="reference-metric"><span>Ожидают</span><strong>{pendingCount}</strong></div>
        <div className="reference-metric"><span>Решённые</span><strong>{resolvedCount}</strong></div>
        {!isResolvedView && <div className="reference-metric"><span>Высокий приоритет</span><strong>{highPriority}</strong></div>}
        <div className="reference-metric"><span>Самый давний запрос</span><strong>{oldestAt ? new Date(oldestAt).toLocaleString() : '—'}</strong></div>
      </section>

      <div className="reference-tabs" role="tablist" aria-label="Фильтр согласований">
        <button type="button" role="tab" aria-selected={filter === 'pending'} className={filter === 'pending' ? 'tab active' : 'tab'} onClick={() => switchFilter('pending')}>Ожидают решения</button>
        <button type="button" role="tab" aria-selected={filter === 'resolved'} className={filter === 'resolved' ? 'tab active' : 'tab'} onClick={() => switchFilter('resolved')}>Решённые</button>
      </div>

      {mutationState.status === 'error' && <ErrorAlert message={`Не удалось обновить согласование: ${errorMessage(mutationState.error)}`} onRetry={retry} />}
      {decisionBlocked && <ErrorAlert message={decisionBlocked} />}

      {items.length === 0 ? <EmptyState message={isResolvedView ? 'Решённых согласований нет.' : 'Нет согласований, ожидающих решения.'} /> : (
        <div className="approval-layout">
          <section className="reference-panel approval-queue" aria-label="Очередь согласований">
            <div className="section-heading"><h2>{isResolvedView ? 'Решённые' : 'Ожидают решения'}</h2><span>{items.length}</span></div>
            <ul className="approval-list">
              {items.map((item) => (
                <li key={item.id} className="approval-item">
                  <button
                    type="button"
                    className="approval-select"
                    aria-pressed={selected?.id === item.id}
                    onClick={() => selectItem(item.id)}
                  >
                    <span className="approval-select__title">{item.title}</span>
                    {item.priority && <span className="approval-select__meta"><StatusBadge status={item.priority} label={priorityLabels[item.priority] ?? item.priority} /></span>}
                    {item.projectId && <span className="approval-select__meta">Проект: {item.projectId}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {selected && (
            <section className="reference-panel approval-detail" aria-label="Детали согласования">
              {detail.status === 'success' && detail.data ? (
                <TypedApprovalDetail data={detail.data} isResolved={selected.status === 'RESOLVED'} />
              ) : selected.legacy ? (
                <LegacyApprovalDetail approval={selected.legacy} />
              ) : (
                <div>
                  <div className="section-heading"><div><h2>{selected.title}</h2></div></div>
                  <dl className="approval-facts">
                    <div><dt>Категория</dt><dd>{approvalTypeLabel(selected.category)}</dd></div>
                    <div><dt>Создано</dt><dd><time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleString()}</time></dd></div>
                  </dl>
                  <p className="reference-callout">Детальная проекция недоступна; показана краткая запись из списка.</p>
                </div>
              )}

              {selected.status === 'PENDING' ? (
                <>
                  <div className="approval-content">
                    <label htmlFor={`approval-note-${selected.id}`}>Комментарий к решению</label>
                    <textarea
                      id={`approval-note-${selected.id}`}
                      value={notes[selected.id] ?? ''}
                      onChange={(event) => setNotes((prev) => ({ ...prev, [selected.id]: event.target.value }))}
                      placeholder="Комментарий (необязательно)…"
                      rows={3}
                      maxLength={2000}
                    />
                  </div>
                  <div className="approval-actions">
                    <button type="button" className="btn-good" disabled={mutationState.status === 'pending'} onClick={() => handleApprove(selected.id)}>Согласовать</button>
                    <button type="button" className="btn-bad" disabled={mutationState.status === 'pending'} onClick={() => handleReject(selected.id)}>Отклонить</button>
                    <button type="button" className="btn-ghost" disabled={mutationState.status === 'pending'} onClick={() => handleRequestChanges(selected.id)}>Запросить изменения</button>
                  </div>
                </>
              ) : (
                <p className="reference-callout">Согласование решено; повторные решения не отправляются.</p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function LegacyApprovalDetail({ approval }: { approval: Approval }) {
  return (
    <>
      <div className="section-heading">
        <div><h2>{approvalTypeLabel(approval.action)}</h2><p>{approvalSubjectDescription(approval.description)}</p></div>
        <StatusBadge status={approval.scope} label={approval.scope} />
      </div>
      <dl className="approval-facts">
        <div><dt>Запросил</dt><dd>{approval.requestedBy}</dd></div>
        <div><dt>Создано</dt><dd><time dateTime={approval.createdAt}>{new Date(approval.createdAt).toLocaleString()}</time></dd></div>
      </dl>
      <p className="reference-callout">Текущий API предоставляет только краткую запись согласования, без связанного evidence или истории изменений.</p>
    </>
  );
}

function TypedApprovalDetail({ data, isResolved }: { data: ApprovalDetailProjection; isResolved: boolean }) {
  return (
    <>
      <div className="section-heading">
        <div><h2>{data.proposal.title}</h2><p>{data.project.displayName}</p></div>
        <div className="approval-select__meta">
          <StatusBadge status={data.priority} label={priorityLabels[data.priority] ?? data.priority} />
          <StatusBadge status={data.category} label={approvalTypeLabel(data.category)} />
        </div>
      </div>

      <div className="approval-section">
        <h3>Что предлагается</h3>
        <p className="reference-callout">{data.proposal.summary}</p>
      </div>
      <div className="approval-section">
        <h3>Почему</h3>
        <p>{data.rationale}</p>
      </div>
      <div className="approval-section">
        <h3>Изменение плана</h3>
        <div className="approval-diff">
          <div><strong>BEFORE</strong><span>{data.planDiff.before.title} · {data.planDiff.before.scope}</span></div>
          <div><strong>AFTER</strong><span>{data.planDiff.after.title} · {data.planDiff.after.scope}</span></div>
        </div>
      </div>
      <div className="approval-section">
        <h3>Влияние</h3>
        <dl className="approval-facts">
          <div><dt>Область</dt><dd>{data.impacts.scope}</dd></div>
          <div><dt>Назначенная роль</dt><dd>{data.impacts.role}</dd></div>
          <div><dt>Архитектура</dt><dd>{data.impacts.architecture}</dd></div>
          <div><dt>Расчётная задержка</dt><dd>{data.impacts.delayDays === null ? 'не рассчитано' : `${data.impacts.delayDays} дн.`}</dd></div>
          <div><dt>Влияние на бюджет</dt><dd>{data.impacts.budgetCost === null ? 'не рассчитано' : `$${data.impacts.budgetCost.toFixed(2)}`}</dd></div>
        </dl>
      </div>
      <div className="approval-section">
        <h3>Подтверждения</h3>
        {data.evidence.length === 0 ? <p>Подтверждений нет.</p> : (
          <div className="approval-timeline">
            {data.evidence.map((entry) => (
              <div key={entry.id} className="approval-evidence">
                <strong>{approvalTypeLabel(entry.kind)}</strong>
                <span>{entry.description}</span>
                <small>{entry.source} · <time dateTime={entry.capturedAt}>{new Date(entry.capturedAt).toLocaleString()}</time></small>
              </div>
            ))}
          </div>
        )}
      </div>
      {data.decision ? (
        <div className="approval-section">
          <h3>Решение</h3>
          <dl className="approval-facts">
            <div><dt>Действие</dt><dd>{outcomeLabels[data.decision.outcome] ?? data.decision.outcome}</dd></div>
            <div><dt>Кто решил</dt><dd>{data.decision.actor}</dd></div>
            <div><dt>Когда</dt><dd><time dateTime={data.decision.at}>{new Date(data.decision.at).toLocaleString()}</time></dd></div>
            {data.decision.note && <div><dt>Комментарий</dt><dd>{data.decision.note}</dd></div>}
          </dl>
        </div>
      ) : !isResolved && (
        <p className="reference-callout">Решение ещё не принято.</p>
      )}
    </>
  );
}
