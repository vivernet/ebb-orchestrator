import { afterEach, describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import OnboardingPage from '../../src/features/onboarding/OnboardingPage.js';
import { apiClient } from '../../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('OnboardingPage (reference 07)', () => {
  test('рендерит шаги, выбранный репозиторий и обнаруженные факты', () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({});
    render(<OnboardingPage />);

    expect(screen.getByRole('heading', { name: 'Добавление проекта · обнаружение репозитория' })).toBeVisible();
    expect(screen.getByLabelText('Этапы онбординга')).toBeVisible();
    expect(screen.getByText('Выбранный репозиторий')).toBeVisible();
    expect(screen.getByText('Default ветка: master')).toBeVisible();
    expect(screen.getByText('Package manager: pnpm')).toBeVisible();
    expect(screen.getByText('C:\Repos\ebb-ai-hub')).toBeVisible();
  });

  test('панели без авторитетного источника рендерят «недоступно»', () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({});
    render(<OnboardingPage />);

    expect(screen.getAllByText('Недоступно').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('Координатор proposals')).toBeVisible();
    expect(screen.getByText('Проверка конфигурации проекта')).toBeVisible();
    expect(screen.getByText('Создаваемые файлы')).toBeVisible();
    expect(screen.getByText('Итоги активации')).toBeVisible();
  });

  test('активация отправляет discovery API и не падает', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({});
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({});
    render(<OnboardingPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Согласовать и активировать проект' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/onboarding/discover', { repositoryPath: 'C:/Repos/ebb-ai-hub' }));
  });

  test('ошибка API локализована без раскрытия деталей', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({});
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('SYNTHETIC_SECRET_TOKEN_7f3a'));
    render(<OnboardingPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Согласовать и активировать проект' }));
    expect(await screen.findByText(/Не удалось выполнить обнаружение/)).toBeVisible();
    expect(document.body).not.toHaveTextContent(/SYNTHETIC_SECRET_TOKEN/);
  });
});
