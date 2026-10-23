/** Русские подписи интерфейса и безопасные сообщения ошибок API. */
export const ru = {
  errors: {
    AUTH_INVALID_REQUEST: 'Некорректный запрос на вход.',
    AUTH_SESSION_REQUIRED: 'Войдите, чтобы продолжить.',
    AUTH_SESSION_INVALID: 'Сессия завершена. Войдите снова.',
    AUTH_INVALID_CREDENTIALS: 'Неверный пароль.',
    AUTH_ORIGIN_INVALID: 'Источник запроса на вход не подтверждён.',
    AUTH_UNAVAILABLE: 'Сервис входа временно недоступен.',
    AUTH_CSRF_INVALID: 'Проверка безопасности не пройдена. Повторите действие.',
    AUTH_FORBIDDEN: 'Доступ запрещён.',
    ONBOARDING_INVALID_REPOSITORY: 'Указанный репозиторий не подходит для создания проекта.',
    ONBOARDING_DISCOVERY_FAILED: 'Не удалось изучить репозиторий.',
    ONBOARDING_NOT_FOUND: 'Черновик проекта не найден.',
    ONBOARDING_INVALID_PROPOSAL: 'Предложение по проекту некорректно.',
    ONBOARDING_APPROVAL_PENDING: 'Ожидается согласование проекта.',
    ONBOARDING_NOT_PENDING: 'Проект не ожидает согласования.',
    ONBOARDING_NOT_APPROVED: 'Проект ещё не согласован.',
    ONBOARDING_UNAVAILABLE: 'Создание проекта временно недоступно.',
    PROVIDER_UNKNOWN: 'Провайдер не найден.',
    AUTH_METHOD_UNKNOWN: 'Метод аутентификации неизвестен.',
    PROVIDER_CONFIG_INVALID: 'Конфигурация провайдера некорректна.',
    PROVIDER_CONFIG_MISSING: 'Конфигурация провайдера не найдена.',
    PROVIDER_CREDENTIAL_STORE_UNAVAILABLE: 'Хранилище учётных данных временно недоступно.',
    PROVIDER_CREDENTIAL_INVALID: 'Данные учётной записи некорректны.',
    PROVIDER_MODEL_INVALID: 'Модель некорректна.',
    PROVIDER_MODELS_API_UNAVAILABLE: 'Провайдер не поддерживает загрузку списка моделей из API.',
    PROVIDER_MODELS_ENDPOINT_MISSING: 'Endpoint для загрузки списка моделей не настроен.',
    PROVIDER_MODELS_AUTH_REQUIRED: 'Для загрузки списка моделей требуется аутентификация.',
    PROVIDER_MODELS_HTTP_STATUS: 'Сервис провайдера вернул ошибку.',
    PROVIDER_MODELS_PARSE_FAILED: 'Не удалось разобрать список моделей провайдера.',
    PROVIDER_MODELS_TIMEOUT: 'Истекло время ожидания ответа провайдера.',
    PROVIDER_MODELS_FORBIDDEN_DESTINATION: 'Назначение endpoint запрещено политикой сети.',
    PROVIDER_MODELS_DNS_FAILED: 'Не удалось разрешить адрес endpoint.',
    PROVIDER_MODELS_TRANSPORT: 'Ошибка соединения с провайдером.',
    PROVIDER_MODELS_UNAVAILABLE: 'Список моделей временно недоступен.',
    PROVIDER_UNAVAILABLE: 'Сервис провайдеров временно недоступен.',
    PROVIDER_TEST_CONNECTION_UNAVAILABLE: 'Проверка соединения временно недоступна.',
    PROVIDER_AUTH_UNAVAILABLE: 'Авторизация провайдера временно недоступна.',
    PROVIDER_AUTH_INVALID_REQUEST: 'Некорректный запрос авторизации.',
    PROVIDER_AUTH_FLOW_NOT_FOUND: 'Поток авторизации не найден.',
    PROVIDER_AUTH_DISCONNECT_MISSING_CONFIG: 'Конфигурация провайдера не найдена.',
    PROVIDER_AUTH_METHOD_NOT_INTERACTIVE: 'Метод не поддерживает интерактивную авторизацию.',
    default: 'Не удалось выполнить запрос.',
  },
  common: {
    loading: 'Загрузка…', retry: 'Повторить', back: 'Назад', unavailable: 'Недоступно',
    dashboard: 'Обзор', projects: 'Проекты', approvals: 'Согласования',
    execution: 'Выполнение', usage: 'Использование', settings: 'Настройки',
    breadcrumb: 'Навигационная цепочка', primaryNavigation: 'Основная навигация',
    projectsBrand: 'Ebb Orchestrator', localFirst: 'Локальная система управления',
    notFound: 'Страница не найдена', requestedRouteMissing: 'Запрошенный маршрут отсутствует в этой системе управления.',
    backToDashboard: 'Вернуться к обзору', routeError: 'Ошибка маршрута',
    unableToRender: 'Не удалось безопасно отобразить эту страницу.',
    online: 'В сети', offline: 'Не в сети',
    notifications: 'Уведомления', timeline: 'Хронология рабочего процесса',
    terminalOutput: 'Вывод терминала',
  },
  tasks: {
    relatedWorkUnavailable: 'Связанная работа недоступна.',
    dependenciesEventsUnavailable: 'Зависимости и события недоступны.',
  },
  epics: {
    branchApprovalsUnavailable: 'Ветка и согласования эпика недоступны.',
  },
  runs: {
    notFound: 'не найден.',
    inputTokens: 'Входные токены',
    cachedTokens: 'Кэшированные токены',
    outputTokens: 'Выходные токены',
    contextManifest: {
      loading: 'Загрузка сохранённого манифеста…',
      requestFailed: 'Не удалось загрузить сохранённый манифест.',
      available: 'Сохранённая provenance доступна.',
      unavailable: 'Сохранённая provenance недоступна.',
      unknown: 'Неизвестный статус манифеста.',
      emptyItems: 'Выбранных элементов контекста нет.',
      tokenCount: 'Точный размер контекста',
      tokenCountUnknown: 'Не измерен',
      manifestId: 'ID манифеста',
      runId: 'ID запуска',
      subject: 'Привязка',
      role: 'Роль',
      contractRequestDigest: 'Digest контракта или запроса',
      contextBuilderVersion: 'Версия сборщика контекста',
      promptHash: 'Hash точного prompt',
      contextHash: 'Hash контекста',
      items: 'Выбранные элементы',
      itemVersion: 'версия',
      itemDigest: 'digest',
      valueUnavailable: 'Не указано',
      reason: 'Причина',
      bindingUnknown: 'Привязка недоступна',
      subjects: { TASK: 'Задача', EPIC: 'Эпик', REQUEST: 'Запрос' },
      reasons: {
        LEGACY_PROVENANCE_UNAVAILABLE: 'Для этой исторической записи provenance не сохранялась.',
        INVALID_PERSISTED_PROVENANCE: 'Сохранённые данные provenance повреждены или не совпадают с запуском.',
      },
    },
  },
  breadcrumbs: {
    dashboard: 'Обзор', projects: 'Проекты', project: 'Проект', epic: 'Эпик', task: 'Задача',
    approvals: 'Согласования', execution: 'Выполнение', run: 'Запуск', usage: 'Использование',
    settings: 'Настройки', providers: 'Провайдеры', onboarding: 'Создание проекта', notFound: 'Страница не найдена',
  },
  providers: {
    pageTitle: 'ИИ-провайдеры',
    catalogIntro: 'Каталог из 86 провайдеров. Выберите провайдера, чтобы настроить подключение и модели.',
    searchPlaceholder: 'Поиск по названию или ID…',
    categories: {
      all: 'Все категории', chat: 'Чат', image: 'Изображения', video: 'Видео',
      embedding: 'Эмбеддинги', platform: 'Платформа', gateway: 'Шлюз', local: 'Локальные',
    },
    capabilities: {
      chat: 'Чат', streaming: 'Стриминг', toolCalling: 'Инструменты', structuredOutput: 'Структурный вывод',
      vision: 'Зрение', audio: 'Аудио', imageGeneration: 'Генерация изображений',
      videoGeneration: 'Генерация видео', embeddings: 'Эмбеддинги', reranking: 'Реранкинг',
    },
    empty: 'По запросу ничего не найдено.',
    notConfigured: 'Не настроен',
    disabled: 'Отключён',
    connected: 'Подключён',
    pending: 'Ожидает подтверждения',
    expired: 'Срок подтверждения истёк',
    disconnected: 'Отключён',
    error: 'Ошибка',
    unavailable: 'Недоступно',
    loaded: 'Загружено',
    authMethods: {
      'api-key': 'API-ключ',
      'credential-fields': 'Учётные данные облака',
      'subscription-token': 'Токен подписки',
      'oauth-device-code': 'OAuth (устройство)',
      'oauth-pkce': 'OAuth (PKCE)',
      'cloud-identity': 'Облачная идентичность',
      'local-endpoint': 'Локальный endpoint',
    },
    authMethodHints: {
      'api-key': 'Будет заменён при сохранении. Значения не сохраняются в интерфейсе.',
      'credential-fields': 'Значения заменяют текущие учётные данные при сохранении.',
      'subscription-token': 'Будет заменён при сохранении. Значения не сохраняются в интерфейсе.',
      'oauth-device-code': 'Откройте ссылку, введите код и подтвердите доступ на устройстве.',
      'oauth-pkce': 'Откройте ссылку и подтвердите доступ.',
      'cloud-identity': 'Используется идентичность окружения; ввод ключей не требуется.',
      'local-endpoint': 'Укажите локальный endpoint ниже.',
    },
    secretFieldPlaceholder: 'не отображается',
    saveConfig: 'Сохранить настройки',
    saveCredential: 'Сохранить учётные данные',
    replaceCredential: 'Заменить',
    removeCredential: 'Удалить учётные данные',
    credentialSaved: 'Учётные данные сохранены',
    credentialRemoved: 'Учётные данные удалены',
    configSaved: 'Настройки сохранены',
    startAuth: 'Начать авторизацию',
    cancelAuth: 'Отменить',
    testConnection: 'Проверить соединение',
    testConnectionRunning: 'Проверка…',
    connectionOk: 'Соединение установлено',
    connectionFailed: 'Соединение не установлено',
    disconnect: 'Отключить провайдера',
    disconnectConfirm: 'Отключить провайдера? Это удалит локальные учётные данные.',
    configSection: 'Конфигурация',
    authSection: 'Аутентификация',
    modelsSection: 'Модели',
    defaultModel: 'Модель по умолчанию',
    noDefaultModel: 'Не выбрана',
    roleDefaults: 'Дефолты по ролям',
    rolePlaceholder: 'Роль (например, developer)',
    addRole: 'Добавить роль',
    modelSearch: 'Поиск моделей…',
    allModels: 'Все модели',
    customModels: 'Пользовательские модели',
    addCustomModel: 'Добавить модель',
    customModelIdPlaceholder: 'ID модели (например, my-model)',
    refreshModels: 'Загрузить из API',
    refreshModelsRunning: 'Загрузка…',
    modelsRefreshed: 'Список моделей обновлён',
    modelsRefreshFailed: 'Не удалось обновить список моделей',
    modelOriginCatalog: 'Каталог',
    modelOriginCustom: 'Пользовательская',
    modelOriginApi: 'Из API',
    contextWindow: 'Контекст',
    maxOutput: 'Максимум вывода',
    statusNote: 'Ключи и токены хранятся только в защищённом хранилище и не отображаются.',
    backToCatalog: 'К списку провайдеров',
    unknownProvider: 'Провайдер не найден.',
    localEndpointWarning: 'Локальный endpoint выполняется на этой машине. Убедитесь, что вы доверяете этому сервису.',
  },
} as const;

