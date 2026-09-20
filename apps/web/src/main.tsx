import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App.js';
import { bootstrap, restoreSession } from './api/client.js';
import './styles/base.css';

function renderApp(bootstrapError?: string) {
  const appProps = bootstrapError === undefined ? {} : { bootstrapError };

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App {...appProps} />
    </React.StrictMode>
  );
}

function consumeLaunchToken(): string {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const launchToken = hash.get('ebb-bootstrap') ?? '';
  if (window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return launchToken;
}

const launchToken = consumeLaunchToken();
const sessionInitialization = launchToken ? bootstrap(launchToken) : restoreSession();

void sessionInitialization.then(() => renderApp()).catch((error: unknown) => {
  renderApp(error instanceof Error ? error.message : 'Unable to establish the local session.');
});
