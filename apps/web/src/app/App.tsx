import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';
import { useEventClient } from '../hooks/useEventClient.js';
import LoginPage from '../features/auth/LoginPage.js';
import { logout } from '../api/client.js';
import { eventClient } from '../api/events.js';
import { router } from './router.js';

export type AuthState = 'restoring' | 'login' | 'authenticated' | 'expired' | 'error';
export interface AppProps { initialState?: AuthState; initializationError?: string; }
/** Рендерит защищённый shell и завершает сессию по сигналу SSE или logout. */
function AuthenticatedApp({ onExpired }: { onExpired: () => void }) { useEventClient(onExpired); return <><button type="button" onClick={() => void logout().then(onExpired)}>Выйти</button><RouterProvider router={router} /></>; }
/** Рендерит явное состояние восстановления, входа, авторизации или истечения сессии. */
export default function App({ initialState = 'restoring', initializationError }: AppProps) {
  const [state, setState] = useState<AuthState>(initialState);
  const [error, setError] = useState(initializationError ?? '');
  useEffect(() => {
    setState(initialState);
    setError(initializationError ?? '');
  }, [initialState, initializationError]);
  if (state === 'restoring') return <main aria-live="polite"><p>Восстанавливаем сессию…</p></main>;
  if (state === 'authenticated') return <AuthenticatedApp onExpired={() => setState('expired')} />;
  if (state === 'login' || state === 'expired') return <><LoginPage error={state === 'expired' ? 'Сессия истекла. Войдите снова.' : error} onAuthenticated={() => { eventClient.rearmAfterAuth(); setState('authenticated'); }} /></>;
  return <main role="alert" aria-live="assertive"><h1>Сессия недоступна</h1><p>{error}</p></main>;
}
