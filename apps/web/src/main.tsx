import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App.js';
import type { AuthState } from './app/App.js';
import { ApiError, restoreSession } from './api/client.js';
import { apiErrorMessage } from './i18n/ru.js';
import './styles/base.css';

/** Монтирует приложение и переводит корневой render после завершения восстановления сессии. */
export function bootstrap(rootElement: HTMLElement) {
  const root = ReactDOM.createRoot(rootElement);
  function render(state: AuthState, error?: string) {
    root.render(<React.StrictMode><App {...(error === undefined ? { initialState: state } : { initialState: state, initializationError: error })} /></React.StrictMode>);
  }
  render('restoring');
  void restoreSession().then(() => render('authenticated')).catch((cause: unknown) => {
    if (cause instanceof ApiError && (cause.code === 'AUTH_SESSION_REQUIRED' || cause.code === 'AUTH_SESSION_INVALID')) { render(cause.code === 'AUTH_SESSION_INVALID' ? 'expired' : 'login', apiErrorMessage(cause.code)); return; }
    if (cause instanceof ApiError && [400, 403, 503].includes(cause.status)) { render('error', cause.status === 400 ? 'Некорректный запрос восстановления.' : cause.status === 403 ? 'Доступ запрещён.' : 'Сервис временно недоступен.'); return; }
    render('error', 'Не удалось восстановить сессию.');
  });
  return root;
}

const rootElement = document.getElementById('root');
if (rootElement) bootstrap(rootElement);
