import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiClient } from '../../api/client.js';

type Status = 'UNTRIAGED' | 'LINKED' | 'IGNORED' | 'RESOLVED' | 'DELETED';
interface FeedbackItem { id: string; body: string; sourceUrl: string; sourceIssueNumber: number; sourceCommentId: number; authorLogin: string; status: Status; }
interface WorkItem { id: string; title: string; }
interface HumanFeedbackPanelProps { projectId: string; tasks: readonly WorkItem[]; epics: readonly WorkItem[]; }

/** Показывает недоверенные GitHub comments и предоставляет только явные Project-scoped triage действия. */
export default function HumanFeedbackPanel({ projectId, tasks, epics }: HumanFeedbackPanelProps) {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [repository, setRepository] = useState('');
  const [mappingInput, setMappingInput] = useState('');
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState('UNTRIAGED');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [inbox, mapping] = await Promise.all([
        apiClient.get<{ items: FeedbackItem[]; nextCursor: string | null }>(`/projects/${encodeURIComponent(projectId)}/human-feedback?status=${status}`),
        apiClient.get<{ repository: string | null }>(`/projects/${encodeURIComponent(projectId)}/github/mapping`),
      ]);
      setItems(Array.isArray(inbox.items) ? inbox.items : []);
      setNextCursor(typeof inbox.nextCursor === 'string' ? inbox.nextCursor : null);
      setRepository(typeof mapping.repository === 'string' ? mapping.repository : '');
      setMappingInput(typeof mapping.repository === 'string' ? mapping.repository : '');
    } catch (cause) { setError(readableError(cause)); }
  }, [projectId, status]);

  useEffect(() => { void reload(); }, [reload]);

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await action(); await reload(); }
    catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  };

  const saveMapping = () => void mutate(async () => {
    await apiClient.put(`/projects/${encodeURIComponent(projectId)}/github/mapping`, { repository: mappingInput });
  });
  const removeMapping = () => void mutate(() => apiClient.delete(`/projects/${encodeURIComponent(projectId)}/github/mapping`));
  const sync = () => void mutate(() => apiClient.post(`/projects/${encodeURIComponent(projectId)}/github/sync`, {}));
  const loadMore = () => {
    if (!nextCursor) return;
    setBusy(true);
    setError(null);
    void apiClient.get<{ items: FeedbackItem[]; nextCursor: string | null }>(`/projects/${encodeURIComponent(projectId)}/human-feedback?status=${status}&cursor=${encodeURIComponent(nextCursor)}`)
      .then((page) => {
        setItems((existing) => [...existing, ...(Array.isArray(page.items) ? page.items : [])]);
        setNextCursor(typeof page.nextCursor === 'string' ? page.nextCursor : null);
      })
      .catch((cause: unknown) => setError(readableError(cause)))
      .finally(() => setBusy(false));
  };
  const triage = (id: string, action: 'ignore' | 'resolve' | 'delete') => void mutate(() => apiClient.post(`/projects/${encodeURIComponent(projectId)}/human-feedback/${encodeURIComponent(id)}/${action}`, {}));
  const link = (id: string) => {
    const [targetType, targetId] = target.split(':', 2);
    if ((targetType !== 'TASK' && targetType !== 'EPIC') || !targetId) { setError('Выберите задачу или эпик для связи.'); return; }
    void mutate(() => apiClient.post(`/projects/${encodeURIComponent(projectId)}/human-feedback/${encodeURIComponent(id)}/link`, { targetType, targetId }));
  };

  return <section aria-label="GitHub feedback inbox">
    <h2>GitHub feedback</h2>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); saveMapping(); }}>
      <label htmlFor={`github-repository-${projectId}`}>GitHub repository (owner/repository)</label>
      <input id={`github-repository-${projectId}`} value={mappingInput} onChange={(event) => setMappingInput(event.target.value)} />
      <button type="submit" disabled={busy || !mappingInput.trim()}>Сохранить mapping</button>
      {repository && <button type="button" onClick={removeMapping} disabled={busy}>Удалить mapping</button>}
    </form>
    <p>{repository ? `Подключён repository ${repository}.` : 'GitHub repository не подключён.'}</p>
    <button type="button" onClick={sync} disabled={busy || !repository}>Синхронизировать сейчас</button>
    <label htmlFor={`feedback-status-${projectId}`}>Статус inbox</label>
    <select id={`feedback-status-${projectId}`} value={status} onChange={(event) => setStatus(event.target.value)}>
      {(['UNTRIAGED', 'LINKED', 'IGNORED', 'RESOLVED', 'DELETED'] as const).map((value) => <option key={value} value={value}>{value}</option>)}
    </select>
    <ul aria-label="GitHub feedback">
      {items.length === 0 ? <li>Комментариев для обработки нет.</li> : items.map((item) => <li key={item.id}>
        <p>{safeSourceUrl(item.sourceUrl) ? <a href={safeSourceUrl(item.sourceUrl)} target="_blank" rel="noreferrer">Issue #{item.sourceIssueNumber}, comment #{item.sourceCommentId}</a> : <>Issue #{item.sourceIssueNumber}, comment #{item.sourceCommentId}</>} · {item.authorLogin}</p>
        <p>{item.body}</p>
        {item.status === 'UNTRIAGED' && <>
          <label htmlFor={`feedback-target-${item.id}`}>Связать с задачей или эпиком</label>
          <select id={`feedback-target-${item.id}`} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Выберите элемент</option>
            {tasks.map((task) => <option key={task.id} value={`TASK:${task.id}`}>Задача: {task.title}</option>)}
            {epics.map((epic) => <option key={epic.id} value={`EPIC:${epic.id}`}>Эпик: {epic.title}</option>)}
          </select>
          <button type="button" onClick={() => link(item.id)} disabled={busy}>Связать</button>
          <button type="button" onClick={() => triage(item.id, 'ignore')} disabled={busy}>Игнорировать</button>
          <button type="button" onClick={() => triage(item.id, 'resolve')} disabled={busy}>Решено</button>
        </>}
        {item.status !== 'DELETED' && <button type="button" onClick={() => triage(item.id, 'delete')} disabled={busy}>Удалить feedback</button>}
      </li>)}
    </ul>
    {nextCursor && <button type="button" onClick={loadMore} disabled={busy}>Загрузить ещё</button>}
    <button type="button" onClick={() => void reload()} disabled={busy}>Обновить inbox</button>
  </section>;
}

function readableError(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === 'PROJECT_MAPPING_REQUIRED') return 'Сначала укажите GitHub repository для проекта.';
  if (cause instanceof ApiError && cause.code === 'FEEDBACK_MAPPING_CONFLICT') return 'Этот GitHub repository уже связан с другим проектом.';
  if (cause instanceof ApiError && cause.code === 'FEEDBACK_MAPPING_INVALID') return 'Укажите repository в формате owner/repository.';
  return 'Не удалось выполнить действие с GitHub feedback.';
}

function safeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}