/** Возвращает локализованную подпись недоступной provenance-записи Run. */
export function runContextManifestUnavailableLabel(): string {
  return ru.runs.contextManifest.unavailable;
}

const statusLabels: Record<string, string> = {
  DRAFT: 'Черновик', READY: 'Готово', ACTIVE: 'Активно', IN_PROGRESS: 'Выполняется',
  DEV: 'Разработка', DEVELOPMENT: 'Разработка', REVIEW: 'Проверка', QA: 'Контроль качества',
  READY_FOR_INTEGRATION: 'Готово к интеграции', INTEGRATION: 'Интеграция',
  INTEGRATED_INTO_EPIC: 'Интегрировано в эпик', READY_FOR_MERGE: 'Готово к слиянию',
  MERGE: 'Слияние', MERGING: 'Выполняется слияние', DONE: 'Завершено', RELEASED: 'Выпущено',
  WAITING_FOR_DEPENDENCY: 'Ожидает зависимости', WAITING_FOR_APPROVAL: 'Ожидает согласования',
  AWAITING_APPROVAL: 'Ожидает согласования', APPROVAL_PENDING: 'Ожидает согласования',
  BLOCKED: 'Заблокировано', PAUSED: 'Приостановлено', FAILED: 'Ошибка', CANCELLED: 'Отменено',
  PENDING: 'Ожидает', CURRENT: 'Текущий этап', COMPLETED: 'Завершено', APPROVED: 'Согласовано',
  STARTED: 'Запущено', COMPLETING: 'Завершается', WAITING: 'Ожидает',
  REJECTED: 'Отклонено', CHANGES_REQUESTED: 'Запрошены изменения',
  ONCE: 'Однократно', RUN: 'Запуск', TASK: 'Задача', EPIC: 'Эпик', PROJECT: 'Проект',
  RESOLVED: 'Устранено',
};

