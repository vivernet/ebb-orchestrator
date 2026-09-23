import { afterEach, describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import OnboardingPage from '../../src/features/onboarding/OnboardingPage.js';

const server = setupServer(
  http.post('/api/v1/onboarding/discover', async ({ request }) => {
    const body = (await request.json()) as { repositoryPath: string };
    if (!body.repositoryPath || typeof body.repositoryPath !== 'string') {
      return HttpResponse.json({ error: 'repositoryPath is required' }, { status: 400 });
    }
    return HttpResponse.json({
      projectId: 'test-project-123',
      repository: { path: 'user/repo', remoteUrl: null },
      detected: {
        defaultBranch: 'main',
        packageManager: 'pnpm',
        testFramework: 'vitest',
        orchestratorConfigFound: true,
      },
      proposed: {
        defaultBranch: 'main',
        workflow: 'sequential',
        roles: ['executor', 'reviewer'],
        guidelines: ['Conventional commits', 'TypeScript strict'],
      },
      approvalStatus: 'PENDING',
      semanticConfigApproved: false,
      localModeEnabled: false,
    });
  }),
);

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' });
  vi.clearAllMocks();
});

afterEach(() => server.close());

describe('OnboardingPage', () => {
  test('renderует форму discovery в начальном состоянии', () => {
    render(<OnboardingPage />);
    expect(screen.getByRole('heading', { name: 'Project Onboarding' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Путь к репозиторию' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Начать анализ' })).toBeVisible();
  });

  test('вызывает API при submit формы', async () => {
    render(<OnboardingPage />);
    const input = screen.getByRole('textbox', { name: 'Путь к репозиторию' });
    const button = screen.getByRole('button', { name: 'Начать анализ' });

    fireEvent.change(input, { target: { value: 'https://github.com/user/repo' } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Репозиторий')).toBeInTheDocument();
    }, { timeout: 5000 });

    expect(screen.getByText(/pnpm/)).toBeInTheDocument();
  });

  test('показывает состояние загрузки', async () => {
    render(<OnboardingPage />);
    const input = screen.getByRole('textbox', { name: 'Путь к репозиторию' });
    const button = screen.getByRole('button', { name: 'Начать анализ' });

    fireEvent.change(input, { target: { value: 'https://github.com/user/repo' } });
    fireEvent.click(button);

    expect(button).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByText('Репозиторий')).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  test('обрабатывает ошибку API', async () => {
    server.use(
      http.post('/api/v1/onboarding/discover', () => {
        return HttpResponse.json({ error: 'Failed to connect' }, { status: 500 });
      }),
    );

    render(<OnboardingPage />);
    const input = screen.getByRole('textbox', { name: 'Путь к репозиторию' });
    const button = screen.getByRole('button', { name: 'Начать анализ' });

    fireEvent.change(input, { target: { value: 'https://github.com/user/repo' } });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Ошибка')).toBeVisible();
    });
  });

  test('валидирует пустой URL', () => {
    render(<OnboardingPage />);
    const button = screen.getByRole('button', { name: 'Начать анализ' });
    fireEvent.click(button);
    expect(screen.getByRole('textbox', { name: 'Путь к репозиторию' })).toHaveAttribute('value', '');
  });
});
