# План реализации Web UI, GitHub и выпуска v1 Orchestrator

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ НАВЫК: Используйте superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans для реализации этого плана по задачам. Для отслеживания шагов используется синтаксис флажков (`- [ ]`) для отслеживания.

**Цель:** Довести серверную часть до управляемого через Web UI продукта, добавить опциональную интеграцию с GitHub, безопасное хранение секретов, диагностику/резервное копирование/миграции и пройти два утверждённых сценария приёмки v1.

**Архитектура:** Web UI читает проекции модели чтения через HTTP и события в реальном времени через SSE; команды отправляются обычными аутентифицированными HTTP-запросами. GitHub реализует порт `GitHosting` и никогда не становится источником истины для workflow. Секреты хранятся в хранилище учётных данных ОС через адаптер.

**Технологический стек:** React 19.3; React Router 7.18; Vite 8.1 + `@vitejs/plugin-react` 6.1; TypeScript 7; Fastify; SSE; Zod; `@napi-rs/keyring`; GitHub REST/GitHub App installation auth; Vitest; Testing Library; Playwright 1.63 для UI smoke/E2E.

**Спецификация:** `docs/architecture/specs/2026-09-16-design.md`

## Глобальные ограничения

- UI не рендерит HTML репозитория/агента как доверенный HTML; Markdown должен проходить строгую санитизацию.
- Изменяющие конечные точки API требуют аутентификации локальной сессии и корректной защиты Origin/CSRF.
- Сбой GitHub никогда не блокирует локальные Development/Review/QA/Integration.
- Синхронизация GitHub в v1 = опрос + ручная команда «Синхронизировать сейчас»; веб-хуки не используются.
- Токен GitHub/private key никогда не попадает в окружение или prompt Hermes.
- Финальное merge по умолчанию по-прежнему требует ручного одобрения.
- Container Mode, multi-user/RBAC, GitLab/Jira/Linear и распределённые workers остаются вне области задачи.

---

### Задача 1: модели чтения и поверхность HTTP API

**Файлы:**
- Создать: `apps/server/src/app/read-models/dashboard-projection.ts`
- Создать: `apps/server/src/app/read-models/project-projection.ts`
- Создать: `apps/server/src/app/read-models/epic-projection.ts`
- Создать: `apps/server/src/app/read-models/task-projection.ts`
- Создать: `apps/server/src/app/read-models/execution-projection.ts`
- Создать: `apps/server/src/app/routes/projects.ts`
- Создать: `apps/server/src/app/routes/work.ts`
- Создать: `apps/server/src/app/routes/approvals.ts`
- Создать: `apps/server/src/app/routes/запускаs.ts`
- Создать: `packages/contracts/src/api.ts`
- Тест: `apps/server/test/app/api.test.ts`

**Интерфейсы:**
- Предоставляет типизированные конечные точки JSON под `/api/v1` и проекции только для чтения, которым разрешено объединять таблицы, принадлежащие модулям.

- [ ] **Шаг 1: Написать тесты контракта API**

Как минимум проверить:

```text
GET /dashboard
GET /projects/:id
GET /epics/:id
GET /tasks/:id
GET /execution
GET /approvals
POST /approvals/:id/approve
POST /tasks/:id/pause
POST /запускаs/:id/cancel
```

Изменяющие запросы без локальной сессии/CSRF-токена должны завершаться ошибкой.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- api.test.ts
```

- [ ] **Шаг 3: Реализовать проекции и тонкие контроллеры**

Контроллеры вызывают только сервисы приложения; обработчики маршрутов не выполняют прямую запись в домен. Возвращать точные причины ожидания/блокировки, активных агентов и сводки использования, необходимые утверждённому UI.

- [ ] **Шаг 4: Запустить тесты API**

```bash
pnpm --filter @ebb-orchestrator/server test -- api.test.ts
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/server/src/app packages/contracts/src/api.ts apps/server/test/app/api.test.ts
git commit -m "feat: expose orchestrator api and read models"
```

---

### Задача 2: оболочка React/Vite, маршрутизация и безопасный API-клиент

**Файлы:**
- Создать: `apps/web/package.json`
- Создать: `apps/web/vite.config.ts`
- Создать: `apps/web/src/main.tsx`
- Создать: `apps/web/src/app/App.tsx`
- Создать: `apps/web/src/app/router.tsx`
- Создать: `apps/web/src/api/client.ts`
- Создать: `apps/web/src/api/событияs.ts`
- Создать: `apps/web/src/components/AppShell.tsx`
- Создать: `apps/web/src/styles/base.css`
- Тест: `apps/web/test/app-shell.test.tsx`

**Интерфейсы:**
- Предоставляет маршруты `/`, `/projects/:id`, `/epics/:id`, `/tasks/:id`, `/approvals`, `/execution`, `/запускаs/:id`, `/usage`, `/settings`, `/projects/new`.

- [ ] **Шаг 1: Написать тест навигации оболочки**

Отрендерить приложение с замокированным API и проверить, что постоянная левая навигация содержит «Панель управления», «Проекты», «Одобрения», «Выполнение», «Использование», «Настройки».

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/web test -- app-shell.test.tsx
```