const epicStageLabels: Record<string, string> = {
  EPIC_REVIEW: 'Проверка эпика', ARCHITECTURE_REVIEW: 'Архитектурная проверка',
  EPIC_QA: 'Контроль качества эпика', INTEGRATION: 'Слияние',
};

const waitReasonLabels: Record<string, string> = {
  WAITING_FOR_CAPACITY: 'Ожидается доступная мощность планировщика.',
  WAITING_FOR_PAUSE: 'Ожидается возобновление задачи.',
  WAITING_FOR_ROLE_CAPACITY: 'Ожидается доступная мощность для роли.',
  WAITING_FOR_RESOURCE_LOCK: 'Ожидается освобождение ресурса.',
  WAITING_FOR_BUDGET: 'Ожидается бюджет проекта.',
  WAITING_FOR_DEPENDENCY: 'Ожидается выполнение зависимости.',
  WAITING_FOR_APPROVAL: 'Ожидается согласование.',
  APPROVAL: 'Ожидается согласование.',
  DEPENDENCY: 'Ожидается выполнение зависимости.',
  BLOCKED_BY_WORKFLOW: 'Заблокировано рабочим процессом.',
  BLOCKED_BY_PROJECT_STATE: 'Заблокировано состоянием проекта.',
  PROJECT_NOT_ACTIVE: 'Проект не активен.',
  ONBOARDING_NOT_ACTIVE: 'Онбординг проекта не активирован.',
  BLOCKED: 'Заблокировано рабочим процессом или политикой.',
  PAUSED: 'Приостановлено пользователем.',
};

