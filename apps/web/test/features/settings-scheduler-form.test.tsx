import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import SettingsPage from '../../src/features/settings/SettingsPage.js';
import { apiClient } from '../../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

const settingsFixture = {
  effectiveHierarchy: {
    global: { schemaVersion: 1, globalMax: 7, projectMax: 3, roleCapacity: { developer: 4 } },
    project: null,
    role: null,
    taskEpic: null,
  },
  securitySettings: { mostRestrictiveWins: true, localModeEnabled: true },
  providerSelection: { defaultModel: 'default', models: [] },
};

describe('SettingsPage scheduler form', () => {
  test('редактирование глобального лимита отправляет PUT /scheduler/config и перезагружает проекцию', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsFixture);
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue(settingsFixture);

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));

    const globalMaxInput = screen.getByLabelText('Общий максимум');
    fireEvent.change(globalMaxInput, { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(put).toHaveBeenCalledWith('/scheduler/config', {
      schemaVersion: 1, globalMax: 9, projectMax: 3, roleCapacity: { developer: 4 },
    }));
    expect(screen.getByText('Настройки сохранены')).toBeInTheDocument();
  });

  test('пустые значения отправляются как null', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsFixture);
    const put = vi.spyOn(apiClient, 'put').mockResolvedValue(settingsFixture);

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));

    const globalMaxInput = screen.getByLabelText('Общий максимум');
    fireEvent.change(globalMaxInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(put).toHaveBeenCalledWith('/scheduler/config', {
      schemaVersion: 1, globalMax: null, projectMax: 3, roleCapacity: { developer: 4 },
    }));
  });

  test('ошибка сохранения выводится безопасно', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsFixture);
    vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('secret scheduler detail'));

    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить настройки: Не удалось выполнить запрос.');
    expect(screen.queryByText(/secret scheduler detail/)).not.toBeInTheDocument();
  });
});