- [ ] **Шаг 3: Добавить web-пакет и реализовать оболочку приложения/аутентифицированный клиент**

`apps/web/package.json` должен включать точно такие базовые зависимости и скрипты:

```json
{
  "name": "@ebb-orchestrator/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest запуска",
    "test:watch": "vitest"
  },
  "зависимости": {
    "@ebb-orchestrator/contracts": "workspace:*",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "react-router": "^7.18.3",
    "zod": "^4.6.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "jsdom": "^30.0.1",
    "vite": "^8.1.0",
    "vitest": "^5.0.0"
  }
}
```

`apps/web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: [],
  },
});
```

Инициализировать локальную сессию через предоставляемую сервером одноимённую конечную точку; хранить токен в памяти, никогда не использовать `localStorage`. Выполнять маршрутизацию через `react-router`; переподключение SSE должно запускать повторную загрузку проекции, чтобы пропущенные эфемерные события не оставляли устаревшее состояние UI.

- [ ] **Шаг 4: Запустить тесты/сборку web**

```bash
pnpm --filter @ebb-orchestrator/web test
pnpm --filter @ebb-orchestrator/web build
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/web package.json pnpm-workspace.yaml
git commit -m "feat: add orchestrator web application shell"
```

---

### Задача 3: представления панели управления, проекта, эпика и задачи

**Файлы:**
- Создать: `apps/web/src/features/dashboard/DashboardPage.tsx`
- Создать: `apps/web/src/features/projects/ProjectPage.tsx`
- Создать: `apps/web/src/features/epics/EpicPage.tsx`
- Создать: `apps/web/src/features/tasks/TaskPage.tsx`
- Создать: `apps/web/src/components/StatusBadge.tsx`
- Создать: `apps/web/src/components/WorkflowTimeline.tsx`
- Тест: `apps/web/test/core-views.test.tsx`

**Интерфейсы:**
- Реализует утверждённую информационную архитектуру UI из Приложения A.

- [ ] **Шаг 1: Написать контентные тесты по утверждённым макетам**

Панель управления должна показывать «Запущенные агенты», «Активная работа», «Требуется одобрение», расходы на AI, активные проекты, очередь и вход в Coordinator. Представление Task должно показывать контракт, workflow, запуски агентов, найденные проблемы/дефекты, состояние Git, восстановление и использование ресурсов.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/web test -- core-views.test.tsx
```

- [ ] **Шаг 3: Реализовать представления на основе реальных проекций**

Сохранить тёмную визуальную стилистику утверждённых концепций, но отдавать приоритет семантическому HTML и адаптивной вёрстке. Не добавлять новые UX-концепции, отсутствующие в утверждённой информационной архитектуре.

- [ ] **Шаг 4: Запустить тесты и сборку production**

```bash
pnpm --filter @ebb-orchestrator/web test -- core-views.test.tsx
pnpm --filter @ebb-orchestrator/web build
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/web/src/features apps/web/src/components apps/web/test/core-views.test.tsx
git commit -m "feat: add dashboard project epic and task views"
```

---

### Задача 4: входящие одобрения, монитор выполнения и детализация запуска агента

**Файлы:**
- Создать: `apps/web/src/features/approvals/ApprovalInboxPage.tsx`
- Создать: `apps/web/src/features/execution/ExecutionPage.tsx`
- Создать: `apps/web/src/features/запускаs/AgentRunPage.tsx`
- Создать: `apps/web/src/components/SanitizedTerminal.tsx`
- Тест: `apps/web/test/operations-views.test.tsx`

**Интерфейсы:**
- Действия с одобрением: одобрить/отклонить/запросить изменения; permission ASK поддерживает режимы «один раз»/запуска/task/project там, где это разрешает политика.

- [ ] **Шаг 1: Написать тесты безопасности/рендеринга**

Текст агента `<img onerror=...>` рендерится как текст, а не как DOM-узел. ANSI/OSC terminal sequences вне allowlist удаляются. Строка очереди должна показывать точную причину ожидания.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/web test -- operations-views.test.tsx
```

