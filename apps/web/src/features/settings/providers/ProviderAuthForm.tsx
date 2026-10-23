/**
 * Формы аутентификации провайдеров (plan-24, Task 6).
 *
 * - `form`-методы (api-key, subscription-token, credential-fields): поля
 *   ввода без эха сохранённых значений; placeholder не отображает секрет.
 * - `interactive`-методы (oauth-device-code, oauth-pkce): запуск потока,
 *   показ verification URL/кода устройства, опрос статуса, отмена.
 * - `ambient` (cloud-identity): пояснение без ввода ключей.
 * - `endpoint` (local-endpoint): подсказка, что endpoint задаётся в разделе
 *   конфигурации.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderAuthMethodKind, ProviderSchemaFieldProjection } from '@ebb-orchestrator/contracts';
import { ru } from '../../../i18n/ru.js';
import { ApiError } from '../../../api/client.js';
import { apiErrorMessage } from '../../../i18n/ru.js';
import {
  cancelProviderAuthFlow,
  getProviderAuthFlow,
  saveProviderCredential,
  startProviderAuthFlow,
  type ProviderAuthFlowProjection,
  type ProviderBeginAuthResult,
} from './provider-api.js';

function authMethodHint(methodId: string): string {
  const hints = ru.providers.authMethodHints as Record<string, string>;
  return hints[methodId] ?? '';
}

export interface ProviderAuthFormProps {
  providerId: string;
  authMethodKinds: Readonly<Record<string, ProviderAuthMethodKind>>;
  credentialFields: readonly ProviderSchemaFieldProjection[];
  selectedAuthMethod: string;
  hasCredential: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}

function FieldInput({ field, onChange }: { field: ProviderSchemaFieldProjection; onChange: (value: string) => void }) {
  const [value, setValue] = useState('');
  const isSecret = field.kind.includes('key') || field.kind.includes('token');
  return (
    <label className="provider-field">
      <span>{field.label}{field.required ? ' *' : ''}</span>
      <input
        type={isSecret ? 'password' : 'text'}
        autoComplete="off"
        value={value}
        onChange={(event) => { setValue(event.target.value); onChange(event.target.value); }}
        placeholder={isSecret ? ru.providers.secretFieldPlaceholder : ''}
        aria-label={field.label}
      />
      {isSecret && <small>{authMethodHint('api-key')}</small>}
    </label>
  );
}

function InteractiveAuthFlow({
  providerId, methodId, onChanged, onError,
}: { providerId: string; methodId: string; onChanged: () => void; onError: (m: string) => void }) {
  const [flow, setFlow] = useState<ProviderBeginAuthResult | null>(null);
  const [flowStatus, setFlowStatus] = useState<ProviderAuthFlowProjection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  useEffect(() => stopPolling, [stopPolling]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await startProviderAuthFlow(providerId, methodId);
      setFlow(result);
      const intervalMs = Math.max(2000, result.pollIntervalSeconds * 1000);
      timerRef.current = window.setInterval(() => {
        void getProviderAuthFlow(result.flowId).then((status) => {
          setFlowStatus(status);
          if (status.status !== 'PENDING') {
            stopPolling();
            onChanged();
          }
        }).catch(() => undefined);
      }, intervalMs);
    } catch (cause) {
      setError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
      onError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!flow) return;
    setBusy(true);
    try {
      await cancelProviderAuthFlow(flow.flowId);
      stopPolling();
      onChanged();
    } catch (cause) {
      setError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    } finally {
      setBusy(false);
    }
  };

  if (!flow) {
    return (
      <div className="provider-auth-flow">
        <p>{authMethodHint(methodId)}</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" onClick={() => void start()} disabled={busy}>{ru.providers.startAuth}</button>
      </div>
    );
  }

  const status = flowStatus;
  const pending = !status || status.status === 'PENDING';
  return (
    <div className="provider-auth-flow">
      <p>{authMethodHint(methodId)}</p>
      {flow.verificationUrl && (
        <p><a href={flow.verificationUrl} target="_blank" rel="noreferrer">{flow.verificationUrl}</a></p>
      )}
      {flow.userCode && (
        <p className="provider-user-code">Код: <strong>{flow.userCode}</strong></p>
      )}
      <p>Срок действия: {new Date(flow.expiresAt).toLocaleString()}</p>
      {status && status.status === 'EXPIRED' && <p className="error">{ru.providers.expired}</p>}
      {status && status.status === 'COMPLETE' && <p>{ru.providers.connected}</p>}
      {status && status.status === 'CANCELLED' && <p>{ru.providers.disconnected}</p>}
      <div className="provider-actions">
        <button type="button" onClick={() => void cancel()} disabled={busy || !pending}>{ru.providers.cancelAuth}</button>
        {pending && <span className="provider-pending">{ru.providers.pending}…</span>}
      </div>
    </div>
  );
}

/** Формы аутентификации провайдера по выбранному методу. */
export default function ProviderAuthForm({ providerId, authMethodKinds, credentialFields, selectedAuthMethod, hasCredential, onChanged, onError }: ProviderAuthFormProps) {
  const kind = authMethodKinds[selectedAuthMethod] ?? 'form';

  if (kind === 'interactive') {
    return <InteractiveAuthFlow providerId={providerId} methodId={selectedAuthMethod} onChanged={onChanged} onError={onError} />;
  }

  if (kind === 'ambient') {
    return (
      <div className="provider-auth-ambient">
        <p>{authMethodHint(selectedAuthMethod)}</p>
      </div>
    );
  }

  if (kind === 'endpoint') {
    return (
      <div className="provider-auth-ambient">
        <p>{authMethodHint(selectedAuthMethod)}</p>
        <p role="note">{ru.providers.localEndpointWarning}</p>
      </div>
    );
  }

  const formFields = credentialFields.filter((field) => !field.managedByAuthFlow);

  if (formFields.length === 0) {
    return (
      <div className="provider-auth-ambient">
        <p>{authMethodHint(selectedAuthMethod)}</p>
      </div>
    );
  }

  return (
    <div className="provider-auth-form">
      {Array.from(new Set(credentialFields.filter((f) => f.managedByAuthFlow).map((f) => f.label))).length > 0 && (
        <p role="note">Часть полей управляется потоком авторизации и не вводится здесь.</p>
      )}
      <CredentialFormBody
        providerId={providerId}
        authMethodId={selectedAuthMethod}
        fields={formFields}
        hasCredential={hasCredential}
        onChanged={onChanged}
        onError={onError}
      />
    </div>
  );
}

function CredentialFormBody({
  providerId, authMethodId, fields, hasCredential, onChanged, onError,
}: {
  providerId: string;
  authMethodId: string;
  fields: readonly ProviderSchemaFieldProjection[];
  hasCredential: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    const payload: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.name] ?? '';
      if (value.length > 0) payload[field.name] = value;
      else if (field.required) {
        setMessage(`Заполните поле «${field.label}».`);
        return;
      }
    }
    if (Object.keys(payload).length === 0) {
      setMessage(hasCredential ? 'Введите новое значение.' : 'Введите учётные данные.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await saveProviderCredential(providerId, authMethodId, payload);
      setValues({});
      setMessage(ru.providers.credentialSaved);
      onChanged();
    } catch (cause) {
      const text = apiErrorMessage(cause instanceof ApiError ? cause.code : undefined);
      setMessage(text);
      onError(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          onChange={(value) => setValues((prev) => ({ ...prev, [field.name]: value }))}
        />
      ))}
      <div className="provider-actions">
        <button type="button" onClick={() => void submit()} disabled={busy}>
          {hasCredential ? ru.providers.replaceCredential : ru.providers.saveCredential}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
