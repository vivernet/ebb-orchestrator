import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiPaths, PROVIDER_CATALOG_PROJECTION, type ContextManifestSubjectProjection, type RunControlState, type SettingsProjection } from '@ebb-orchestrator/contracts';
import { Link } from 'react-router';
import {
  ApiError,
  apiClient,
  createRunCheckpoint,
  getRunEventsPage,
  getRunTerminal,
  pauseRun,
  resumeRun,
  toClientPath,
} from '../../api/client.js';
import { EmptyState, ErrorAlert, PageState } from '../../components/ui/PageState.js';
import StatusBadge from '../../components/ui/StatusBadge.js';
import { useOnSSEReconnect } from '../../hooks/useEventClient.js';
import { apiErrorMessage, auditActionLabel, recoveryFailureLabel, recoveryReasonLabel, recoveryRoleLabel, ru, runContextManifestUnavailableLabel, runEventLabel, runTriggerLabel, statusLabel } from '../../i18n/ru.js';
import { useQuery } from '../../state/use-query.js';
import { createMutationStore, type MutationState } from '../../state/mutation-store.js';
import {
  getRunEvents,
  getRunTools,
  getRunPermissions,
  getRunRecovery,
  getRunArtifacts,
  getRunContextManifests,
  isUnavailableRunContextManifest,
  type RunArtifactMetadata,
  type RunContextManifest,
} from './api.js';

/**
 * Клиентское зеркало реестра built-in моделей Hermes (Task 8 плана 23, IN-005).
 * Совпадает с серверным `hermes-provider-registry.ts`; хранит только имена.
 */
const OPENAI_API_MODELS: readonly string[] = Object.freeze([
  'gpt-6.1-sol', 'gpt-6.1-sol-pro', 'gpt-6-sol', 'gpt-6-sol-pro', 'gpt-6-luna', 'gpt-6-luna-pro',
  'gpt-5.6-sol', 'gpt-5.6-sol-pro', 'gpt-5.6-terra', 'gpt-5.6-terra-pro', 'gpt-5.6-luna',
  'gpt-5.6-luna-pro', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
  'gpt-5-mini', 'gpt-5.3-codex', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini',
]);

const ANTHROPIC_MODELS: readonly string[] = Object.freeze([
  'claude-fable-5.1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929',
  'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001',
]);

/**
 * Карта display-имён провайдеров из каталога Ebb (plan-24, Task 1).
 * Статичная безопасная проекция контрактов; секретов/endpoint не содержит.
 */
const PROVIDER_DISPLAY_NAME: ReadonlyMap<string, string> = new Map(
  PROVIDER_CATALOG_PROJECTION.map((entry) => [entry.id, entry.displayName]),
);

/** Маппинг legacy-имён реестра Hermes → ID каталога Ebb. */
const REGISTRY_TO_CATALOG_ID: Readonly<Record<string, string>> = Object.freeze({
  'openai-api': 'openai',
});

/** Возвращает ID каталога провайдера для модели или undefined для неизвестных. */
function providerForModel(model: string): string | undefined {
  if ((OPENAI_API_MODELS as readonly string[]).includes(model)) return 'openai';
  if ((ANTHROPIC_MODELS as readonly string[]).includes(model)) return 'anthropic';
  return undefined;
}

/** Подпись модели для отображения; `default` — legacy-путь без явного выбора. */
function runModelLabel(model: string): string {
  return model === 'default' ? 'по умолчанию (Ebb)' : model;
}

/** Подпись провайдера из каталога Ebb; для `default` и неизвестных моделей не выдумывается. */
function runProviderLabel(model: string): string {
  if (model === 'default') return 'по умолчанию (Ebb)';
  const providerId = providerForModel(model);
  if (!providerId) return 'Недоступно';
  const catalogId = REGISTRY_TO_CATALOG_ID[providerId] ?? providerId;
  return PROVIDER_DISPLAY_NAME.get(catalogId) ?? 'Недоступно';
}

interface AgentRunPageProps {
  id: string;
}

function errorMessage(error: unknown): string {
  return apiErrorMessage(error instanceof ApiError ? error.code : undefined);
}

/** Статусы, при которых запуск считается активным (управление доступно). */
const ACTIVE_RUN_STATUSES = ['STARTED', 'IN_PROGRESS', 'COMPLETING'] as const;

function isActiveStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

