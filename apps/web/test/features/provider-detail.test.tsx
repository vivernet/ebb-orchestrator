import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PROVIDER_CATALOG_PROJECTION } from '@ebb-orchestrator/contracts';
import { ApiError } from '../../src/api/client.js';
import ProviderDetailPage from '../../src/features/settings/providers/ProviderDetailPage.js';

vi.mock('../../src/features/settings/providers/provider-api.js', () => ({
  getProviderDetail: vi.fn(),
  getProviderAuthStatus: vi.fn(),
  getProviderModels: vi.fn(),
  saveProviderConfig: vi.fn(),
  saveProviderCredential: vi.fn(),
  deleteProviderCredential: vi.fn(),
  disconnectProvider: vi.fn(),
  testProviderConnection: vi.fn(),
  startProviderAuthFlow: vi.fn(),
  getProviderAuthFlow: vi.fn(),
  cancelProviderAuthFlow: vi.fn(),
}));

import {
  deleteProviderCredential,
  getProviderAuthStatus,
  getProviderDetail,
  getProviderModels,
  saveProviderConfig,
  saveProviderCredential,
} from '../../src/features/settings/providers/provider-api.js';

const mockedDetail = vi.mocked(getProviderDetail);
const mockedAuthStatus = vi.mocked(getProviderAuthStatus);
const mockedModels = vi.mocked(getProviderModels);
const mockedSaveConfig = vi.mocked(saveProviderConfig);
const mockedSaveCredential = vi.mocked(saveProviderCredential);
const mockedDeleteCredential = vi.mocked(deleteProviderCredential);

const openaiDetail = {
  ...PROVIDER_CATALOG_PROJECTION.find((entry) => entry.id === 'openai')!,
  authMethodKinds: { 'api-key': 'form' as const },
  configFields: [{ name: 'fetcher', label: 'Загружать список моделей из API провайдера', kind: 'boolean', required: false }],
  credentialFields: [{ name: 'apiKey', label: 'API-ключ', kind: 'api-key', required: true }],
  modelSource: { kind: 'builtin-and-remote', providerCatalog: true, userCustom: true, localEndpoint: false, modelCount: 46 },
  status: {
    providerId: 'openai',
    enabled: true,
    selectedAuthMethod: 'api-key',
    currentRevision: 2,
    hasCredential: true,
    credentialStatus: 'ACTIVE' as const,
    defaultModelId: 'gpt-4o',
    roleDefaults: { developer: 'gpt-4o-mini' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

const modelsProjection = {
  providerId: 'openai',
  source: 'catalog' as const,
  refreshedAt: null,
  entries: [
    { modelId: 'gpt-4o', displayName: 'GPT-4o', type: 'chat', capabilities: [], contextWindowTokens: 128000, maxOutput: null, origin: 'catalog' as const },
    { modelId: 'gpt-4o-mini', displayName: 'GPT-4o mini', type: 'chat', capabilities: [], contextWindowTokens: 128000, maxOutput: null, origin: 'catalog' as const },
  ],
};

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/settings/providers/openai']}>
      <Routes>
        <Route path="/settings/providers/:providerId" element={<ProviderDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProviderDetailPage', () => {
  beforeEach(() => {
    mockedDetail.mockResolvedValue(openaiDetail as never);
    mockedAuthStatus.mockResolvedValue({
      providerId: 'openai', methodId: 'api-key', hasCredential: true, credentialStatus: 'ACTIVE', activeFlows: [],
    } as never);
    mockedModels.mockResolvedValue(modelsProjection as never);
    mockedSaveConfig.mockResolvedValue(openaiDetail.status as never);
    mockedSaveCredential.mockResolvedValue({ providerId: 'openai', authMethodId: 'api-key', status: 'ACTIVE', hasCredential: true, createdAt: '', updatedAt: '' } as never);
    mockedDeleteCredential.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('показывает статус, разделы и модель по умолчанию', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeInTheDocument());
    expect(screen.getByText('Подключён')).toBeInTheDocument();
    expect(screen.getByText('Конфигурация')).toBeInTheDocument();
    expect(screen.getByText('Аутентификация')).toBeInTheDocument();
    expect(screen.getByText('Модели')).toBeInTheDocument();
    expect(screen.getByLabelText('Модель по умолчанию')).toHaveValue('gpt-4o');
  });

  test('секретное поле — password-ввод без начального значения (без эха)', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('API-ключ')).toBeInTheDocument());
    const input = screen.getByLabelText('API-ключ') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('не отображается');
  });

  test('сохранение credentials вызывает API без передачи повторов-значений в DOM', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText('API-ключ')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('API-ключ'), { target: { value: 'sk-test-abc' } });
    screen.getByRole('button', { name: 'Заменить' }).click();
    await waitFor(() => expect(mockedSaveCredential).toHaveBeenCalledWith('openai', 'api-key', { apiKey: 'sk-test-abc' }));
  });

  test('сохранение конфигурации и удаление credential вызывают API', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить настройки' })).toBeInTheDocument());
    screen.getByRole('button', { name: 'Сохранить настройки' }).click();
    await waitFor(() => expect(mockedSaveConfig).toHaveBeenCalled());

    screen.getByRole('button', { name: 'Удалить учётные данные' }).click();
    await waitFor(() => expect(mockedDeleteCredential).toHaveBeenCalledWith('openai', 'api-key'));
  });

  test('неизвестный провайдер показывает сообщение', async () => {
    mockedDetail.mockRejectedValue(new ApiError('not found', 404, 'PROVIDER_UNKNOWN'));
    renderDetail();
    await waitFor(() => expect(screen.getByText('Провайдер не найден.')).toBeInTheDocument());
  });
});
