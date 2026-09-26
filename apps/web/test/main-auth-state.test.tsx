import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { bootstrap } from '../src/main.js';
import { ApiError } from '../src/api/client.js';

const { restoreSessionMock } = vi.hoisted(() => ({ restoreSessionMock: vi.fn() }));

vi.mock('../src/api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api/client.js')>('../src/api/client.js');
  return { ...actual, restoreSession: restoreSessionMock };
});

describe('main auth bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    restoreSessionMock.mockReset();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    {
      name: 'authenticated',
      finish: (resolve: () => void) => resolve(),
      expected: () => expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument(),
    },
    {
      name: 'login',
      finish: (_resolve: () => void, reject: (cause: unknown) => void) => reject(new ApiError('Требуется сессия.', 401, 'AUTH_SESSION_REQUIRED')),
      expected: () => expect(screen.getByRole('heading', { name: 'Вход в Ebb Orchestrator' })).toBeInTheDocument(),
    },
    {
      name: 'error',
      finish: (_resolve: () => void, reject: (cause: unknown) => void) => reject(new ApiError('Unavailable', 503)),
      expected: () => expect(screen.getByRole('heading', { name: 'Сессия недоступна' })).toBeInTheDocument(),
    },
  ])('transitions the root render from restoring to $name', async ({ finish, expected }) => {
    let resolveRestore!: () => void;
    let rejectRestore!: (cause: unknown) => void;
    restoreSessionMock.mockReturnValue(new Promise<void>((resolve, reject) => {
      resolveRestore = resolve;
      rejectRestore = reject;
    }));

    bootstrap(document.getElementById('root')!);
    await waitFor(() => expect(screen.getByText('Восстанавливаем сессию…')).toBeInTheDocument());
    finish(resolveRestore, rejectRestore);
    await waitFor(expected);
  });
});
