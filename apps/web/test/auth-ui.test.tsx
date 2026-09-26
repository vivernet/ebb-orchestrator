import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../src/app/App.js';
import LoginPage from '../src/features/auth/LoginPage.js';
import { eventClient } from '../src/api/events.js';

const sessionResponse = {
  contractVersion: 1,
  csrfToken: 'fresh-csrf',
  expiresAt: '2026-09-25T00:00:00.000Z',
  authenticated: true,
};

describe('authentication UI states', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('focuses the password field on initial login render', () => {
    render(<LoginPage onAuthenticated={vi.fn()} />);

    expect(screen.getByLabelText('Пароль')).toHaveFocus();
  });

  test('announces login errors and returns focus to the password field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      contractVersion: 1,
      error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Неверный пароль.' },
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));
    render(<LoginPage onAuthenticated={vi.fn()} />);
    const password = screen.getByLabelText('Пароль');

    fireEvent.change(password, { target: { value: 'wrong-password' } });
    fireEvent.submit(password.closest('form')!);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('Неверный пароль.');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-describedby', 'login-error');
    expect(password).toHaveFocus();
  });

  test('mounts SSE only for authenticated state', async () => {
    const connect = vi.spyOn(eventClient, 'connect');

    render(<App initialState="authenticated" />);

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  });

  test('transitions from login to authenticated and back to login on logout', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(<App initialState="login" />);

    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'correct-password' } });
    fireEvent.submit(screen.getByLabelText('Пароль').closest('form')!);
    expect(await screen.findByRole('button', { name: 'Выйти' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Вход в Ebb Orchestrator' })).toBeInTheDocument());
    expect(screen.getByLabelText('Пароль')).toHaveFocus();
  });
});