- [ ] **Шаг 3: Реализовать операционные представления**

Страница Run показывает наблюдаемые действия/результаты, разрешения, использование ресурсов, манифест контекста, сигналы восстановления и артефакты; при этом скрытые рассуждения никогда не раскрываются как концепция UI.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/web test -- operations-views.test.tsx
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/web/src/features/approvals apps/web/src/features/execution apps/web/src/features/запускаs apps/web/src/components/SanitizedTerminal.tsx apps/web/test/operations-views.test.tsx
git commit -m "feat: add approvals execution and запуска monitoring"
```

---

### Задача 5: онбординг проекта, настройки и UI использования/бюджета

**Файлы:**
- Создать: `apps/web/src/features/onboarding/ProjectOnboardingPage.tsx`
- Создать: `apps/web/src/features/settings/SettingsPage.tsx`
- Создать: `apps/web/src/features/usage/UsagePage.tsx`
- Создать: `apps/server/src/app/routes/settings.ts`
- Создать: `apps/server/src/app/routes/onboarding.ts`
- Тест: `apps/web/test/configuration-views.test.tsx`

**Интерфейсы:**
- Шаги онбординга: «Репозиторий» → «Обнаружение» → «Проверка найденных проблем» → «Одобрение конфигурации» → «Активация».
- Разделы Settings соответствуют иерархии утверждённого макета.

- [ ] **Шаг 1: Написать тест онбординга DETECTED vs PROPOSED**

Обнаруженные ветки по умолчанию/менеджер пакетов должны отображаться отдельно от предложений Coordinator; кнопка активации не может продолжить работу при неразрешённом одобрении семантической конфигурации.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/web test -- configuration-views.test.tsx
```

- [ ] **Шаг 3: Реализовать формы конфигурации**

Настройки показывают действующую иерархию «Глобальные» → «Проект» → «Роль» → Task/Epic и различают поведение по наиболее строгому ограничению безопасности. Предупреждение Local Mode видно при выполнении недоверенного кода.

- [ ] **Шаг 4: Запустить тесты/сборку**

```bash
pnpm --filter @ebb-orchestrator/web test
pnpm --filter @ebb-orchestrator/web build
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/web/src/features/onboarding apps/web/src/features/settings apps/web/src/features/usage apps/server/src/app/routes/settings.ts apps/server/src/app/routes/onboarding.ts apps/web/test/configuration-views.test.tsx
git commit -m "feat: add onboarding settings and usage views"
```

---

### Задача 6: Адаптер OS SecretStore и редактирование диагностических данных

**Файлы:**
- Создать: `apps/server/src/platform/security/secret-store.ts`
- Создать: `apps/server/src/platform/security/keyring-secret-store.ts`
- Создать: `apps/server/src/platform/security/secret-redactor.ts`
- Создать: `apps/server/src/app/routes/secrets.ts`
- Тест: `apps/server/test/platform/security/secret-store.test.ts`
- Тест: `apps/server/test/platform/security/redaction.test.ts`

**Интерфейсы:**
- Предоставляет: `SecretStore.store/resolveForService/revoke/listMetadata`.
- Production-адаптер использует `@napi-rs/keyring`; тесты используют адаптер в памяти.

- [ ] **Шаг 1: Написать тесты отсутствия открытого текста**

