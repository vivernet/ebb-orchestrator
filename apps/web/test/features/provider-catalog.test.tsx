import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProviderCatalogPage from '../../src/features/settings/providers/ProviderCatalogPage.js';
import { PROVIDER_CATALOG_PROJECTION, type ProviderSettingsProjection } from '@ebb-orchestrator/contracts';

vi.mock('../../src/features/settings/providers/provider-api.js', () => ({
  getProviderCatalog: vi.fn(),
  getProviderStatuses: vi.fn(),
}));

import { getProviderCatalog, getProviderStatuses } from '../../src/features/settings/providers/provider-api.js';

const mockedGetCatalog = vi.mocked(getProviderCatalog);
const mockedGetStatuses = vi.mocked(getProviderStatuses);

function statusProjection(overrides: Partial<ProviderSettingsProjection>): ProviderSettingsProjection {
  return {
    providerId: 'openai',
    enabled: true,
    selectedAuthMethod: 'api-key',
    currentRevision: 1,
    hasCredential: true,
    credentialStatus: 'ACTIVE',
    defaultModelId: null,
    roleDefaults: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ProviderCatalogPage', () => {
  beforeEach(() => {
    mockedGetCatalog.mockResolvedValue({ contractVersion: 1, version: 1, sourcePin: 'pin', providers: PROVIDER_CATALOG_PROJECTION });
    mockedGetStatuses.mockResolvedValue({ providers: [statusProjection({})] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('отображает все 86 провайдеров и статус подключённого', async () => {
    render(<MemoryRouter><ProviderCatalogPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('OpenAI')).toBeInTheDocument());
    // 86 карточек: по числу записей каталога (без учёта статусных строк).
    const cards = document.querySelectorAll('.provider-card');
    expect(cards.length).toBe(86);
    expect(screen.getByText('Подключён')).toBeInTheDocument();
    expect(screen.getByText('Ai21Labs')).toBeInTheDocument();
  });

  test('поиск фильтрует список', async () => {
    render(<MemoryRouter><ProviderCatalogPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('OpenAI')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'anthropic' } });
    await waitFor(() => {
      expect(document.querySelectorAll('.provider-card').length).toBe(1);
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });
  });

  test('состояние ошибки показывает retry', async () => {
    mockedGetCatalog.mockRejectedValue(new Error('boom'));
    render(<MemoryRouter><ProviderCatalogPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument());
  });
});
