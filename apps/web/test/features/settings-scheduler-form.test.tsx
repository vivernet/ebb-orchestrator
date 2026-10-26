import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('SettingsPage (reference 08) read-only', () => {
  test('рендерит разделы навигации и карточки без форм редактирования', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsFixture);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Настройки проекта · Ebb AI Hub' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Разделы настроек' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Планировщик' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Восстановление' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Git и GitHub' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  test('никогда не выводит секреты и ключи', () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue(settingsFixture);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
    expect(document.body).not.toHaveTextContent(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  });
});