Сохранить уникальный секрет и проверить, что он не появляется в дампе SQLite, логах, метаданных артефактов, JSON диагностики или окружении AgentRun.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- secret-store.test.ts redaction.test.ts
```

- [ ] **Шаг 3: Реализовать адаптер keyring и редактор точных значений**

SQLite сохраняет только метаданные секрета/идентификаторы ссылок. Получение секрета требует именованного назначения сервиса. Ни один конечная точка API не возвращает открытый текст секрета после сохранения.

- [ ] **Шаг 4: Запустить тесты в Windows и на одном Unix CI запускаner**

```bash
pnpm test
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/server/src/platform/security apps/server/src/app/routes/secrets.ts apps/server/test/platform/security package.json pnpm-lock.yaml
git commit -m "feat: store credentials in os keyring"
```

---

### Задача 7: Порт GitHosting и адаптер установки GitHub App

**Файлы:**
- Создать: `apps/server/src/modules/github/git-hosting.ts`
- Создать: `apps/server/src/modules/github/github-app-token-провайдера.ts`
- Создать: `apps/server/src/modules/github/github-adapter.ts`
- Создать: `apps/server/src/modules/github/github-sync-service.ts`
- Создать: `apps/server/src/platform/database/migrations/013_github.sql`
- Тест: `apps/server/test/modules/github/github-adapter.test.ts`

**Интерфейсы:**
- Предоставляет методы `GitHosting` для импорта Issue, координации push, создания/обновления PR, слияния PR и безопасной публикации комментариев/review с учётом будущих изменений.
- Аутентификация использует app ID/private key/installation ID GitHub App из SecretStore; токены installation краткоживущие и кэшируются только в памяти до истечения срока действия.

- [ ] **Шаг 1: Написать HTTP-тесты с fake-GitHub**

Проверить, что истёкший installation token вызывает обновление; 401 -> `BLOCKED_AUTH`, 403 -> `BLOCKED_PERMISSION`, ограничение частоты запросов -> повтор после сброса, тайм-аута -> временный повтор. Длина/префикс токена никогда не предполагаются.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-adapter.test.ts
```

- [ ] **Шаг 3: Реализовать REST-адаптер и поставщик токенов**

Генерировать GitHub App JWT только внутри поставщика токенов, обменивать его на installation токен доступа и запрашивать разрешения с областью репозитория. Хранить private key в SecretStore. Hermes не получает ни одного из этих значений.

- [ ] **Шаг 4: Запустить тесты адаптера**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-adapter.test.ts
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/server/src/modules/github apps/server/src/platform/database/migrations/013_github.sql apps/server/test/modules/github
git commit -m "feat: add optional github app adapter"
```

---

### Задача 8: синхронизация опросом, ручная команда «Синхронизировать сейчас» и автономная очередь

**Файлы:**
- Создать: `apps/server/src/modules/github/github-sync-worker.ts`
- Создать: `apps/server/src/app/routes/github.ts`
- Тест: `apps/server/test/modules/github/github-sync-worker.test.ts`

**Интерфейсы:**
- Создаёт `SYNC_PENDING`, входящие `HumanFeedback`, исходящие маркеры дедупликации и конечную точку ручной синхронизации.

- [ ] **Шаг 1: Написать тест автономности/idempotency**

Смоделировать успешное создание PR с последующим падением процесса до подтверждения задания. После перезапуска worker запрашивает внешнее состояние и помечает существующий PR как успешный, вместо создания ещё одного.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-sync-worker.test.ts
```

- [ ] **Шаг 3: Реализовать опрос worker**

Исходящие объекты содержат маркер Orchestrator для предотвращения циклов обратной связи. Закрытие GitHub Issue никогда напрямую не помечает Task как DONE; при наличии смысловой связи оно создаёт входные данные для reconciliation/HumanFeedback.

- [ ] **Шаг 4: Запустить тесты**

```bash
pnpm --filter @ebb-orchestrator/server test -- github-sync-worker.test.ts
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/server/src/modules/github apps/server/src/app/routes/github.ts apps/server/test/modules/github
git commit -m "feat: add resilient github polling sync"
```

---

### Задача 9: Резервное копирование, совместимость миграций и экспорт диагностики

**Файлы:**
- Создать: `apps/server/src/platform/database/backup-service.ts`
- Создать: `apps/server/src/platform/database/config-migrator.ts`
- Создать: `apps/server/src/platform/diagnostics/diagnostics-service.ts`
- Создать: `apps/server/src/app/routes/diagnostics.ts`
- Тест: `apps/server/test/platform/database/backup.test.ts`
- Тест: `apps/server/test/platform/diagnostics/diagnostics.test.ts`

**Интерфейсы:**
- Создаёт резервную копию перед обновлением схемы DB, диапазон совместимости конфигурации проекта и санитизированный архив диагностики.

- [ ] **Шаг 1: Написать тесты миграций/резервного копирования**

Открыть старую fixture DB/config, создать резервную копию, выполнить миграцию до последней версии и запустить проверки целостности/внешних ключей. Конфигурация новее поддерживаемой должна безопасно отклоняться; неоднозначная семантическая миграция конфигурации возвращает `USER_DECISION_REQUIRED`.

- [ ] **Шаг 2: Проверить падение**

