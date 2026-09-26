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
  },
  breadcrumbs: {
    dashboard: 'Обзор', projects: 'Проекты', project: 'Проект', epic: 'Эпик', task: 'Задача',
    approvals: 'Согласования', execution: 'Выполнение', run: 'Запуск', usage: 'Использование',
    settings: 'Настройки', onboarding: 'Создание проекта', notFound: 'Страница не найдена',
  },
} as const;

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