/** Переводит код причины ожидания для UI; текст API не считается безопасной подписью. */
export function waitReasonLabel(code: string | null | undefined): string {
  return code && Object.hasOwn(waitReasonLabels, code) ? waitReasonLabels[code]! : 'Причина ожидания недоступна.';
}

/** Переводит идентификатор состояния только для отображения, не изменяя протокол. */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Неизвестно';
  return statusLabels[status.toUpperCase()] ?? 'Неизвестный статус';
}

/** Переводит идентификатор этапа эпика, не доверяя текстовой подписи API. */
export function epicStageLabel(id: string | null | undefined): string {
  if (!id) return 'Этап жизненного цикла не указан';
  return epicStageLabels[id] ?? statusLabels[id] ?? 'Неизвестный этап эпика';
}

/** Преобразует известный стабильный код API в безопасное русское сообщение. */
export function apiErrorMessage(code: string | undefined): string {
  if (!code) return ru.errors.default;
  return Object.hasOwn(ru.errors, code) ? ru.errors[code as keyof typeof ru.errors] : ru.errors.default;
}

/** Отображает только известные коды проекций; неизвестный текст сервера не выводится. */
function safeLabel(value: string | null | undefined, labels: Record<string, string>, fallback: string): string {
  return value != null && Object.hasOwn(labels, value) ? labels[value]! : fallback;
}