```bash
pnpm --filter @ebb-orchestrator/server test -- backup.test.ts diagnostics.test.ts
```

- [ ] **Шаг 3: Реализовать резервное копирование/диагностику**

Диагностика включает версии приложения/схемы, историю миграций, состояние worker, ожидающие записи outbox/dead-letter, устаревшие блокировки и санитизированные недавние ошибки; значения секретов и необработанное чувствительное окружение исключаются.

- [ ] **Шаг 4: Запустить матрицу миграций**

```bash
pnpm test
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/server/src/platform/database apps/server/src/platform/diagnostics apps/server/src/app/routes/diagnostics.ts apps/server/test/platform
git commit -m "feat: add backup migration and diagnostics tooling"
```

---

### Задача 10: Финальная приёмка v1 и матрица падений/безопасности

**Файлы:**
- Создать: `apps/server/test/e2e/v1-autonomous-task.test.ts`
- Создать: `apps/server/test/e2e/v1-epic.test.ts`
- Создать: `apps/server/test/e2e/v1-crash-matrix.test.ts`
- Создать: `apps/server/test/e2e/v1-security.test.ts`
- Создать: `apps/web/test/e2e/v1-ui.spec.ts`
- Создать: `apps/web/playwright.config.ts`
- Изменить: `apps/web/package.json`
- Изменить: выбранные для репозитория файлы CI workflow.

**Интерфейсы:**
- Нового API продукта нет; это критерий выпуска v1.

- [ ] **Шаг 1: Добавить связку тестов выпуска Playwright и реализовать приёмочный тест Autonomous Task**

Добавить в `apps/web/package.json`:

```json
{
  "scripts": {
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0"
  }
}
```

`apps/web/playwright.config.ts` должен запускать локальное серверное и web-приложение через `webServer`, использовать Chromium для обязательного пути CI smoke и оставить повторы равными `0` локально, чтобы нестабильные тесты были видны.

Запрос/задача: `Add /health endpoint returning {status:'ok'}`. Проверить управляемый worktree, реальные Dev/Review/QA/Integration, ручное одобрение merge, результат `master`, очистку, аудит и использование ресурсов. UI E2E должен создать/выбрать проект fixture, открыть Task, наблюдать стадии workflow, одобрить финальный merge и проверить получившееся состояние DONE.

- [ ] **Шаг 2: Реализовать приёмочный тест Epic**

Запрос: функция, подобная провайдеру, с поддержкой обычного режима и потоковой передачи. Проверить одобрение плана Coordinator, параллельные Tasks с учётом зависимостей, интеграцию Tasks в ветку Epic, Review/QA/финальную интеграцию Epic и ручное слияние.

- [ ] **Шаг 3: Добавить матрицу падений по точке отказа**

Принудительно вызвать падения после создания ветки, фиксации в DB, отправки события до ack, резервирования бюджета, запуска запуска и создания GitHub PR. После перезапуска проверить отсутствие потери закоммиченного кода, дублирующего merge/PR, устаревшей блокировки или вечно выполняющегося Run со статусом RUNNING.

- [ ] **Шаг 4: Запустить контроль выпуска**

Детерминированный CI:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @ebb-orchestrator/web build
pnpm --filter @ebb-orchestrator/web test:e2e
```

Опциональная реальная приёмка Hermes:

```bash
RUN_HERMES_E2E=1 pnpm --filter @ebb-orchestrator/server test -- v1-autonomous-task.test.ts v1-epic.test.ts
```

- [ ] **Шаг 5: Зафиксировать изменения**

```bash
git add apps/server/test/e2e apps/web/test/e2e apps/web/playwright.config.ts apps/web/package.json .github
git commit -m "test: add orchestrator v1 release acceptance suite"
```

## План 6 / критерии выпуска v1

v1 готов к выпуску только если:

- Web UI поддерживает все утверждённые экраны верхнего уровня без зависимости от CLI;
- приёмочные тесты автономной Task и Epic проходят;
- восстановление после kill/restart проходит матрицу точке отказа;
- GitHub можно полностью отключить, и все локальные workflow по-прежнему проходят;
- credentials остаются в OS keyring и никогда не появляются в контексте/логах Hermes;
- финальное слияние в настроенную ветку по умолчанию требует явного одобрения пользователя;
- детерминированный CI не использует AI-токены;
- реальные тесты Hermes являются необязательным контрольным этапом выпуска/оценки, а не обычным обычным модульным CI.
