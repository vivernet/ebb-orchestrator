import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App.js';
import { bootstrap } from './api/client.js';
import './styles/base.css';

function renderApp() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap().then(renderApp).catch(renderApp);
