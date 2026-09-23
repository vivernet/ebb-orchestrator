---
id: spec-03
status: superseded
title: Production Readiness Design
date: 2026-09-20
stage: 09
type: spec
tags: [production, readiness, security]
---


# Ebb Orchestrator — дизайн доведения v1 до production readiness

**Статус:** approved; дополнен поддержкой Infisical по явному решению пользователя

**Дата:** 2026-09-20

**Область:** устранение подтверждённых дефектов и недостающих подключений в пределах утверждённого local-first v1.

## 1. Цель и границы

Этот документ не расширяет v1. Он задаёт минимальные изменения, без которых
нельзя считать уже заявленные возможности безопасными и проверяемыми в
production:

1. управляемый worktree никогда не удаляется обходным путём, если он содержит
   незакоммиченные изменения;
2. секрет либо сохранён в реально доступном защищённом backend, либо запрос
   отклонён без сохранения метаданных;
3. production bootstrap собирает уже реализованные deterministic Git,
   integration и recovery services и не создаёт runtime data вне
   Orchestrator home;
4. тесты web/backend проверяют настоящий API-путь и не считают отказ proxy
   успешным E2E.

Не входят в scope: distributed workers, Container Mode, multi-user/RBAC,
новый AgentRuntime, изменение workflow/approval policy и новая persistence
technology. Внешнее secrets management ограничено опциональным Infisical
adapter, описанным в разделе 3.2.

## 2. Наблюдаемые дефекты

### 2.1. Worktree cleanup

`WorktreeManager.removeWorkspace()` и `IntegrationService.cleanupIntegration()`
проверяют чистоту основного repository path, а удаляют `worktreePath`. При
ошибке штатного `git worktree remove` применяется `rmSync(..., recursive,
force)`. Поэтому грязный managed worktree может быть удалён вместе с
незакоммиченными пользовательскими данными.

### 2.2. SecretStore

`KeyringSecretStore` допускает отсутствие native keyring backend, но после
неуспешной записи сохраняет SQLite metadata. Последующее чтение возвращает
`undefined`: система создаёт видимость сохранённого секрета. Это нарушает
границу SecretStore и принцип authoritative state.

### 2.3. Runtime composition и local paths

Точка входа backend создаёт базовые application services, но не передаёт
Git/worktree/integration/reconciliation composition в application routes.
Часть runtime artifacts также получает default пути ОС вместо явного
Orchestrator home.

### 2.4. E2E

Playwright запускает Vite, но не backend. Browser suite допускает
`ECONNREFUSED` от proxy и подменяет основную часть API, поэтому её успешный
статус не доказывает работоспособность v1 API/UI.

## 3. Решение

### 3.1. Fail-closed удаление worktree

- Проверять `git status --porcelain` строго в фактическом `worktree.path`.
- При грязном состоянии возвращать typed domain error и сохранять managed
  directory для ручного recovery; не вызывать `git worktree remove` и не
  делать filesystem fallback.
- `rmSync` разрешить только для подтверждённо чистого directory, который
  находится внутри configured managed-worktree root, и только после того,
  как `git worktree remove` не может удалить orphaned filesystem entry.
- Перед fallback заново подтвердить path confinement и отсутствие изменений.
- Добавить regression tests для dirty worktree, clean orphan cleanup и
  integration cleanup.

### 3.2. Fail-closed SecretStore

- Сделать availability защищённого backend явной зависимостью:
  конструктор/bootstrapping возвращает controlled error, если keyring не
  загружен или не доступен.
- Сохранять metadata лишь после успешной записи secret value. При ошибке
  backend не должно быть частичной durable записи; при необходимости
  компенсировать уже записанный value.
- Поставить и зафиксировать поддерживаемую native keyring dependency, если
  она совместима с Node/Windows production environment. Тесты используют
  deterministic fake backend, а не user keyring.
- Маршрут API преобразует ошибку availability в безопасный ответ без
  утечки значения и без успеха "ложного сохранения".

Infisical Cloud не заменяет локальный keyring. При явном
`EBB_SECRET_BACKEND=infisical` production может выбрать отдельный adapter:

- `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`
  и `INFISICAL_ENVIRONMENT` обязательны; неполная конфигурация останавливает
  startup до открытия HTTP listener;
- adapter использует Universal Auth Machine Identity лениво при первой
  secret operation и не пишет credential/value в SQLite, logs или responses;
- service/name детерминированно кодируются в remote secret name; SQLite
  хранит только прежнюю metadata модель;
- remote failure возвращает controlled unavailable error; SQLite failure
  компенсирует только что созданный remote secret или восстанавливает
  предыдущее значение при update;
- без явного backend flag local OS keyring остаётся единственным default.

### 3.3. Явная production composition

- В `main.ts` создать один typed composition root для `ProcessExecutor`,
  `WorktreeManager`, `MergeService`, `IntegrationService`, `GitReconciler`,
  SecretStore и runtime adapters.
- Внедрять эти сервисы в application layer через существующие dependency
  contracts; не давать routes прямой доступ к SQLite или shell commands.
- Все paths (`database`, artifacts, Hermes results/checkpoints, managed
  worktrees) выводить из validated Orchestrator home/configuration.
- Startup recovery выполняет reconciliation только после открытия database
  и до приёма пользовательских mutation requests; failure переводится в
  наблюдаемое degraded состояние, а не игнорируется.
- Не добавлять новый public workflow: подключается только уже описанный
  approved v1 flow и его существующие contracts.

### 3.4. Доказательные integration/E2E

- Разделить browser tests без backend на component/browser-contract tests.
- Для E2E запускать backend на случайном loopback port с isolated temporary
  `ORCHESTRATOR_HOME`, deterministic FakeAgentRuntime и временным fixture
  Git repository; Vite получает этот base URL только через test configuration.
- Добавить health/read/mutation smoke flow, проверяющий, что backend
  действительно доступен. Любой `ECONNREFUSED` должен падать тестом.
- Проверить сценарии onboarding/configuration, безопасной работы с секретом
  (без вывода значения), managed worktree и recovery boundary настолько,
  насколько их покрывают уже утверждённые UI/API contracts.

## 4. Инварианты

- AI не получает SecretStore и не меняет authoritative domain state напрямую.
- Git commands остаются typed, `shell:false`, без hooks и скрытого network.
- Окончательное merge остаётся только после явного approval.
- SQLite хранит metadata/audit state, но не plaintext secrets.
- Ни одна cleanup ошибка не приводит к рекурсивному удалению dirty worktree.
- Все production paths контролируются configuration и остаются внутри
  разрешенных managed roots.

## 5. Порядок реализации и доказательства

1. Добавить failing regression tests для worktree и SecretStore, затем
   минимальные исправления.
2. Собрать composition root, path configuration и recovery; покрыть
   integration tests.
3. Перестроить E2E harness и заменить ложноположительные проверки.
4. Обновить README/операторскую документацию: keyring preflight, location
   данных, старт/остановка, backup/recovery и ограничения v1.
5. Провести новый независимый security scan уже после изменений.
6. Выполнить `pnpm lint`, `pnpm typecheck`, `pnpm test`, relevant build/E2E,
   `git diff --check` и подтвердить чистый intended working tree.

## 6. Критерии готовности

Production readiness в рамках v1 достигнута, только если:

- regression tests доказывают отсутствие destructive fallback для dirty
  worktree;
- недоступный keyring вызывает явный отказ, а не ложный успех;
- реальный bootstrap использует managed paths и wired services;
- E2E поднимает backend и fails on transport errors;
- все quality gates зелёные, security scan завершён штатно, а audit findings
  не содержат load-bearing unresolved items.
