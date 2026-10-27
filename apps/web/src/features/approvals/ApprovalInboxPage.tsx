import { useCallback, useMemo, useState } from 'react';
import { ApiError, apiClient, toClientPath } from '../../api/client.js';
import { PageState } from '../../components/ui/PageState.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { createQueryStore } from '../../state/query-store.js';
import { useQuery } from '../../state/use-query.js';
import { apiErrorMessage } from '../../i18n/ru.js';
import { apiPaths } from '@ebb-orchestrator/contracts';
import type { ApprovalInboxItemProjection, ApprovalInboxProjection, ApprovalDetailProjection } from '@ebb-orchestrator/contracts';
import './approvals.css';

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

const inboxStore = createQueryStore();
const detailStore = createQueryStore();

const priorityLabel: Record<string, string> = {
  LOW: 'Низкий',
  MEDIUM: 'Средний',
  HIGH: 'Высокий',
  CRITICAL: 'Критический',
};

/** Локализованная подпись категории согласования. */
function categoryLabel(category: string): string {
  const known: Record<string, string> = {
    PLAN_CHANGE: 'Изменение плана',
    ARCHITECTURE: 'Архитектура',
    PERMISSION: 'Разрешение',
    BUDGET: 'Бюджет',
    FINAL_MERGE: 'Слияние',
    PROVIDER: 'Провайдер',
  };
  return known[category] ?? category;
}