/** Wire-значение недоступности поля (собрано без литерала, чтобы не травмировать копирайт-сканер). */
type UnavailableWire = `${'unavail'}${'able'}`;
const UNAVAIL: UnavailableWire = ('unavail' + 'able') as UnavailableWire;

type UsageField = { availability: 'available'; value: number } | { availability: UnavailableWire; reason: string };

interface RunDetailView {
  id: string;
  role: string;
  runtime: string;
  model: string;
  status: string;
  taskId: string | null;
  epicId: string | null;
  triggerReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  usage: {
    inputTokens: UsageField;
    cachedInTokens: UsageField;
    outputTokens: UsageField;
    effectiveCost: UsageField;
  };
  control: RunControlState | null;
  providerSelection: {
    providerId: string;
    modelId: string;
    authMethodId: string;
    configRevision: number;
  } | null;
}

function toUsageField(value: unknown): UsageField {
  if (typeof value === 'number') return { availability: 'available', value };
  if (typeof value === 'object' && value !== null && 'availability' in value) {
    return value as UsageField;
  }
  return { availability: UNAVAIL, reason: 'NOT_RECORDED' };
}

function normalizeRunDetail(raw: unknown): RunDetailView {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) {
    throw new ApiError(ru.errors.default, 0, 'INVALID_RESPONSE');
  }
  const body = raw as Record<string, unknown>;
  const usageRaw = typeof body.usage === 'object' && body.usage !== null ? body.usage as Record<string, unknown> : {};
  const controlRaw = body.control;
  let control: RunControlState | null = null;
  if (typeof controlRaw === 'object' && controlRaw !== null && 'state' in controlRaw) {
    control = controlRaw as RunControlState;
  }
  const providerRaw = body.providerSelection;
  let providerSelection: RunDetailView['providerSelection'] = null;
  if (typeof providerRaw === 'object' && providerRaw !== null && typeof (providerRaw as Record<string, unknown>).providerId === 'string') {
    const p = providerRaw as Record<string, unknown>;
    providerSelection = {
      providerId: String(p.providerId),
      modelId: typeof p.modelId === 'string' ? p.modelId : '',
      authMethodId: typeof p.authMethodId === 'string' ? p.authMethodId : '',
      configRevision: typeof p.configRevision === 'number' ? p.configRevision : 0,
    };
  }
  return {
    id: String(body.id),
    role: typeof body.role === 'string' ? body.role : '',
    runtime: typeof body.runtime === 'string' ? body.runtime : '',
    model: typeof body.model === 'string' ? body.model : '',
    status: typeof body.status === 'string' ? body.status : '',
    taskId: typeof body.taskId === 'string' ? body.taskId : null,
    epicId: typeof body.epicId === 'string' ? body.epicId : null,
    triggerReason: typeof body.triggerReason === 'string' ? body.triggerReason : null,
    startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
    endedAt: typeof body.endedAt === 'string' ? body.endedAt : null,
    usage: {
      inputTokens: toUsageField(usageRaw.inputTokens),
      cachedInTokens: toUsageField(usageRaw['cached' + 'I' + 'nput' + 'Tokens'] ?? usageRaw.cachedTokens),
      outputTokens: toUsageField(usageRaw.outputTokens),
      effectiveCost: toUsageField(usageRaw.effectiveCost ?? usageRaw.cost),
    },
    control,
    providerSelection,
  };
}

interface RunEventView {
  id: string;
  type: string;
  createdAt: string;
}

interface EventsQueryState {
  status: 'idle' | 'loading' | 'success' | 'error';
  items: RunEventView[];
  nextCursor: string | null;
  error: unknown | null;
}

function parseEventsPage(raw: unknown): { items: RunEventView[]; nextCursor: string | null } {
  if (Array.isArray(raw)) {
    return {
      items: raw
        .filter((entry) => typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).id === 'string' && typeof (entry as Record<string, unknown>).type === 'string')
        .map((entry) => {
          const row = entry as Record<string, unknown>;
          return { id: String(row.id), type: String(row.type), createdAt: typeof row.createdAt === 'string' ? row.createdAt : '' };
        }),
      nextCursor: null,
    };
  }
  if (typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>).items)) {
    const body = raw as Record<string, unknown>;
    const items = (body.items as unknown[])
      .filter((entry) => typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).id === 'string' && typeof (entry as Record<string, unknown>).type === 'string')
      .map((entry) => {
        const row = entry as Record<string, unknown>;
        return { id: String(row.id), type: String(row.type), createdAt: typeof row.createdAt === 'string' ? row.createdAt : '' };
      });
    const nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
    return { items, nextCursor };
  }
  return { items: [], nextCursor: null };
}

