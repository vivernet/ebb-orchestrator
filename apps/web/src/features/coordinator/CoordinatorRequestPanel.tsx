import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiClient } from '../../api/client.js';

type RequestStatus = 'RECEIVED' | 'PLANNING' | 'NEEDS_INPUT' | 'PLAN_PENDING_APPROVAL' | 'REJECTED' | 'MATERIALIZED' | 'FAILED';
interface PlanTask { ref: string; title: string; goal?: string; dependsOn?: string[]; acceptanceCriteria: string[]; }
interface ProductManagerDecision { outcome: 'PRODUCT_DEFINITION'; goal?: string; userBehavior?: string[]; scope?: string[]; nonGoals?: string[]; requirements?: string[]; acceptanceCriteria?: string[]; }
interface ArchitectDecision { outcome: 'DESIGN'; components?: string[]; interfaces?: string[]; dataFlow?: string[]; migrations?: string[]; decisions?: string[]; proposals?: Array<{ type: string; title: string; rationale: string }>; architectureReviewRequired?: boolean; }
interface RequestDetail {
  requestId: string;
  status: RequestStatus;
  classification: 'TASK' | 'EPIC' | 'NEEDS_INPUT' | null;
  planId: string | null;
  planVersion: number | null;
  failureCode: string | null;
  plan: { epic?: { title: string; goal?: string }; tasks: PlanTask[]; planningDecisions?: { productManager: ProductManagerDecision; architect: ArchitectDecision } } | null;
}
interface CreatedRequest { requestId: string; status: RequestStatus; }

const labels: Record<RequestStatus, string> = {
  RECEIVED: 'Запрос получен', PLANNING: 'Планирование', NEEDS_INPUT: 'Требуется уточнение',
  PLAN_PENDING_APPROVAL: 'План ожидает одобрения', REJECTED: 'План отклонён',
  MATERIALIZED: 'План одобрен, Epic запущен', FAILED: 'Ошибка планирования',
};
const activeStatuses: RequestStatus[] = ['RECEIVED', 'PLANNING'];
const epicRecoveryFailureCode = 'EPIC_RECOVERY_FAILED';

