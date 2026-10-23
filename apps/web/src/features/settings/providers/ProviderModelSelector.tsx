/**
 * Модельный выбор провайдера (plan-24, Task 6): каталог моделей с поиском,
 * глобальный дефолт, дефолты по ролям, пользовательские модели и refresh из
 * API. Без секретов; значения моделей — только идентификаторы и имена.
 */

import { useMemo, useState } from 'react';
import type { ProviderModelsProjection } from '@ebb-orchestrator/contracts';
import { ru } from '../../../i18n/ru.js';
import { ApiError } from '../../../api/client.js';
import { apiErrorMessage } from '../../../i18n/ru.js';
import { addCustomModel, refreshProviderModels, removeCustomModel } from './provider-api.js';

export interface ProviderModelSelectorProps {
  providerId: string;
  models: ProviderModelsProjection | null;
  modelsError: unknown;
  modelsLoading: boolean;
  defaultModelId: string | null;
  roleDefaults: Readonly<Record<string, string>>;
  modelSource: { providerCatalog: boolean; userCustom: boolean } | undefined;
  onSaveDefaults: (modelSelection: { defaultModelId: string | null; roleDefaults: Record<string, string> }) => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
}

const COMMON_ROLES = ['coordinator', 'product_manager', 'architect', 'developer', 'reviewer', 'qa', 'integration'];