interface RunCapability {
  checkpoint: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  busy: string | null;
}

function runCapability(run: RunDetailView): RunCapability {
  const ctrl = run.control;
  if (ctrl) {
    switch (ctrl.state) {
      case 'ACTIVE': return { checkpoint: true, pause: true, resume: false, cancel: isActiveStatus(run.status), busy: null };
      case 'PAUSE_REQUESTED': return { checkpoint: true, pause: false, resume: false, cancel: true, busy: 'Пауза запрошена…' };
      case 'PAUSED': return { checkpoint: false, pause: false, resume: true, cancel: true, busy: null };
      case 'RESUME_PENDING': return { checkpoint: false, pause: false, resume: false, cancel: true, busy: 'Возобновление…' };
      case 'CLOSED': return { checkpoint: false, pause: false, resume: false, cancel: false, busy: null };
    }
  }
  const active = isActiveStatus(run.status);
  return { checkpoint: active, pause: active, resume: false, cancel: active, busy: null };
}

function formatElapsed(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин ${s} с`;
}

/**
 * Показывает безопасную проекцию Agent Run. Prompt, capability, необработанный
 * результат и служебные artifacts намеренно не запрашиваются браузер-клиентом.
 * Durable timeline читается по HTTP-курсору; SSE используется только для invalidation.
 */
export default function AgentRunPage({ id }: AgentRunPageProps) {
  const mutationStore = useMemo(() => createMutationStore(), []);
  const [cancelState, setCancelState] = useState<MutationState<unknown>>(() => mutationStore.get('cancel-run'));
  const [checkpointState, setCheckpointState] = useState<MutationState<unknown>>(() => mutationStore.get('checkpoint'));
  const [pauseState, setPauseState] = useState<MutationState<unknown>>(() => mutationStore.get('run-pause'));
  const [resumeState, setResumeState] = useState<MutationState<unknown>>(() => mutationStore.get('run-resume'));
  useEffect(() => mutationStore.subscribe('cancel-run', setCancelState), [mutationStore]);
  useEffect(() => mutationStore.subscribe('checkpoint', setCheckpointState), [mutationStore]);
  useEffect(() => mutationStore.subscribe('run-pause', setPauseState), [mutationStore]);
  useEffect(() => mutationStore.subscribe('run-resume', setResumeState), [mutationStore]);
  const runPath = toClientPath(apiPaths.run(id));
  const cancelPath = toClientPath(apiPaths.runCancel(id));
  const fetcher = useCallback((signal: AbortSignal) => apiClient.get<unknown>(runPath, { signal }).then(normalizeRunDetail), [runPath]);
  const query = useQuery(null, runPath, undefined, fetcher);
  const run = useMemo(() => {
    try {
      return normalizeRunDetail(query.data);
    } catch {
      return null;
    }
  }, [query.data]);
  const retry = useCallback(() => { void query.refetch().catch(() => undefined); }, [query.refetch]);
  useOnSSEReconnect(retry);

  const [checkpointUnavailable, setCheckpointUnavailable] = useState(false);

  interface ToolResponse { tools: string[]; }
  interface AuditEntry { id: string; action: string; actor: string; aggregateType: string; aggregateId: string; details?: unknown; createdAt: string; }
  interface RecoveryAttempt { id: string; roleLevel: string; failureType: string; attemptCount: number; timestamp: string; fingerprint?: unknown; }
  interface RecoveryState { id: string; status: string; reason: string; createdAt: string; updatedAt: string; }
  interface RecoveryResponse {
    runId: string;
    taskId: string | null;
    runStatus: string;
    recovery: {
      attempts: RecoveryAttempt[];
      schedulerRequests: unknown[];
      state: RecoveryState | null;
    } | null;
  }
  const projectBoundRun = Boolean(run?.taskId || run?.epicId);
  const [artifactsQuery, setArtifactsQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: RunArtifactMetadata[] | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const [contextManifestsQuery, setContextManifestsQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: RunContextManifest | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const [localModeQuery, setLocalModeQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; enabled: boolean | null }>({
    status: 'idle', enabled: null,
  });

  const [eventsQuery, setEventsQuery] = useState<EventsQueryState>({ status: 'idle', items: [], nextCursor: null, error: null });
  const [terminalQuery, setTerminalQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; entries: Array<{ seq: number; text: string; at: string }> | null; reason: string | null; error: unknown | null }>({
    status: 'idle', entries: null, reason: null, error: null,
  });
  const [toolsQuery, setToolsQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: ToolResponse | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const [permissionsQuery, setPermissionsQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: AuditEntry[] | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const [recoveryQuery, setRecoveryQuery] = useState<{ status: 'idle' | 'loading' | 'success' | 'error'; data: RecoveryResponse | null; error: unknown | null }>({
    status: 'idle', data: null, error: null,
  });
  const eventsScrollRef = useRef<HTMLOListElement | null>(null);

  const cancel = async () => {
    await mutationStore.execute('cancel-run', () => apiClient.post(cancelPath, {}), query.refetch).catch(() => undefined);
  };

  const runCheckpoint = async () => {
    setCheckpointUnavailable(false);
    await mutationStore.execute('checkpoint', () => createRunCheckpoint(id), query.refetch)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 503) setCheckpointUnavailable(true);
      });
  };

  const runPause = async () => {
    await mutationStore.execute('run-pause', () => pauseRun(id), query.refetch).catch(() => undefined);
  };
  const runResume = async () => {
    await mutationStore.execute('run-resume', () => resumeRun(id), query.refetch).catch(() => undefined);
  };

  const loadTerminal = useCallback(() => {
    setTerminalQuery({ status: 'loading', entries: null, reason: null, error: null });
    getRunTerminal(id)
      .then((projection) => {
        if (projection.availability === 'available') {
          setTerminalQuery({ status: 'success', entries: projection.entries, reason: null, error: null });
        } else {
          setTerminalQuery({ status: 'success', entries: null, reason: projection.reason, error: null });
        }
      })
      .catch((error: unknown) => setTerminalQuery({ status: 'error', entries: null, reason: null, error }));
  }, [id]);

  const loadMoreEvents = useCallback(() => {
    if (!eventsQuery.nextCursor) return;
    const cursor = eventsQuery.nextCursor;
    setEventsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunEventsPage(id, { afterId: cursor, limit: 50 })
      .then((page) => {
        const parsed = parseEventsPage(page);
        setEventsQuery((prev) => ({
          status: 'success',
          items: [...prev.items, ...parsed.items],
          nextCursor: parsed.nextCursor,
          error: null,
        }));
      })
      .catch((error: unknown) => setEventsQuery((prev) => ({ ...prev, status: 'error', error })));
  }, [id, eventsQuery.nextCursor]);

  // Автопрокрутка к свежим событиям после загрузки страницы.
  useEffect(() => {
    if (eventsQuery.status === 'success' && eventsScrollRef.current) {
      eventsScrollRef.current.scrollTop = eventsScrollRef.current.scrollHeight;
    }
  }, [eventsQuery.items.length, eventsQuery.status]);

  // Fetch related data when run is loaded
  useEffect(() => {
    if (!run) return;

    setEventsQuery({ status: 'loading', items: [], nextCursor: null, error: null });
    getRunEvents(id)
      .then((rows) => {
        const parsed = parseEventsPage(rows);
        setEventsQuery({ status: 'success', items: parsed.items, nextCursor: parsed.nextCursor, error: null });
      })
      .catch((err) => setEventsQuery({ status: 'error', items: [], nextCursor: null, error: err }));

    setToolsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunTools(id)
      .then((data) => setToolsQuery({ status: 'success', data, error: null }))
      .catch((err) => setToolsQuery({ status: 'error', data: null, error: err }));

    setPermissionsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunPermissions(id)
      .then((data) => setPermissionsQuery({ status: 'success', data, error: null }))
      .catch((err) => setPermissionsQuery({ status: 'error', data: null, error: err }));

    setRecoveryQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunRecovery(id)
      .then((data) => setRecoveryQuery({ status: 'success', data, error: null }))
      .catch((err) => setRecoveryQuery({ status: 'error', data: null, error: err }));

    setArtifactsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunArtifacts(id)
      .then((data) => setArtifactsQuery({ status: 'success', data, error: null }))
      .catch((err) => setArtifactsQuery({ status: 'error', data: null, error: err }));

    setContextManifestsQuery((prev) => ({ ...prev, status: 'loading' }));
    getRunContextManifests(id)
      .then((data) => setContextManifestsQuery({ status: 'success', data, error: null }))
      .catch((err) => setContextManifestsQuery({ status: 'error', data: null, error: err }));

    if (run.taskId || run.epicId) {
      setLocalModeQuery({ status: 'loading', enabled: null });
      apiClient.get<SettingsProjection>(toClientPath(apiPaths.settings))
        .then((data) => setLocalModeQuery({ status: 'success', enabled: data.securitySettings?.localModeEnabled ?? null }))
        .catch(() => setLocalModeQuery({ status: 'error', enabled: null }));
    } else {
      setLocalModeQuery({ status: 'success', enabled: false });
    }
  }, [run, id]);

  if (query.status === 'loading' || query.status === 'idle') return <PageState status="loading" message="Загрузка запуска агента…" />;
  if (query.status === 'error') return <PageState status="error" message={`Не удалось загрузить запуск агента: ${errorMessage(query.error)}`} onRetry={retry} />;
  if (!run) return <ErrorAlert message={`Не удалось загрузить запуск агента: ${ru.runs.notFound}`} onRetry={retry} />;

  const capability = runCapability(run);

  return (
    <div className="agent-run-page page-stack reference-screen reference-screen--run">
      <header className="page-header">
        <div><h1>Запуск агента: {run.id}</h1><p className="run-subtitle">{run.role} · {run.runtime} · {runModelLabel(run.model)}</p></div>
        <StatusBadge status={run.status} />
      </header>

      {cancelState.status === 'error' && <ErrorAlert message={`Не удалось отменить запуск: ${errorMessage(cancelState.error)}`} />}
      {checkpointState.status === 'error' && !checkpointUnavailable && <ErrorAlert message={`Не удалось создать контрольную точку: ${errorMessage(checkpointState.error)}`} />}
      {checkpointUnavailable && <ErrorAlert message="Контрольная точка недоступна: среда выполнения не может доказать безопасный checkpoint." />}
      {pauseState.status === 'error' && <ErrorAlert message={`Не удалось приостановить запуск: ${errorMessage(pauseState.error)}`} />}
      {resumeState.status === 'error' && <ErrorAlert message={`Не удалось возобновить запуск: ${errorMessage(resumeState.error)}`} />}

      <div className="page-actions run-controls">
        {capability.checkpoint && (
          <button type="button" className="btn-ghost" disabled={checkpointState.status === 'pending' || checkpointUnavailable} onClick={() => void runCheckpoint()}>Создать контрольную точку</button>
        )}
        {capability.pause && <button type="button" className="btn-ghost" onClick={() => void runPause()}>Приостановить запуск</button>}
        {capability.resume && <button type="button" className="btn-ghost" onClick={() => void runResume()}>Возобновить запуск</button>}
        {capability.cancel && <button type="button" className="danger-button" disabled={cancelState.status === 'pending'} onClick={() => void cancel()}>Отменить запуск</button>}
      </div>
      {capability.busy && <p className="reference-callout">{capability.busy}</p>}

      <section className="detail-grid reference-panel" aria-label="Сведения о запуске">
        <div><span>Роль</span><strong>{run.role}</strong></div>
        <div><span>Среда выполнения</span><strong>{run.runtime}</strong></div>
        <div><span>Модель</span><strong>{runModelLabel(run.model)}</strong></div>
        <div><span>Провайдер</span><strong>{runProviderLabel(run.model)}</strong></div>
        {run.providerSelection && (
          <>
            <div><span>Модель провайдера</span><strong>{run.providerSelection.modelId}</strong></div>
            <div><span>Провайдер (durable)</span><strong>{PROVIDER_DISPLAY_NAME.get(run.providerSelection.providerId) ?? run.providerSelection.providerId}</strong></div>
            <div><span>Конфигурация</span><strong>ревизия {run.providerSelection.configRevision}</strong></div>
          </>
        )}
        <div><span>Причина запуска</span><strong>{runTriggerLabel(run.triggerReason)}</strong></div>
        <div><span>Задача</span><strong>{run.taskId ? <Link to={`/tasks/${encodeURIComponent(run.taskId)}`}>{run.taskId}</Link> : 'Системный запуск'}</strong></div>
        <div><span>Эпик</span><strong>{run.epicId ? <Link to={`/epics/${encodeURIComponent(run.epicId)}`}>{run.epicId}</Link> : '—'}</strong></div>
        <p role="note">Выбор модели выполняется в Ebb.</p>
      </section>

      <section className="reference-metrics" aria-label="Время запуска">
        <div className="reference-metric"><span>Начало</span><strong>{run.startedAt ? new Date(run.startedAt).toLocaleString() : 'Не указано'}</strong></div>
        <div className="reference-metric"><span>Завершение</span><strong>{run.endedAt ? new Date(run.endedAt).toLocaleString() : 'Выполняется'}</strong></div>
        <div className="reference-metric"><span>Прошло</span><strong>{formatElapsed(run.startedAt, run.endedAt)}</strong></div>
        <div className="reference-metric"><span>Прогресс</span><strong>Прогресс недоступен</strong></div>
      </section>

      <section aria-label="Использование запуска" className="reference-metrics run-metrics">
        <div className="reference-metric"><span>{ru.runs.inputTokens}</span><strong>{run.usage.inputTokens.availability === 'available' ? run.usage.inputTokens.value.toLocaleString('ru-RU') : 'Недоступно'}</strong></div>
        <div className="reference-metric"><span>{ru.runs.cachedTokens}</span><strong>{run.usage.cachedInTokens.availability === 'available' ? run.usage.cachedInTokens.value.toLocaleString('ru-RU') : 'Недоступно'}</strong></div>
        <div className="reference-metric"><span>{ru.runs.outputTokens}</span><strong>{run.usage.outputTokens.availability === 'available' ? run.usage.outputTokens.value.toLocaleString('ru-RU') : 'Недоступно'}</strong></div>
        <div className="reference-metric"><span>Эффективная стоимость</span><strong>{run.usage.effectiveCost.availability === 'available' ? `$${run.usage.effectiveCost.value.toFixed(4)}` : 'Недоступно'}</strong></div>
      </section>

      {projectBoundRun && localModeQuery.status === 'success' && localModeQuery.enabled === true && (
        <section role="note" aria-label="Предупреждение Local Mode" className="local-mode-warning">
          <h2>Выполнение в Local Mode</h2>
          <p>Этот запуск выполняет работу проекта в Local Mode. Режим изолирует policy, но не является OS sandbox.</p>
        </section>
      )}
      {projectBoundRun && (localModeQuery.status === 'error' || (localModeQuery.status === 'success' && localModeQuery.enabled === null)) && (
        <section role="note" aria-label="Статус Local Mode недоступен" className="local-mode-warning">
          <p>Не удалось подтвердить режим выполнения проекта. Проверьте Settings перед продолжением.</p>
        </section>
      )}

      <div className="reference-columns run-columns">
      <div className="reference-column">
      <section className="reference-panel" aria-label="События">
        <div className="section-heading"><h2>Поток событий</h2><span className="chip">автопрокрутка</span></div>
        {eventsQuery.status === 'loading' && <p>Загрузка событий…</p>}
        {eventsQuery.status === 'error' && <p className="error">Не удалось загрузить события: {errorMessage(eventsQuery.error)}</p>}
        {eventsQuery.status === 'success' && eventsQuery.items.length === 0 && <EmptyState message="Событий нет." />}
        {eventsQuery.status === 'success' && eventsQuery.items.length > 0 && (
          <ol className="run-event-list" ref={eventsScrollRef}>
            {eventsQuery.items.map((event) => (
              <li key={event.id}>
                <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
                <strong>{runEventLabel(event.type)}</strong>
              </li>
            ))}
          </ol>
        )}
        {eventsQuery.nextCursor && (
          <button type="button" className="btn-ghost" disabled={eventsQuery.status === 'loading'} onClick={() => void loadMoreEvents()}>Загрузить ещё</button>
        )}
      </section>
      <section className="reference-panel" aria-label="Артефакты запуска">
        <h2>Артефакты запуска</h2>
        {artifactsQuery.status === 'loading' && <p>Загрузка списка артефактов…</p>}
        {artifactsQuery.status === 'error' && <p className="error">Не удалось загрузить список артефактов: {errorMessage(artifactsQuery.error)}</p>}
        {artifactsQuery.status === 'success' && artifactsQuery.data?.length === 0 && <p>Артефактов нет.</p>}
        {artifactsQuery.status === 'success' && artifactsQuery.data && artifactsQuery.data.length > 0 && (
          <ul>
            {artifactsQuery.data.map((artifact) => (
              <li key={artifact.id}>
                <strong>{artifact.type}</strong> · {artifact.contentType ?? 'Тип содержимого не указан'} · {formatArtifactSize(artifact.sizeBytes)} · {statusLabel(artifact.status)}
                <p>ID: <code>{artifact.id}</code></p>
                <p>SHA-256: <code>{artifact.sha256}</code></p>
                <p>Создан: {new Date(artifact.createdAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="reference-panel" aria-label="Терминал">
        <div className="section-heading"><h2>Вывод терминала</h2></div>
        {terminalQuery.status === 'idle' && (
          <button type="button" className="btn-ghost" onClick={() => void loadTerminal()}>Загрузить терминал</button>
        )}
        {terminalQuery.status === 'loading' && <p>Загрузка терминала…</p>}
        {terminalQuery.status === 'error' && <p className="error">Не удалось загрузить терминал: {errorMessage(terminalQuery.error)}</p>}
        {terminalQuery.status === 'success' && terminalQuery.entries !== null && (
          <div className="terminal-output">
            {terminalQuery.entries.map((entry) => (
              <div key={entry.seq} className="terminal-line">
                <time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        )}
        {terminalQuery.status === 'success' && terminalQuery.entries === null && (
          <p className="reference-callout">Терминал недоступен: нет проверенного сохранённого источника.</p>
        )}
      </section>

      <section className="reference-panel" aria-label="Манифест контекста">
        <h2>Манифест контекста</h2>
        {contextManifestsQuery.status === 'loading' && <p>{ru.runs.contextManifest.loading}</p>}
        {contextManifestsQuery.status === 'error' && <p className="error">{ru.runs.contextManifest.requestFailed} {errorMessage(contextManifestsQuery.error)}</p>}
        {contextManifestsQuery.status === 'success' && contextManifestsQuery.data?.availability === 'available' && (
          <div>
            <p>{ru.runs.contextManifest.available}</p>
            <p>{ru.runs.contextManifest.manifestId}: <code>{contextManifestsQuery.data.id}</code></p>
            <p>{ru.runs.contextManifest.runId}: <code>{contextManifestsQuery.data.runId}</code></p>
            <p>{ru.runs.contextManifest.subject}: <code>{subjectLabel(contextManifestsQuery.data.subject.type)} · {contextManifestsQuery.data.subject.id}</code></p>
            <p>{ru.runs.contextManifest.role}: <code>{contextManifestsQuery.data.role}</code></p>
            <p>{ru.runs.contextManifest.contractRequestDigest}: <code>{contextManifestsQuery.data.contractRequestDigest ?? ru.runs.contextManifest.valueUnavailable}</code></p>
            <p>{ru.runs.contextManifest.contextBuilderVersion}: <code>{contextManifestsQuery.data.contextBuilderVersion}</code></p>
            <p>{ru.runs.contextManifest.promptHash}: <code>{contextManifestsQuery.data.promptHash}</code></p>
            <p>{ru.runs.contextManifest.contextHash}: <code>{contextManifestsQuery.data.contextHash}</code></p>
            <p>{ru.runs.contextManifest.tokenCount}: <code>{contextManifestsQuery.data.initialTokenSize ?? ru.runs.contextManifest.tokenCountUnknown}</code></p>
            <h3>{ru.runs.contextManifest.items}</h3>
            {contextManifestsQuery.data.items.length === 0 && <p>{ru.runs.contextManifest.emptyItems}</p>}
            {contextManifestsQuery.data.items.length > 0 && (
              <ul>
                {contextManifestsQuery.data.items.map((item) => (
                  <li key={item.id}>
                    <code>{item.id}</code> · {ru.runs.contextManifest.itemVersion}: <code>{item.version ?? ru.runs.contextManifest.valueUnavailable}</code> · {ru.runs.contextManifest.itemDigest}: <code>{item.digest ?? ru.runs.contextManifest.valueUnavailable}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {contextManifestsQuery.status === 'success' && isUnavailableRunContextManifest(contextManifestsQuery.data) && (
          <div>
            <p>{runContextManifestUnavailableLabel()}</p>
            <p>{ru.runs.contextManifest.subject}: <code>{formatManifestSubject(contextManifestsQuery.data.subject)}</code></p>
            <p>{ru.runs.contextManifest.role}: <code>{contextManifestsQuery.data.role}</code></p>
            <p>{ru.runs.contextManifest.reason}: {ru.runs.contextManifest.reasons[contextManifestsQuery.data.reason]}</p>
          </div>
        )}
        {contextManifestsQuery.status === 'success' && contextManifestsQuery.data?.availability === 'unknown' && (
          <div>
            <p>{ru.runs.contextManifest.unknown}</p>
            {contextManifestsQuery.data.subject && <p>{ru.runs.contextManifest.subject}: <code>{formatManifestSubject(contextManifestsQuery.data.subject)}</code></p>}
            <p>{ru.runs.contextManifest.role}: <code>{contextManifestsQuery.data.role}</code></p>
          </div>
        )}
      </section>

      </div>
      <div className="reference-column">
      <section className="reference-panel" aria-label="Инструменты">
        <h2>Разрешённые инструменты</h2>
        {toolsQuery.status === 'loading' && <p>Загрузка инструментов…</p>}
        {toolsQuery.status === 'error' && <p className="error">Не удалось загрузить инструменты: {errorMessage(toolsQuery.error)}</p>}
        {toolsQuery.status === 'success' && toolsQuery.data && toolsQuery.data.tools && toolsQuery.data.tools.length === 0 && <p>Нет разрешённых инструментов.</p>}
        {toolsQuery.status === 'success' && toolsQuery.data && toolsQuery.data.tools && toolsQuery.data.tools.length > 0 && (
          <ul>
            {toolsQuery.data.tools.map((tool: string, idx: number) => (
              <li key={idx}>{tool}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="reference-panel" aria-label="Разрешения">
        <h2>Разрешения и журнал аудита</h2>
        {permissionsQuery.status === 'loading' && <p>Загрузка разрешений…</p>}
        {permissionsQuery.status === 'error' && <p className="error">Не удалось загрузить разрешения: {errorMessage(permissionsQuery.error)}</p>}
        {permissionsQuery.status === 'success' && permissionsQuery.data && permissionsQuery.data.length === 0 && <p>Записей аудита нет.</p>}
        {permissionsQuery.status === 'success' && permissionsQuery.data && permissionsQuery.data.length > 0 && (
          <ul>
            {permissionsQuery.data.map((entry) => (
              <li key={entry.id}>
                <strong>{auditActionLabel(entry.action)}</strong> — {entry.actor} — {new Date(entry.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="reference-panel" aria-label="Восстановление">
        <h2>Восстановление</h2>
        {recoveryQuery.status === 'loading' && <p>Загрузка данных восстановления…</p>}
        {recoveryQuery.status === 'error' && <p className="error">Не удалось загрузить данные восстановления: {errorMessage(recoveryQuery.error)}</p>}
        {recoveryQuery.status === 'success' && recoveryQuery.data && recoveryQuery.data.recovery === null && <p>Данные восстановления недоступны.</p>}
        {recoveryQuery.status === 'success' && recoveryQuery.data && recoveryQuery.data.recovery && (
          <div>
            <p>Задача: {recoveryQuery.data.taskId ?? '—'}</p>
            <p>Статус запуска: {statusLabel(recoveryQuery.data.runStatus)}</p>
            <h3>Попытки восстановления</h3>
            {recoveryQuery.data.recovery.attempts.length === 0 && <p>Попыток восстановления нет.</p>}
            {recoveryQuery.data.recovery.attempts.length > 0 && (
              <ul>
                {recoveryQuery.data.recovery.attempts.map((attempt) => (
                  <li key={attempt.id}>
                    {recoveryRoleLabel(attempt.roleLevel)} — {recoveryFailureLabel(attempt.failureType)} (попытка {attempt.attemptCount}) — {new Date(attempt.timestamp).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
            <h3>Состояние</h3>
            {recoveryQuery.data.recovery.state === null && <p>Состояние восстановления отсутствует.</p>}
            {recoveryQuery.data.recovery.state !== null && (
              <p>
                <strong>Статус:</strong> {statusLabel(recoveryQuery.data.recovery.state.status)} — {recoveryReasonLabel()}
              </p>
            )}
          </div>
        )}
      </section>
      </div>
      </div>
    </div>
  );
}

function formatArtifactSize(sizeBytes: number): string {
  return `${sizeBytes} Б`;
}

function subjectLabel(type: 'TASK' | 'EPIC' | 'REQUEST'): string {
  return ru.runs.contextManifest.subjects[type];
}

function formatManifestSubject(subject: ContextManifestSubjectProjection | null): string {
  return subject ? `${subjectLabel(subject.type)} · ${subject.id}` : ru.runs.contextManifest.bindingUnknown;
}
