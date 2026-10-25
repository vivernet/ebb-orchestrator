---
id: guideline-03
status: in_progress
kind: development
title: Разработка Ebb Orchestrator через Hermes
created: 2026-09-23
updated: 2026-10-24
---

# Разработка Ebb Orchestrator через Hermes

Этот документ описывает Hermes как внешний исполнитель разработки: координацию
планов, делегирование задач, независимый review и финальную проверку. Контракт
production `AgentRuntime` / `HermesRuntimeAdapter` задаётся архитектурной specification.

## Prerequisites

- Выполняйте repository-команды из корня выбранного Git worktree.
- Нужны Node.js и pnpm из требований корневого README, Git и доступный в `PATH`
  Hermes Agent с командами config и project trust.
- Установка Hermes и проверочный запрос описаны в
  [первом запуске в README](../../README.md#первый-запуск-hermes); выбор
  провайдера/модели для Runs выполняет Ebb (см. «Production provider и runtime»).
- В worktree должны присутствовать `.hermes.md` и canonical source `.agents/skills/`.
|- Полный актуальный набор из 23 Ebb skills находится в
  [единственном README inventory](../../README.md#hermes-development-skills).

## Первоначальная настройка

### Project trust и prerequisites

Сначала установите Hermes и проверьте его работу по шагам из README. Это
отдельно от project trust Ebb: команды ниже изменяют настройки текущего
пользовательского Hermes home/profile, но не добавляют и не аутентифицируют
provider (ключи/токены провайдеров хранятся в OS SecretStore/keyring и
управляются через Web Settings Ebb).

```bash
pnpm hermes:check
```

Если check сообщает, что repository trust, project discovery или delegation
не настроены, выполните setup и затем повторите check:

```bash
pnpm hermes:setup
pnpm hermes:check
```

Владельцы команд в корневом `package.json`: `hermes:setup` запускает
`node scripts/hermes-dev.mjs setup`, `hermes:check` — `node scripts/hermes-dev.mjs check`.

`hermes:setup` сначала запускает документационные inventory/check, определяет
Git root, проверяет поддержку `hermes skills trust`, добавляет выбранный repository
в trusted projects и включает `skills.project_discovery`. Затем выставляет
`delegation.max_concurrent_children=2`, `delegation.max_spawn_depth=1` и
`delegation.orchestrator_enabled=false`. Команда изменяет настройки выбранного
Hermes home и завершает успешную настройку маркером
`HERMES_CONFIG marker=SETUP_CONFIGURED trusted=true redacted=true`.

`hermes:check` проверяет `hermes --version`, `.hermes.md`, точный canonical
inventory с `SKILL.md` у всех 21 owners, trusted repository через
`skills.trusted_project_dirs`, `skills.project_discovery=true` и три значения
delegation выше. Успех — exit `0` и `All checks passed.`; ошибка — exit `1` и
`HERMES_CONFIG marker=CHECK_FAILED exit_code=1 redacted=true`.

Skills обнаруживаются непосредственно в `.agents/skills/`. Setup/check не копируют
profile assets, не синхронизируют capability registry и не перезаписывают
profile-local skills. Проверка подтверждает конфигурацию и inventory, но фактический
runtime skill index/provenance требует отдельной runtime acceptance проверки.
Эти команды также не проверяют вход в AI-провайдер и не отправляют provider/API
запрос. `pnpm hermes:check` не является provider acceptance.

### Production provider и runtime

Выбор провайдера/модели для Runs принадлежит Ebb: Ebb хранит каталог из 86
провайдеров (закреплённый источник LobeHub) с моделями; список и текущий выбор
отображаются в Settings Web UI, где же настраиваются auth-методы и credentials
(API-ключи, subscription-токены, device-code/OAuth PKCE, refresh/disconnect).
Значения credentials хранятся только в OS SecretStore (keyring, service
`ai-provider`) и не попадают в корневой `.env`, `EBB_ORCHESTRATOR_HOME/.env`,
SQLite, логи или артефакты. При запуске Run Ebb выбирает провайдера/модель из
своего каталога и не мутирует пользовательский профиль Hermes:
пользовательские Hermes home/profile/config/auth не читаются, не копируются и
не меняются; отдельный per-Run Hermes profile не создаётся. Никогда не
пересылайте credential values в чат.

Реальный Windows provider acceptance через production Run path пройден
2026-10-11: один Run получил ответ настроенного provider и валидированный
`submit_result`; acceptance также подтвердила live `session_id` capture и его
сохранение с последующим чтением из SQLite после запуска свежего процесса
Orchestrator. Отдельный Windows same-Run/session restart acceptance пройден
1/1 на checkpoint 2026-10-11. Это не закрывает Linux и macOS Apple Silicon
platform/recovery gates, полный Task7 или Plan20. Статусы и подробные evidence
ведутся в [Plan20](../architecture/plans/20-production-context-manifest.md).

`pnpm hermes:check` проверяет CLI и Ebb project prerequisites, но не вызывает
provider API. `pnpm hermes:setup` при необходимости настраивает project
trust/discovery/delegation в активном Hermes home/profile и изменяет эти
настройки; отдельная копия профиля не требуется. Корневой `.env` задаёт только
настройки приложения, например `EBB_ORCHESTRATOR_HOME` и `PORT`; ключи
провайдеров не хранятся в `.env` — только в OS SecretStore через Web Settings.

### Первый production Run и troubleshooting

Пошаговый clean-checkout flow — установка/проверка CLI Hermes, запуск Ebb,
активация локального проекта и безопасная проверка Coordinator Run — приведён в
[README, «Первый запуск Hermes»](../../README.md#первый-запуск-hermes). Команды
`hermes setup` / `hermes model` для Ebb не используются; Ebb выбирает
провайдера/модель из своего реестра.
Для проверки runtime достаточно отправить ограниченный planning request и
убедиться, что появился сохранённый план `PLAN_PENDING_APPROVAL`; не одобряйте
Epic, если не собираетесь запускать его реализацию. Hermes/Ebb provider-запросы
могут расходовать лимит или стоимость провайдера. `pnpm hermes:check` не заменяет
этот реальный Run и не является проверкой provider/auth.
Planning roles получают только `workspace.read`, `workspace.search`,
`git.status`, `git.diff` и `submit_result`; они не получают file-write или
command-execution capabilities. Сам запрос, Runs и preview сохраняются в локальной
базе Orchestrator.

При проблеме сначала используйте сигнал соответствующего слоя:

- Нет CLI или Ebb не находит его: `hermes --version`, затем `pnpm hermes:check`
  из корня и проверьте `PATH` процесса backend. После изменения `PATH` перезапустите
  backend. Не создавайте отдельный Hermes profile для Ebb.
- Hermes сообщает об отсутствующем/неоднозначном provider или model: проверьте
  выбор провайдера/модели в настройках Ebb (Settings → «ИИ-провайдеры и
  модели», каталог из 86 провайдеров) и наличие активного credential для
  выбранного auth-метода в OS SecretStore (задаётся через Web). Ebb передаёт
  явный выбор провайдера; `model=default` использует дефолт реестра Ebb.
- Auth/refresh failure: проверьте credential провайдера в Web Settings — он
  хранится только в OS SecretStore (keyring), не в корневом `.env`,
  `EBB_ORCHESTRATOR_HOME/.env`, SecretStore-проекции, SQLite или репозитории.
  Не отправляйте credential values в чат; пользовательский Hermes auth/config не
  читается и не меняется.
- `HERMES_LAUNCHER_NOT_FOUND`, `HERMES_PATH_IDENTITY_INVALID` или
  `HERMES_EBB_MCP_REGISTRATION_FAILED`: это ошибка обнаружения/подготовки/запуска;
  сохраняйте точный код и Run ID, не диагностируйте её проверкой ACL или владельцев
  пользовательских каталогов.
- `PROCESS_SCOPE_STOP_UNPROVEN` или `RUN_PROCESS_SCOPE_STOP_UNPROVEN`: полная
  остановка процесса пока не доказана; не запускайте повторный Run и не завершайте
  процесс вручную. Дождитесь reconciliation и сохраните Run ID с кодом ошибки.
- `HERMES_SESSION_STREAM_INVALID` или `HERMES_SESSION_CAPTURE_*`: session ID не
  был валидно связан с живым Run и сохранён. Не подменяйте его результатом
  `hermes sessions list` и не пытайтесь resume; дождитесь terminal/recovery статуса.

Ebb сохраняет fail-closed поведение при ошибке запуска, остановки или session
capture. Устранение проблемы не требует проверки/изменения permissions Hermes
home или копирования provider/auth.

## Запуск implementation plan

```bash
pnpm hermes:execute -- docs/architecture/plans/<file>.md
```

## Интерактивный запуск

```bash
hermes --in "<worktree>" --tui
```

## Ограничение субагентов

Максимум 2 параллельных субагента, глубина делегирования 1, без вложенного делегирования.

## Worktrees

Человек/координатор выбирает worktree. Hermes не создаёт изолированные child worktrees автоматически.

## Обновление skills

```bash
# Edit .agents/skills
pnpm hermes:setup
pnpm hermes:check
```

`pnpm hermes:setup` настраивает Hermes project trust и prerequisites; skills
не устанавливаются и не копируются в Hermes profile.

Проверки source и repository instructions выполняются без реального Hermes profile:

```bash
pnpm skills:test
pnpm skills:dependencies:test
pnpm hermes:test
```

`skills:dependencies:test` проверяет весь Git-tracked source и новые canonical
skills до их commit; обязательные внешние workflow skills должны получить
подтверждённого Ebb owner, иначе проверка сообщает exact file/line.

## Русский JSDoc

Все публичные API и production-комментарии пишутся на русском. JSDoc должен описывать назначение, инварианты, границы доверия, побочные эффекты и семантику ошибок.

## Git safety

- Работа только в non-master worktree/branch
- Никакого push/merge/rebase/reset/clean из агентов
- Интеграция только после явного человеческого подтверждения

## Troubleshooting

**Hermes не найден:** установите Hermes Agent и убедитесь, что он в PATH.

**Проверка не проходит:** прочитайте failed check, проверьте выбранный Hermes home
и сначала повторите read-only `pnpm hermes:check`. Для отсутствующего project
trust выполните `pnpm hermes:setup`; эта команда меняет trust/discovery/delegation
активного Hermes home. Не создавайте копию профиля как требование Ebb.

**Provider не отвечает или Hermes сообщает об authentication/refresh error:**
проверьте credential провайдера в Web Settings (OS SecretStore/keyring) и
соответствие выбранного провайдера/модели каталогу Ebb (86 провайдеров).
`pnpm hermes:check` не диагностирует provider auth и не отправляет запрос.
Пользовательский Hermes profile/config/auth не читается и не меняется; не
отправляйте credentials в чат.

**Hermes не запускается, не останавливается или не захватил session ID:**
сохраните точный безопасный код/диагностику Ebb и Run ID. Ошибка запуска или
остановки процесса означает failure соответствующего Run; отказ live session
capture запрещает считать recovery готовым. Не меняйте права файловой системы
ради прохождения этих проверок; передайте диагностический код для исправления
интеграции.

**План не запускается:** убедитесь, что путь к плану корректен и он существует в репозитории.
