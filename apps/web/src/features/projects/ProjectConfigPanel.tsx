import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiClient } from '../../api/client.js';

interface ConfigCandidate {
  candidateId: string;
  projectId: string;
  sourceHead: string;
  manifestHash: string;
  files: Record<string, string>;
  manifest: Array<{ path: string; state: 'present' | 'deleted'; sha256: string | null }>;
  status: string;
}
interface ConfigRevision { revisionId: string; manifestHash: string; revisionHash: string; normalizedConfig: Record<string, unknown>; files?: Record<string, string>; }
interface ConfigResponse { current: ConfigCandidate | null; active: ConfigRevision | null; revisions: ConfigRevision[]; degraded?: boolean; candidateInvalid?: boolean; }

/** Показывает сохранённый candidate как недоверенный текст и отправляет approval его точной hash identity. */
export default function ProjectConfigPanel({ projectId }: { projectId: string }) {
  const [value, setValue] = useState<ConfigResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { setValue(await apiClient.get<ConfigResponse>(`/projects/${encodeURIComponent(projectId)}/config`)); }
    catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  const capture = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/projects/${encodeURIComponent(projectId)}/config/candidates`, {});
      setValue(await apiClient.get<ConfigResponse>(`/projects/${encodeURIComponent(projectId)}/config`));
    } catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  };

  const approve = async () => {
    const candidate = value?.current;
    if (!candidate || candidate.status !== 'PENDING_REVIEW') return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/projects/${encodeURIComponent(projectId)}/config/candidates/${encodeURIComponent(candidate.candidateId)}/approve`, { manifestHash: candidate.manifestHash });
      setValue(await apiClient.get<ConfigResponse>(`/projects/${encodeURIComponent(projectId)}/config`));
    } catch (cause) { setError(readableError(cause)); await reload(); }
    finally { setBusy(false); }
  };

  const stageRollback = async (revision: ConfigRevision) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/projects/${encodeURIComponent(projectId)}/config/revisions/${encodeURIComponent(revision.revisionId)}/rollback`, {});
      setValue(await apiClient.get<ConfigResponse>(`/projects/${encodeURIComponent(projectId)}/config`));
    } catch (cause) { setError(readableError(cause)); await reload(); }
    finally { setBusy(false); }
  };

  return (
    <section aria-label="Конфигурация Ebb Orchestrator">
      <h2>Конфигурация Ebb Orchestrator</h2>
      {error && <p role="alert">{error}</p>}
      {value?.degraded && <p role="alert">Активная конфигурация повреждена. Запуск проекта заблокирован. Выберите проверенную revision для rollback или создайте новый candidate.</p>}
      {value?.candidateInvalid && <p role="alert">Текущий candidate повреждён и недоступен для одобрения.</p>}
      {value?.active && <p>Активная конфигурация · manifest <code>{value.active.manifestHash}</code> · revision <code>{value.active.revisionHash}</code></p>}
      {value?.current?.status === 'PENDING_REVIEW' ? <>
        <p>Изменения ожидают явного одобрения. Источник: commit <code>{value.current.sourceHead}</code></p>
        <p>Manifest hash: <code>{value.current.manifestHash}</code></p>
        <ul aria-label="Изменения конфигурации">
          {value.current.manifest.map(({ path, state, sha256 }) => {
            const previous = value.active?.files?.[path];
            const source = value.current?.files[path];
            const change = state === 'deleted' ? 'Удалён' : previous === undefined ? 'Добавлен' : previous === source ? 'Без изменений' : 'Изменён';
            return <li key={path}>
              <h3><code>{path}</code> · {change}</h3>
              <p>SHA-256: <code>{sha256 ?? 'удалён'}</code></p>
              {previous !== undefined && previous !== source && <><p>Было:</p><pre>{previous}</pre></>}
              {state === 'present' && source !== undefined && <><p>Стало:</p><pre>{source}</pre></>}
            </li>;
          })}
        </ul>
        <button type="button" onClick={() => void approve()} disabled={busy}>Одобрить эту конфигурацию</button>
      </> : value ? <p>Нет ожидающей конфигурации для review.</p> : <p>{busy ? 'Загрузка конфигурации…' : 'Конфигурация не загружена.'}</p>}
      <h3>История revision</h3>
      <ul aria-label="История конфигурации">
        {(value?.revisions ?? []).map((revision) => <li key={revision.revisionId}>
          <code>{revision.revisionHash}</code>{revision.revisionId === value?.active?.revisionId ? ' · активная' : ''}
          {revision.revisionId !== value?.active?.revisionId && <button type="button" onClick={() => void stageRollback(revision)} disabled={busy}>Подготовить rollback</button>}
        </li>)}
        {value?.revisions?.length === 0 && <li>История пока пуста.</li>}
      </ul>
      <button type="button" onClick={() => void capture()} disabled={busy}>Проверить `.ebb-orchestrator/`</button>
    </section>
  );
}

function readableError(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === 'PROJECT_CONFIG_ACTIVE_INVALID') return 'Активная конфигурация повреждена. Запуск проекта заблокирован до явного восстановления.';
  if (cause instanceof ApiError && cause.code === 'PROJECT_CONFIG_CANDIDATE_NOT_CURRENT') return 'Этот candidate устарел. Обновите список и проверьте текущую конфигурацию.';
  if (cause instanceof ApiError && cause.code === 'PROJECT_CONFIG_UNSTABLE') return 'Конфигурация меняется. Повторите проверку после завершения изменений.';
  return 'Не удалось загрузить конфигурацию проекта.';
}
