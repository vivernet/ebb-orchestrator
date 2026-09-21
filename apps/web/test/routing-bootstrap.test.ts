import { describe, expect, test, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { RouteErrorPage, router } from '../src/app/router.js';
import { apiClient, bootstrap, restoreSession } from '../src/api/client.js';

describe('routing and session bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.sessionToken = null;
    apiClient.csrfToken = null;
  });

  test('uses stable IDs for core projection routes', () => {
    const routes = router.routes[0]?.children ?? [];
    expect(routes.slice(0, 4).map((route) => route.id)).toEqual([
      'dashboard', 'project', 'epic', 'task',
    ]);
  });

  test('keeps every V1 route and exposes an explicit not-found boundary', () => {
    const routes = router.routes[0]?.children ?? [];
    expect(routes.map((route) => route.path)).toEqual([
      '', 'projects/:id', 'epics/:id', 'tasks/:id', 'approvals', 'execution',
      'runs/:id', 'usage', 'settings', 'projects/new', '*',
    ]);
    expect(routes.find((route) => route.path === '*')?.id).toBe('not-found');
    expect(router.routes[0]?.errorElement).toBeDefined();
  });

  test('renders the not-found page for an unmatched route', async () => {
    const memoryRouter = createMemoryRouter(router.routes, { initialEntries: ['/does-not-exist'] });

    render(createElement(RouterProvider, { router: memoryRouter }));

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Dashboard' })).toHaveAttribute('href', '/');
  });

  test('renders a safe route error and retries the failed route', async () => {
    let attempts = 0;
    const memoryRouter = createMemoryRouter([
      {
        path: '/',
        errorElement: createElement(RouteErrorPage),
        children: [{
          index: true,
          loader: () => {
            attempts += 1;
            if (attempts === 1) throw new Error('private implementation detail');
            return null;
          },
          element: createElement('p', null, 'Recovered route'),
        }],
      },
    ], { initialEntries: ['/'] });

    render(createElement(RouterProvider, { router: memoryRouter }));

    expect(await screen.findByRole('heading', { name: 'Unable to render this page' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The route could not be rendered safely.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private implementation detail');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('Recovered route')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });

  test('exchanges the launch token for an in-memory session exactly once', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      sessionToken: 'memory-session', csrfToken: 'memory-csrf', origin: 'http://127.0.0.1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await bootstrap('one-time-launch-token');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session/bootstrap', expect.objectContaining({
      headers: expect.objectContaining({ 'X-EBB-Bootstrap-Token': 'one-time-launch-token' }),
    }));
    expect(apiClient.sessionToken).toBe('memory-session');
    expect(apiClient.csrfToken).toBe('memory-csrf');
  });

  test('restores a reload-safe local session without exposing a bearer token to JavaScript', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      csrfToken: 'restored-csrf', origin: 'http://127.0.0.1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await restoreSession();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session', expect.objectContaining({
      credentials: 'same-origin',
    }));
    expect(apiClient.sessionToken).toBeNull();
    expect(apiClient.csrfToken).toBe('restored-csrf');
  });
});
