import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, login } from '../../api/client.js';
import { apiErrorMessage } from '../../i18n/ru.js';
export interface LoginPageProps { onAuthenticated: () => void; error?: string; }
/** Безопасная форма входа без сохранения password в browser state. */
export default function LoginPage({ onAuthenticated, error: initialError }: LoginPageProps) {
  const [password, setPassword] = useState(''); const [error, setError] = useState(initialError ?? ''); const [pending, setPending] = useState(false); const inputRef = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setError(''); try { await login(password); setPassword(''); onAuthenticated(); } catch (cause) { setError(apiErrorMessage(cause instanceof ApiError ? cause.code : undefined)); inputRef.current?.focus(); } finally { setPending(false); } }
  return <main className="session-login"><form onSubmit={submit} aria-labelledby="login-heading"><p className="eyebrow">Локальный доступ</p><h1 id="login-heading">Вход в Ebb Orchestrator</h1><label htmlFor="login-password">Пароль</label><input ref={inputRef} id="login-password" name="password" type="password" autoComplete="current-password" autoFocus aria-invalid={error ? 'true' : undefined} aria-describedby={error ? 'login-error' : undefined} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={pending} />{error && <p id="login-error" role="alert" aria-live="assertive">{error}</p>}<button type="submit" disabled={pending}>{pending ? 'Входим…' : 'Войти'}</button></form></main>;
}
