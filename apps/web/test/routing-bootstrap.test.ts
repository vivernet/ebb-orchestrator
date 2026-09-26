import { describe, expect, test, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { RouteErrorPage, router } from '../src/app/router.js';
import { apiClient, login, logout, restoreSession } from '../src/api/client.js';

describe('routing and session bootstrap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    apiClient.csrfToken = null;
  });

  test('uses stable IDs for core projection routes', () => {
    const routes = router.routes[0]?.children ?? [];
    expect(routes.slice(0, 6).map((route) => route.id)).toEqual([
      'dashboard', 'projects-index', 'project', 'epic', 'project-epic', 'task',
    ]);
  });

  test('keeps every V1 route and exposes an explicit not-found boundary', () => {
    const routes = router.routes[0]?.children ?? [];
    expect(routes.map((route) => route.path)).toEqual([
      '', 'projects', 'projects/:id', 'epics/:id', 'projects/:projectId/epics/:epicId', 'tasks/:id', 'projects/:projectId/tasks/:taskId', 'approvals', 'execution',
      'runs/:id', 'projects/:projectId/runs/:runId', 'usage', 'settings', 'projects/new', 'onboarding/:id', '*',
    ]);
    expect(routes.find((route) => route.path === '*')?.id).toBe('not-found');
    expect(router.routes[0]?.errorElement).toBeDefined();
  });

  test('attaches stable breadcrumb labels to every named route', () => {
    const routes = router.routes[0]?.children ?? [];

    expect(routes.map((route) => route.handle)).toEqual([
      { breadcrumbLabel: 'Обзор' }, { breadcrumbLabel: 'Проекты' }, { breadcrumbLabel: 'Проект' }, { breadcrumbLabel: 'Эпик' },
      { breadcrumbLabel: 'Эпик' }, { breadcrumbLabel: 'Задача' }, { breadcrumbLabel: 'Задача' }, { breadcrumbLabel: 'Согласования' },
      { breadcrumbLabel: 'Выполнение' }, { breadcrumbLabel: 'Запуск' }, { breadcrumbLabel: 'Запуск' }, { breadcrumbLabel: 'Использование' },
      { breadcrumbLabel: 'Настройки' }, { breadcrumbLabel: 'Создание проекта' }, { breadcrumbLabel: 'Создание проекта' }, { breadcrumbLabel: 'Страница не найдена' },
    ]);
  });

  test('renders the not-found page for an unmatched route', async () => {
    const memoryRouter = createMemoryRouter(router.routes, { initialEntries: ['/does-not-exist'] });

    render(createElement(RouterProvider, { router: memoryRouter }));

    expect(await screen.findByRole('heading', { name: 'Страница не найдена' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Вернуться к обзору' })).toHaveAttribute('href', '/');
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

    expect(await screen.findByRole('heading', { name: 'Не удалось безопасно отобразить эту страницу.' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Не удалось безопасно отобразить эту страницу.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private implementation detail');

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.getByText('Recovered route')).toBeInTheDocument());
    expect(attempts).toBe(2);
  });

  test('does not echo untrusted route statusText', async () => {
    const memoryRouter = createMemoryRouter([{
      path: '/', errorElement: createElement(RouteErrorPage), element: createElement('p', null, 'Healthy route'),
      loader: () => { throw new Response('hidden', { status: 503, statusText: 'SECRET_SESSION_TOKEN_123' }); },
    }], { initialEntries: ['/'] });
    render(createElement(RouterProvider, { router: memoryRouter }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось безопасно отобразить эту страницу.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('SECRET_SESSION_TOKEN_123');
    expect(screen.getByRole('alert')).not.toHaveTextContent('503');
  });

  test('logs in with the exact password DTO without a fragment or bearer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      contractVersion: 1, csrfToken: 'memory-csrf', expiresAt: '2030-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await login('correct-password');

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session/login', expect.objectContaining({
      credentials: 'same-origin', method: 'POST', body: JSON.stringify({ password: 'correct-password' }),
    }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('headers.Authorization');
    expect(apiClient.csrfToken).toBe('memory-csrf');
  });

  test('restores a reload-safe local session without exposing a bearer token to JavaScript', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      contractVersion: 1, authenticated: true, csrfToken: 'restored-csrf', expiresAt: '2030-01-01T00:00:00.000Z',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await restoreSession();

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/session', expect.objectContaining({
      credentials: 'same-origin',
    }));
    expect(apiClient.csrfToken).toBe('restored-csrf');
  });

  test('does not create a session when restore is required', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      contractVersion: 1, error: { code: 'AUTH_SESSION_REQUIRED', message: 'Требуется сессия.' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

    await expect(restoreSession()).rejects.toMatchObject({ status: 401, code: 'AUTH_SESSION_REQUIRED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/session');
  });

  test('logout accepts 204 and is idempotent for a missing session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(logout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/session/logout');
  });
});
