/**
 * Страница провайдера (plan-24, Task 6): статус, конфигурация, аутентификация
 * по методу, проверка соединения, отключение и модельный выбор.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { PageState } from '../../../components/ui/PageState.js';
import { useQuery } from '../../../state/use-query.js';
import { ApiError } from '../../../api/client.js';
import { apiErrorMessage, ru } from '../../../i18n/ru.js';
import {
  deleteProviderCredential,
  disconnectProvider,
  getProviderAuthStatus,
  getProviderDetail,
  getProviderModels,
  saveProviderConfig,
  testProviderConnection,
  type ProviderAuthStatusProjection,
} from './provider-api.js';
import ProviderAuthForm from './ProviderAuthForm.js';
import ProviderModelSelector from './ProviderModelSelector.js';
import { ProviderStatusBanner, providerStatusView } from './ProviderStatus.js';
import '../../../styles/provider.css';

/** Страница провайдера: статус, конфигурация, аутентификация, модели. */
export default function ProviderDetailPage() {
  const { providerId = '' } = useParams();

  const detailFetcher = useCallback((_signal: AbortSignal) => getProviderDetail(providerId), [providerId]);
  const detailQuery = useQuery(null, `/api/v1/providers/${providerId}`, undefined, detailFetcher);

  const authStatusFetcher = useCallback((_signal: AbortSignal) => getProviderAuthStatus(providerId), [providerId]);
  const authQuery = useQuery(null, `/api/v1/providers/auth/status/${providerId}`, undefined, authStatusFetcher);

  const modelsFetcher = useCallback((_signal: AbortSignal) => getProviderModels(providerId), [providerId]);
  const modelsQuery = useQuery(null, `/api/v1/providers/${providerId}/models`, undefined, modelsFetcher);

  const reloadAll = useCallback(() => {
    void detailQuery.refetch().catch(() => undefined);
    void authQuery.refetch().catch(() => undefined);
    void modelsQuery.refetch().catch(() => undefined);
  }, [detailQuery.refetch, authQuery.refetch, modelsQuery.refetch]);

  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Локальное состояние формы конфигурации.
  const [enabled, setEnabled] = useState(false);
  const [selectedAuthMethod, setSelectedAuthMethod] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [configBusy, setConfigBusy] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionResult, setConnectionResult] = useState<string | null>(null);

  const detail = detailQuery.data;
  const status = detail?.status;

  useEffect(() => {
    if (!detail) return;
    setEnabled(status?.enabled ?? false);
    setSelectedAuthMethod(status?.selectedAuthMethod ?? detail.authMethods[0] ?? '');
  }, [detail, status?.enabled, status?.selectedAuthMethod]);

  const authStatus: ProviderAuthStatusProjection | undefined = authQuery.data;
  const view = providerStatusView(status, authStatus, detailQuery.status === 'error' ? detailQuery.error : undefined, detailQuery.status === 'loading' || detailQuery.status === 'idle');

  const saveConfig = async () => {
    const config: Record<string, string | number | boolean> = {};
    for (const field of detail?.configFields ?? []) {
      const value = configValues[field.name] ?? '';
      if (value.length > 0) {
        if (field.kind === 'boolean') config[field.name] = value === 'true';
        else if (field.kind.includes('number')) config[field.name] = Number(value);
        else config[field.name] = value;
      }
    }
    setConfigBusy(true);
    setNotice(null);
    try {
      await saveProviderConfig(providerId, {
        enabled,
        selectedAuthMethod,
        modelSelection: {
          defaultModelId: status?.defaultModelId ?? null,
          roleDefaults: status?.roleDefaults ?? {},
        },
        ...(Object.keys(config).length > 0 ? { config } : { config: {} }),
      });
      setNotice(ru.providers.configSaved);
      setConfigValues({});
      reloadAll();
    } catch (cause) {
      setPageError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    } finally {
      setConfigBusy(false);
    }
  };

  const saveModelDefaults = async (modelSelection: { defaultModelId: string | null; roleDefaults: Record<string, string> }) => {
    await saveProviderConfig(providerId, {
      enabled,
      selectedAuthMethod,
      modelSelection,
      config: {},
    });
  };

  const runConnectionTest = async () => {
    setConnectionBusy(true);
    setConnectionResult(null);
    try {
      const result = await testProviderConnection(providerId);
      setConnectionResult(result.ok ? ru.providers.connectionOk : `${ru.providers.connectionFailed} (${result.errorKind ?? result.status ?? '?'})`);
    } catch (cause) {
      setConnectionResult(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    } finally {
      setConnectionBusy(false);
    }
  };

  const removeCredential = async () => {
    const method = status?.selectedAuthMethod ?? selectedAuthMethod;
    if (!method) return;
    try {
      await deleteProviderCredential(providerId, method);
      setNotice(ru.providers.credentialRemoved);
      reloadAll();
    } catch (cause) {
      setPageError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    }
  };

  const disconnect = async () => {
    if (!window.confirm(ru.providers.disconnectConfirm)) return;
    try {
      await disconnectProvider(providerId);
      setNotice(ru.providers.disconnected);
      reloadAll();
    } catch (cause) {
      setPageError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    }
  };

  const errorText = useMemo(() => apiErrorMessage(detailQuery.error instanceof ApiError ? detailQuery.error.code : undefined), [detailQuery.error]);

  if (detailQuery.status === 'loading' || detailQuery.status === 'idle') {
    return <PageState status="loading" message="Загрузка провайдера…" />;
  }
  if (detailQuery.status === 'error' || !detail) {
    const notFound = detailQuery.error instanceof ApiError && detailQuery.error.status === 404;
    return (
      <PageState
        status="error"
        title={ru.providers.pageTitle}
        message={notFound ? ru.providers.unknownProvider : errorText}
        onRetry={() => void detailQuery.refetch().catch(() => undefined)}
      />
    );
  }

  return (
    <div className="provider-detail-page page-stack">
      <header className="page-header">
        <div>
          <p className="eyebrow"><Link to="/settings/providers">{ru.providers.backToCatalog}</Link></p>
          <h1>{detail.displayName}</h1>
        </div>
        <span className="provider-category">{ru.providers.categories[detail.category]}</span>
      </header>

      <ProviderStatusBanner view={view} />

      {pageError && <p className="error" role="alert">{pageError}</p>}
      {notice && <p role="status">{notice}</p>}

      <div className="provider-capabilities">
        {detail.capabilities.map((cap) => (
          <span key={cap} className="capability-chip">{ru.providers.capabilities[cap] ?? cap}</span>
        ))}
      </div>

      <section aria-label={ru.providers.configSection}>
        <h2>{ru.providers.configSection}</h2>
        <label className="provider-field provider-toggle">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>Включить провайдера</span>
        </label>

        <label className="provider-field">
          <span>Метод аутентификации</span>
          <select value={selectedAuthMethod} onChange={(event) => setSelectedAuthMethod(event.target.value)} aria-label="Метод аутентификации">
            {detail.authMethods.map((method) => (
              <option key={method} value={method}>{ru.providers.authMethods[method] ?? method}</option>
            ))}
          </select>
        </label>

        {detail.configFields.map((field) => (
          <label key={field.name} className="provider-field">
            <span>{field.label}{field.required ? ' *' : ''}</span>
            {field.kind === 'boolean' ? (
              <select
                value={configValues[field.name] ?? 'false'}
                onChange={(event) => setConfigValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
                aria-label={field.label}
              >
                <option value="false">Нет</option>
                <option value="true">Да</option>
              </select>
            ) : (
              <input
                type={field.kind === 'endpoint' ? 'url' : 'text'}
                value={configValues[field.name] ?? ''}
                onChange={(event) => setConfigValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
                placeholder=""
                aria-label={field.label}
              />
            )}
          </label>
        ))}

        <div className="provider-actions">
          <button type="button" onClick={() => void saveConfig()} disabled={configBusy}>{ru.providers.saveConfig}</button>
          <button type="button" onClick={() => void runConnectionTest()} disabled={connectionBusy}>
            {connectionBusy ? ru.providers.testConnectionRunning : ru.providers.testConnection}
          </button>
        </div>
        {connectionResult && <p role="status">{connectionResult}</p>}
      </section>

      <section aria-label={ru.providers.authSection}>
        <h2>{ru.providers.authSection}</h2>
        <ProviderAuthForm
          providerId={providerId}
          authMethodKinds={detail.authMethodKinds}
          credentialFields={detail.credentialFields}
          selectedAuthMethod={selectedAuthMethod}
          hasCredential={status?.hasCredential ?? false}
          onChanged={reloadAll}
          onError={setPageError}
        />
        {status?.hasCredential && (
          <div className="provider-actions">
            <button type="button" onClick={() => void removeCredential()} className="danger-button">{ru.providers.removeCredential}</button>
            <button type="button" onClick={() => void disconnect()} className="danger-button">{ru.providers.disconnect}</button>
          </div>
        )}
        <p role="note">{ru.providers.statusNote}</p>
      </section>

      <section aria-label={ru.providers.modelsSection}>
        <h2>{ru.providers.modelsSection}</h2>
        <ProviderModelSelector
          providerId={providerId}
          models={modelsQuery.data ?? null}
          modelsError={modelsQuery.error}
          modelsLoading={modelsQuery.status === 'loading' || modelsQuery.status === 'idle'}
          defaultModelId={status?.defaultModelId ?? null}
          roleDefaults={status?.roleDefaults ?? {}}
          modelSource={detail.modelSource}
          onSaveDefaults={saveModelDefaults}
          onChanged={reloadAll}
          onError={setPageError}
        />
      </section>
    </div>
  );
}