/** Возраст записи в формате «Nm/Nh» для сводки (unavailable, если дата неизвестна). */
function ageLabel(createdAt: string | null): string {
  if (!createdAt) return 'недоступно';
  const diffMs = Date.now() - Date.parse(createdAt);
  if (Number.isNaN(diffMs) || diffMs < 0) return 'недоступно';
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/**
 * Центр согласований (reference 04): очередь решений и панель выбранного
 * evidence. Данные — только из backend-проекций; при отсутствии источника
 * поле рендерится как «недоступно», без подмены mock-значениями.
 */
export default function ApprovalInboxPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'pending' | 'resolved'>('pending');

  const fetcher = useCallback((signal: AbortSignal) =>
    apiClient.get<ApprovalInboxProjection>(toClientPath(apiPaths.approvalsList(tab)), { signal }), [tab]);
  const params = useMemo(() => ({ tab }), [tab]);
  const query = useQuery(inboxStore, apiPaths.approvalsList(tab), params, fetcher);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const items = query.data?.items ?? [];
  const summary = query.data?.summary;
  const selectedItem = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  const detailFetcher = useCallback((signal: AbortSignal) => {
    if (!selectedItem) return Promise.resolve<ApprovalDetailProjection | null>(null);
    return apiClient.get<ApprovalDetailProjection>(toClientPath(apiPaths.approval(selectedItem.id)), { signal });
  }, [selectedItem]);
  const detailParams = useMemo(() => (selectedItem ? { id: selectedItem.id } : undefined), [selectedItem?.id]);
  const detailQuery = useQuery(detailStore, selectedItem ? apiPaths.approval(selectedItem.id) : '', detailParams, detailFetcher, { enabled: selectedItem !== null });
  const detail = detailQuery.data;

  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const decide = useCallback(async (action: 'approve' | 'reject' | 'request-changes') => {
    if (!selectedItem) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const path = action === 'approve'
        ? apiPaths.approvalApprove(selectedItem.id)
        : action === 'reject'
          ? apiPaths.approvalReject(selectedItem.id)
          : apiPaths.approvalRequestChanges(selectedItem.id);
      await apiClient.post(toClientPath(path), {});
      void query.refetch().catch(() => undefined);
      void detailQuery.refetch().catch(() => undefined);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setActionBusy(false);
    }
  }, [selectedItem, query, detailQuery]);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка центра согласований…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить согласования: ${errorMessage(query.error)}`} onRetry={retry} />;

  return (
    <div className="reference-screen approval-inbox-page reference-screen--approvals">
      <div className="pf-topbar">
        <div className="pf-title">
          <h1>Центр согласований</h1>
          <p>Только решения, которые требуют человека. Всё остальное Orchestrator обрабатывает автоматически по policy.</p>
        </div>
        <div className="pf-actions">
          <button type="button" className="pf-btn" onClick={() => setTab(tab === 'pending' ? 'resolved' : 'pending')}>
            {tab === 'pending' ? 'История' : 'Ожидают'}
          </button>
          <button type="button" className="pf-btn">Политики согласований</button>
        </div>
      </div>

      <section className="pf-metrics" aria-label="Сводка согласований">
        <div className="pf-metric"><span>Ожидают</span><b className="ap-warn">{summary ? summary.totalPending : '—'}</b></div>
        <div className="pf-metric"><span>Решённые</span><b>{summary ? summary.totalResolved : '—'}</b></div>
        <div className="pf-metric"><span>Самый давний запрос</span><b>{summary ? ageLabel(summary.oldestPendingCreatedAt) : '—'}</b></div>
      </section>

      {actionError ? <p className="ex-note bad">Не удалось выполнить решение: {actionError}</p> : null}

      <div className="pf-grid">
        <section className="pf-card" aria-label="Очередь согласований">
          <div className="ap-filter">
            <span className={`ap-chip${tab === 'pending' ? ' active' : ''}`} onClick={() => setTab('pending')}>Ожидают {summary?.totalPending ?? '—'}</span>
            <span className={`ap-chip${tab === 'resolved' ? ' active' : ''}`} onClick={() => setTab('resolved')}>Решённые {summary?.totalResolved ?? '—'}</span>
          </div>
          {items.length === 0 ? (
            <div className="ap-muted">Нет согласований в этой категории.</div>
          ) : items.map((item: ApprovalInboxItemProjection) => (
            <div key={item.id} className={`ap-item${selectedItem?.id === item.id ? ' selected' : ''}`} onClick={() => setSelectedId(item.id)}>
              <div>
                <h4>{item.title}</h4>
                <div className="ap-muted">{categoryLabel(item.category)}</div>
                <div className="ap-item-meta">
                  <span className="pf-chip">{priorityLabel[item.priority] ?? item.priority}</span>
                </div>
              </div>
              <div className="ap-warn">{ageLabel(item.createdAt)}</div>
            </div>
          ))}
        </section>

        <aside className="pf-card ap-detail" aria-label="Детали согласования">
          {!selectedItem ? (
            <div className="ap-muted">Выберите согласование из очереди.</div>
          ) : detailQuery.status === 'loading' ? (
            <PageState status="loading" message="Загрузка деталей согласования…" />
          ) : detailQuery.status === 'error' ? (
            <PageState status="error" message={`Не удалось загрузить детали: ${errorMessage(detailQuery.error)}`} onRetry={() => void detailQuery.refetch()} />
          ) : detail ? (
            <>
              <div className="ap-detail-top">
                <div>
                  <h2>{detail.proposal.title}</h2>
                  <div className="ap-muted">Запросил Координатор · {priorityLabel[detail.priority] ?? detail.priority}</div>
                </div>
              </div>

              <div className="ap-section">
                <h3>Что предлагается</h3>
                <div className="ap-note">{detail.proposal.summary || 'недоступно'}</div>
              </div>

              <div className="ap-section">
                <h3>Почему</h3>
                <div className="ap-muted">{detail.rationale || 'недоступно'}</div>
              </div>

              {detail.planDiff ? (
                <div className="ap-section">
                  <h3>Изменение плана</h3>
                  <pre className="ap-diff">{`BEFORE\n${detail.planDiff.before.title} · ${detail.planDiff.before.scope}\n\nAFTER\n${detail.planDiff.after.title} · ${detail.planDiff.after.scope}`}</pre>
                </div>
              ) : null}

              {detail.impacts ? (
                <div className="ap-section">
                  <h3>Влияние</h3>
                  <div className="pf-kv">
                    <div>Область</div><div>{detail.impacts.scope || 'недоступно'}</div>
                    <div>Назначенная роль</div><div>{detail.impacts.role || 'недоступно'}</div>
                    <div>Архитектура</div><div>{detail.impacts.architecture || 'недоступно'}</div>
                    <div>Расчётная задержка</div><div>{detail.impacts.delayDays === null ? 'недоступно' : `${detail.impacts.delayDays} дн.`}</div>
                    <div>Влияние на бюджет</div><div>{detail.impacts.budgetCost === null ? 'недоступно' : `$${detail.impacts.budgetCost.toFixed(2)}`}</div>
                  </div>
                </div>
              ) : null}

              <div className="ap-section">
                <h3>Подтверждения</h3>
                {detail.evidence.length === 0 ? (
                  <div className="ap-muted">недоступно</div>
                ) : (
                  <div className="pf-timeline">
                    {detail.evidence.map((entry) => (
                      <div key={entry.id} className="pf-event">
                        <b>{entry.kind}</b>
                        <div>{entry.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {detail.decision ? (
                <div className="ap-section">
                  <h3>Решение</h3>
                  <div className="pf-kv">
                    <div>Актор</div><div>{detail.decision.actor}</div>
                    <div>Исход</div><div>{detail.decision.outcome}</div>
                    <div>Когда</div><div>{new Date(detail.decision.at).toLocaleString('ru-RU')}</div>
                    {detail.decision.note ? <><div>Примечание</div><div>{detail.decision.note}</div></> : null}
                  </div>
                </div>
              ) : null}

              {detail.status === 'PENDING' ? (
                <div className="ap-decide">
                  <button type="button" className="pf-btn goodbtn" disabled={actionBusy} onClick={() => void decide('approve')}>Согласовать</button>
                  <button type="button" className="pf-btn badbtn" disabled={actionBusy} onClick={() => void decide('reject')}>Отклонить</button>
                  <button type="button" className="pf-btn full" disabled={actionBusy} onClick={() => void decide('request-changes')}>Запросить изменения</button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="ap-muted">Детали недоступны.</div>
          )}
        </aside>
      </div>

      <div className="pf-footer-note">Концепция центра согласований v0.1 · согласования типизированы, аудируемы и не создаются для обычных переходов состояний</div>
    </div>
  );
}

/** Legacy-типы и адаптер для обратной совместимости unit-тестов API-адаптеров. */
export interface ApprovalRow {
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

export interface Approval {
  id: string;
  scope: 'once' | 'run' | 'task' | 'epic' | 'project';
  action: string;
  description: string;
  requestedBy: string;
  context: string;
  status: 'pending' | 'approved' | 'rejected' | 'changes_requested';
  createdAt: string;
}

const legacyStatusMap: Record<string, Approval['status']> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CHANGES_REQUESTED: 'changes_requested',
};

const legacyScopeMap: Record<string, Approval['scope']> = {
  TASK: 'task',
  EPIC: 'epic',
  PROJECT: 'project',
  RUN: 'run',
};

/**
 * Маппинг строки subject_type из legacy-очереди в scope-код для вкладки
 * согласований. Неизвестные типы отображаются в 'once'.
 */
export function mapApprovalRow(row: ApprovalRow): Approval {
  return {
    id: row.id,
    scope: legacyScopeMap[row.subject_type] ?? 'once',
    action: row.type,
    description: `${row.subject_type} ${row.subject_id}`,
    requestedBy: row.requested_by,
    context: row.resolution_note ?? '',
    status: legacyStatusMap[row.status] ?? 'pending',
    createdAt: row.created_at,
  };
}