/** Модельный раздел провайдера: список, дефолты, роли, custom, refresh. */
export default function ProviderModelSelector({
  providerId, models, modelsError, modelsLoading, defaultModelId, roleDefaults, modelSource,
  onSaveDefaults, onChanged, onError,
}: ProviderModelSelectorProps) {
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [customModelId, setCustomModelId] = useState('');
  const [roleInput, setRoleInput] = useState('');

  const entries = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = models?.entries ?? [];
    if (term.length === 0) return list;
    return list.filter((entry) => `${entry.displayName} ${entry.modelId}`.toLowerCase().includes(term));
  }, [models, search]);

  const saveDefaults = async (next: { defaultModelId: string | null; roleDefaults: Record<string, string> }) => {
    setBusy(true);
    setMessage(null);
    try {
      await onSaveDefaults(next);
      setMessage(ru.providers.configSaved);
      onChanged();
    } catch (cause) {
      const text = apiErrorMessage(cause instanceof ApiError ? cause.code : undefined);
      setMessage(text);
      onError(text);
    } finally {
      setBusy(false);
    }
  };

  const addCustom = async () => {
    const modelId = customModelId.trim();
    if (modelId.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await addCustomModel(providerId, modelId);
      setCustomModelId('');
      setMessage(ru.providers.configSaved);
      onChanged();
    } catch (cause) {
      const text = apiErrorMessage(cause instanceof ApiError ? cause.code : undefined);
      setMessage(text);
      onError(text);
    } finally {
      setBusy(false);
    }
  };

  const removeCustom = async (modelId: string) => {
    setBusy(true);
    try {
      await removeCustomModel(providerId, modelId);
      onChanged();
    } catch (cause) {
      onError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await refreshProviderModels(providerId);
      setMessage(ru.providers.modelsRefreshed);
      onChanged();
    } catch (cause) {
      const text = apiErrorMessage(cause instanceof ApiError ? cause.code : undefined);
      setMessage(text);
      onError(text);
    } finally {
      setBusy(false);
    }
  };

  const updateRoleDefault = (role: string, modelId: string) => {
    const next = { ...roleDefaults, [role]: modelId };
    void saveDefaults({ defaultModelId, roleDefaults: next });
  };

  const removeRoleDefault = (role: string) => {
    const next = { ...roleDefaults };
    delete next[role];
    void saveDefaults({ defaultModelId, roleDefaults: next });
  };

  const addRoleDefault = () => {
    const role = roleInput.trim();
    if (role.length === 0) return;
    if (Object.hasOwn(roleDefaults, role)) return;
    setRoleInput('');
    void saveDefaults({ defaultModelId, roleDefaults: { ...roleDefaults, [role]: '' } });
  };

  if (modelsLoading && !models) return <p>{ru.common.loading}</p>;
  if (modelsError && !models) return <p className="error">{ru.errors.default}</p>;

  return (
    <div className="provider-models">
      <div className="provider-toolbar">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={ru.providers.modelSearch}
          aria-label={ru.providers.modelSearch}
        />
        {modelSource?.providerCatalog && (
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? ru.providers.refreshModelsRunning : ru.providers.refreshModels}
          </button>
        )}
      </div>

      <div className="provider-models-defaults">
        <label className="provider-field">
          <span>{ru.providers.defaultModel}</span>
          <select
            value={defaultModelId ?? ''}
            onChange={(event) => void saveDefaults({ defaultModelId: event.target.value || null, roleDefaults })}
            aria-label={ru.providers.defaultModel}
          >
            <option value="">{ru.providers.noDefaultModel}</option>
            {entries.map((entry) => (
              <option key={entry.modelId} value={entry.modelId}>{entry.displayName}</option>
            ))}
          </select>
        </label>

        <fieldset className="provider-role-defaults">
          <legend>{ru.providers.roleDefaults}</legend>
          {Object.entries(roleDefaults).map(([role, modelId]) => (
            <div key={role} className="provider-role-row">
              <code>{role}</code>
              <select
                value={modelId}
                onChange={(event) => updateRoleDefault(role, event.target.value)}
                aria-label={`Модель для роли ${role}`}
              >
                <option value="">{ru.providers.noDefaultModel}</option>
                {entries.map((entry) => (
                  <option key={entry.modelId} value={entry.modelId}>{entry.displayName}</option>
                ))}
              </select>
              <button type="button" onClick={() => removeRoleDefault(role)} aria-label={`Удалить роль ${role}`}>×</button>
            </div>
          ))}
          <div className="provider-role-row">
            <input
              list="provider-roles"
              value={roleInput}
              onChange={(event) => setRoleInput(event.target.value)}
              placeholder={ru.providers.rolePlaceholder}
              aria-label={ru.providers.rolePlaceholder}
            />
            <datalist id="provider-roles">
              {COMMON_ROLES.map((role) => <option key={role} value={role} />)}
            </datalist>
            <button type="button" onClick={addRoleDefault} disabled={busy}>{ru.providers.addRole}</button>
          </div>
        </fieldset>
      </div>

      {modelSource?.userCustom && (
        <div className="provider-custom-add">
          <input
            value={customModelId}
            onChange={(event) => setCustomModelId(event.target.value)}
            placeholder={ru.providers.customModelIdPlaceholder}
            aria-label={ru.providers.addCustomModel}
          />
          <button type="button" onClick={() => void addCustom()} disabled={busy}>{ru.providers.addCustomModel}</button>
        </div>
      )}

      {entries.length === 0 ? (
        <p>{ru.providers.empty}</p>
      ) : (
        <ul className="provider-model-list">
          {entries.map((entry) => (
            <li key={`${entry.origin}:${entry.modelId}`}>
              <div>
                <strong>{entry.displayName}</strong>
                <code>{entry.modelId}</code>
              </div>
              <div className="provider-model-meta">
                <span className="capability-chip">
                  {entry.origin === 'catalog' && ru.providers.modelOriginCatalog}
                  {entry.origin === 'custom' && ru.providers.modelOriginCustom}
                  {entry.origin === 'api' && ru.providers.modelOriginApi}
                </span>
                {entry.contextWindowTokens != null && <span>{ru.providers.contextWindow}: {entry.contextWindowTokens}</span>}
                {entry.maxOutput != null && <span>{ru.providers.maxOutput}: {entry.maxOutput}</span>}
                {entry.origin === 'custom' && (
                  <button type="button" onClick={() => void removeCustom(entry.modelId)} aria-label={`Удалить модель ${entry.modelId}`}>×</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {message && <p role="status">{message}</p>}
    </div>
  );
}