/** Показывает сохранённый запрос и только явно отправляет одобрение просмотренного плана. */
export default function CoordinatorRequestPanel({ projectId }: { projectId: string }) {
  const storageKey = `coordinator-request:${projectId}`;
  const basePath = `/projects/${encodeURIComponent(projectId)}/requests`;
  const [requestText, setRequestText] = useState('');
  const [requestId, setRequestId] = useState<string | null>(() => sessionStorage.getItem(storageKey));
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (id: string) => {
    const result = await apiClient.get<RequestDetail>(`${basePath}/${encodeURIComponent(id)}`);
    setDetail(result);
  }, [basePath]);

  useEffect(() => {
    if (!requestId) return;
    let cancelled = false;
    const load = async () => {
      try { if (!cancelled) await refresh(requestId); }
      catch (cause) { if (!cancelled) setError(readableError(cause)); }
    };
    void load();
    return () => { cancelled = true; };
  }, [requestId, refresh]);

  useEffect(() => {
    if (!requestId || !detail || !activeStatuses.includes(detail.status)) return;
    const timer = window.setInterval(() => {
      void refresh(requestId).catch((cause: unknown) => setError(readableError(cause)));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [requestId, detail?.status, refresh]);

  useEffect(() => {
    if (!requestId) return;
    const onReconnect = () => { void refresh(requestId).catch((cause: unknown) => setError(readableError(cause))); };
    window.addEventListener('sse-reconnect', onReconnect);
    return () => window.removeEventListener('sse-reconnect', onReconnect);
  }, [requestId, refresh]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const request = requestText.trim();
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await apiClient.post<CreatedRequest>(basePath, { request });
      sessionStorage.setItem(storageKey, created.requestId);
      setDetail(null);
      setRequestId(created.requestId);
      setRequestText('');
    } catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  };

  const approve = async () => {
    const retryingRecovery = detail?.status === 'FAILED' && detail.failureCode === epicRecoveryFailureCode && detail.classification === 'EPIC';
    if (!detail || (detail.status !== 'PLAN_PENDING_APPROVAL' && !retryingRecovery) || !detail.planId || !detail.plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(
        `/projects/${encodeURIComponent(projectId)}/epics/plans/${encodeURIComponent(detail.planId)}/approve-run`,
        { requestId: detail.requestId },
      );
      await refresh(detail.requestId);
    } catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  };

  const statusLabel = detail?.status === 'FAILED' && detail.failureCode === epicRecoveryFailureCode
    ? 'Восстановление Epic заблокировано'
    : detail ? labels[detail.status] : null;
  const canRetryRecovery = detail?.status === 'FAILED' && detail.failureCode === epicRecoveryFailureCode && detail.classification === 'EPIC' && Boolean(detail.planId && detail.plan);

  return <section aria-label="Запрос Coordinator">
    <h2>Запрос Coordinator</h2>
    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor="coordinator-request">Запрос для Coordinator</label>
      <textarea id="coordinator-request" value={requestText} maxLength={20_000} onChange={(event) => setRequestText(event.target.value)} />
      <button type="submit" disabled={busy || !requestText.trim()}>Отправить запрос</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {requestId && <>
      <p>Запрос: <code>{requestId}</code></p>
      {detail ? <>
        <p aria-live="polite">{statusLabel}</p>
        {detail.failureCode && <p>Код ошибки: <code>{detail.failureCode}</code></p>}
        {detail.status === 'NEEDS_INPUT' && <p>Уточните запрос и отправьте его снова.</p>}
        {detail.plan && <>
          <h3>План Epic{detail.planVersion ? ` · версия ${detail.planVersion}` : ''}</h3>
          <p><strong>Цель Epic:</strong> {detail.plan.epic?.goal ?? detail.plan.epic?.title ?? 'Не указана'}</p>
          {detail.plan.planningDecisions && <>
            <h3>Решение Product Manager</h3>
            {detail.plan.planningDecisions.productManager.goal && <p><strong>Цель продукта:</strong> {detail.plan.planningDecisions.productManager.goal}</p>}
            <DecisionList title="Поведение пользователя" values={detail.plan.planningDecisions.productManager.userBehavior} />
            <DecisionList title="Область работ" values={detail.plan.planningDecisions.productManager.scope} />
            <DecisionList title="Вне области работ" values={detail.plan.planningDecisions.productManager.nonGoals} />
            <DecisionList title="Требования" values={detail.plan.planningDecisions.productManager.requirements} />
            <DecisionList title="Критерии приёмки Product Manager" values={detail.plan.planningDecisions.productManager.acceptanceCriteria} />
            <h3>Решение Architect</h3>
            <DecisionList title="Компоненты" values={detail.plan.planningDecisions.architect.components} />
            <DecisionList title="Интерфейсы" values={detail.plan.planningDecisions.architect.interfaces} />
            <DecisionList title="Поток данных" values={detail.plan.planningDecisions.architect.dataFlow} />
            <DecisionList title="Миграции" values={detail.plan.planningDecisions.architect.migrations} />
            <DecisionList title="Архитектурные решения" values={detail.plan.planningDecisions.architect.decisions} />
            {detail.plan.planningDecisions.architect.proposals && <ul aria-label="Предложения Architect">
              {detail.plan.planningDecisions.architect.proposals.map((proposal, index) => <li key={`${proposal.type}-${index}`}>
                <strong>{proposal.type}: {proposal.title}</strong><p>{proposal.rationale}</p>
              </li>)}
            </ul>}
            <p>Дополнительная Architecture Review: {detail.plan.planningDecisions.architect.architectureReviewRequired ? 'требуется' : 'не требуется'}</p>
          </>}
          <ol aria-label="Задачи плана">{detail.plan.tasks.map((task) => <li key={task.ref}>
            <h4>{task.title}</h4>
            <p>Зависимости: {(task.dependsOn ?? []).length ? task.dependsOn?.join(', ') : 'нет'}</p>
            <p>Критерии приёмки:</p>
            <ul>{task.acceptanceCriteria.map((criterion, index) => <li key={`${task.ref}-${index}`}>{criterion}</li>)}</ul>
          </li>)}</ol>
        </>}
        {detail.status === 'PLAN_PENDING_APPROVAL' && detail.planId && detail.plan && <button type="button" disabled={busy} onClick={() => void approve()}>Одобрить план и запустить Epic</button>}
        {canRetryRecovery && <button type="button" disabled={busy} onClick={() => void approve()}>Повторить запуск Epic</button>}
      </> : <p>Загрузка состояния запроса…</p>}
      <button type="button" disabled={busy} onClick={() => void refresh(requestId).catch((cause: unknown) => setError(readableError(cause)))}>Обновить состояние</button>
    </>}
  </section>;
}

function DecisionList({ title, values }: { title: string; values: string[] | undefined }) {
  if (!values?.length) return null;
  return <section aria-label={title}><h4>{title}</h4><ul>{values.map((value, index) => <li key={`${title}-${index}`}>{value}</li>)}</ul></section>;
}

function readableError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) return 'Запрос или план не найден в этом проекте.';
  if (cause instanceof ApiError && cause.status === 409) return 'Действие сейчас недоступно. Обновите состояние проекта.';
  return 'Не удалось выполнить запрос. Повторите попытку.';
}