export const approvalTypeLabel = (value: string) => safeLabel(value, {
  FINAL_MERGE: 'Финальное слияние', SCOPE_CHANGE: 'Изменение объёма работ',
  ARCHITECTURE_CHANGE: 'Изменение архитектуры', ROLE_CHANGE: 'Изменение роли',
  WORKFLOW_CHANGE: 'Изменение рабочего процесса',
}, 'Неизвестный тип согласования');
export const approvalSubjectLabel = (value: string) => safeLabel(value, {
  TASK: 'Задача', EPIC: 'Эпик', PROJECT: 'Проект', RUN: 'Запуск',
}, 'Объект');
export const githubStatusLabel = (value: string | null | undefined) => safeLabel(value, {
  CONNECTED: 'GitHub подключён', DISCONNECTED: 'GitHub не подключён', ERROR: 'Ошибка подключения GitHub',
}, 'Статус GitHub недоступен');
export const runTriggerLabel = (value: string | null | undefined) => safeLabel(value, {
  DEVELOPMENT: 'Разработка', REVIEW: 'Проверка', QA: 'Контроль качества',
  'runtime-request': 'Запрос на запуск', 'epic-child': 'Задача эпика',
  'epic-EPIC_REVIEW': 'Проверка эпика', 'epic-ARCHITECTURE_REVIEW': 'Архитектурная проверка',
  'epic-EPIC_QA': 'Контроль качества эпика', 'epic-INTEGRATION': 'Интеграция эпика',
}, value == null ? 'Не указано' : 'Причина запуска недоступна.');
export const runEventLabel = (value: string) => safeLabel(value, {
  run_started: 'Запуск начат', run_completed: 'Запуск завершён', run_failed: 'Ошибка запуска',
  tool_used: 'Инструмент использован',
}, 'Неизвестное событие');
export const auditActionLabel = (value: string) => safeLabel(value, {
  read_code: 'Чтение кода', write_comment: 'Запись комментария',
  RUN_CANCELLED: 'Запуск отменён', APPROVAL_APPROVED: 'Согласование принято', TASK_PAUSED: 'Задача приостановлена',
}, 'Неизвестное действие');
export const recoveryRoleLabel = (value: string) => safeLabel(value, {
  middle: 'Средний уровень', senior: 'Старший уровень',
}, 'Уровень роли недоступен');
export const recoveryFailureLabel = (value: string) => safeLabel(value, {
  TASK_FAILURE: 'Ошибка задачи', TOOL_ERROR: 'Ошибка инструмента', INTEGRATION_FAILURE: 'Ошибка интеграции',
  REVIEW_FINDING: 'Замечание проверки', QA_FINDING: 'Замечание контроля качества', NO_PROGRESS: 'Нет прогресса',
}, 'Тип ошибки недоступен');
/** Причина восстановления — произвольный текст, а не контролируемый код. */
export const recoveryReasonLabel = () => 'Причина восстановления недоступна.';
