---
id: proposal-05
status: proposed
title: Связь комментариев GitHub Issues с HumanFeedback
date: 2026-09-29
type: proposal
tags: [github, human-feedback, v1]
---

# Proposal: связь комментариев GitHub Issues с HumanFeedback

**Статус:** proposed; требуется решение по предлагаемому mapping до production wiring.

## 1. Цель и ограничения

Подключить уже предусмотренные system design §15 GitHub polling и `Sync now`, передавая новые комментарии Issues в локальный поток `HumanFeedback` без изменения workflow state от имени GitHub.

Уже подтверждённый пользователем контракт импорта:

- импортировать новые комментарии к GitHub Issues;
- дедуплицировать по GitHub comment ID внутри repository;
- игнорировать комментарии с маркером `ORCHESTRATOR:` и авторов типа `Bot`;
- PR comments и PR reviews не импортировать.

## 2. Текущее состояние

`GitHubAdapter` и `GitHubSyncWorker` существуют. Worker получает callback для `HumanFeedback`, а SQLite receipt фиксирует `PENDING`/`DELIVERED`. Маршрут `POST /api/v1/github/sync` зарегистрирован только при переданном `deps.github` и защищён общей local-session/CSRF boundary.

Production `main.ts` не создаёт GitHub adapter/worker и не передаёт `deps.github`. В проекте нет `HumanFeedback` entity/service/inbox. У Issue comment известны repository, issue number и comment ID, но отсутствует согласованное соответствие Issue локальному Project, Epic или Task.

Поэтому текущая реализация не активирует GitHub sync в production. Создание произвольного Task или Proposal из комментария нарушило бы deterministic-first и могло бы назначить требование неправильной работе.

## 3. Рассмотренные варианты

### A. Durable project-scoped HumanFeedback inbox — рекомендуется

- Настроенный GitHub repository однозначно связан с одним активным локальным Project.
- Комментарий сохраняется в локальный inbox как `HumanFeedback` с неизменяемыми source fields: repository, issue number, comment ID, author, body, URL и timestamps.
- Inbox item сначала связан только с Project. Человек либо последующая reconciliation operation явно связывает его с Task/Epic и решает, создавать ли Proposal.
- Получение комментария не меняет Task/Epic lifecycle и не закрывает/завершает работу.

**Плюсы:** не теряется контекст, связь с Project детерминирована конфигурацией; не выдумывается Task mapping; повторная обработка переживает restart.

**Цена:** нужен inbox persistence/API/UI или хотя бы безопасная локальная очередь, плюс политика хранения тела комментария.

### B. Внешнее Issue → Task mapping

Хранить явную таблицу соответствий GitHub Issue и локального Task/Epic; импорт разрешён только при существующей связи.

**Плюсы:** комментарий сразу адресован конкретной работе.

**Цена:** нужны команды создания/удаления связи, правила неоднозначности и восстановление mapping. Issue с несколькими локальными задачами или без связи остаётся необработанным.

### C. Одна глобальная очередь без Project mapping

Сохранять комментарии в общей inbox очереди, а локальный объект назначать позже.

**Плюсы:** минимальные предпосылки при приёме.

**Цена:** слабая изоляция между проектами и дополнительная неоднозначность; сложнее безопасно показывать комментарии пользователю.

## 4. Рекомендуемое решение

Выбрать вариант A: Project определяется только сохранённой локальной настройкой GitHub-интеграции, выбранной пользователем при подключении. Не выводить Project или Task ID из comment body, labels, title, ветки либо model output.

Если repository не связан ровно с одним активным Project, sync завершается `SYNC_PENDING` и не записывает feedback. Для каждого нового комментария запись inbox и dedupe receipt должны создаваться одной SQLite транзакцией с уникальным ключом `(repository, comment_id)`. Повторный poll возвращает уже существующий inbox item; внешний API не должен повторно создавать Proposal.

Первичный приём хранит комментарий как недоверенный текст. UI рендерит его как text/санитизированный Markdown согласно действующей web security policy. Inbox item не даёт комментариям authority менять contract, approval, workflow или Task status. Семантическое изменение проходит существующие reconciliation/Proposal approval flow.

## 5. Границы и интерфейсы

- `GitHubAdapter` владеет только REST/auth и преобразованием GitHub response в типизированные comment DTO.
- `GitHubSyncWorker` владеет polling, фильтрацией bot/Orchestrator/PR comments, retry и стабильным source identity.
- Project settings связывают один GitHub repository с одним активным локальным Project. Секреты остаются в `SecretStore`.
- `HumanFeedback` inbox service владеет immutable source metadata, dedupe, локальным состоянием обработки и назначением на Project/Task/Epic.
- Inbox API использует обычную local-session/Origin/CSRF защиту.
- `Sync now` и polling вызывают одинаковый application service; локальный workflow остаётся доступен без GitHub.

Предлагаемая identity: `github:{normalizedRepository}:issue-comment:{commentId}`. Repository normalization и GitHub host должны входить в identity, если поддерживается более одного GitHub API endpoint.

## 6. Состояния и отказ

- GitHub недоступен / auth или permissions заблокированы: синхронизация остаётся pending/blocked и не мешает локальному workflow.
- Нет Project mapping или mapping неоднозначен: `USER_DECISION_REQUIRED` либо `SYNC_PENDING`; comment не теряется и не назначается автоматически.
- Crash до SQLite commit: следующий poll повторяет импорт.
- Crash после commit: уникальная source identity предотвращает повторную inbox запись.
- Повторная обработка inbox item не повторяет внешние GitHub writes и не создаёт дубликаты Proposal.
- Несколько trigger на один repository сериализуются в одном worker; уникальное ограничение остаётся последней защитой от дублей в SQLite.

## 7. Безопасность и хранение

- GitHub comments и metadata считаются недоверенным вводом.
- Credentials доступны только GitHub adapter через `SecretStore`, не Hermes.
- API и логи не возвращают token/private key; в логах допустимы стабильный comment ID и безопасный статус, без тела.
- Предлагаемая retention policy: inbox хранит тело до явного удаления Project/feedback по продуктовой retention policy. Требуется подтвердить срок до реализации; по умолчанию не логировать и не копировать body в диагностические artifacts.
- Unlinked Issue comments не получают доступ к другим Projects.

## 8. Миграция и совместимость

Добавить append-only миграции для Project GitHub mapping и HumanFeedback inbox. Существующая таблица `github_feedback_deliveries` сейчас служит техническим receipt и не содержит body; преобразовывать её в domain inbox не следует. При миграции старые `PENDING` receipts необходимо повторно обработать из GitHub либо оставить pending до включения утверждённого inbox handler.

GitHub остаётся optional. Существующие installations без mapping не меняют локальный workflow и не запускают незаметный импорт.

## 9. Проверка

- Unit: exact source identity, bot/marker/PR filtering, unknown/ambiguous project mapping, hostile comment text, duplicate poll.
- Database: atomic inbox+dedupe transaction, restart после commit, migration from prior supported schema.
- API/security: session, Origin, CSRF, project isolation, no credentials/body in logs.
- Integration: fake GitHub pagination, rate limit, timeout, 401/403, manual and scheduled sync using the same service.
- Acceptance: отключённый GitHub не блокирует local workflow; linked repository comment появляется один раз в правильном Project inbox.

## 10. Предлагаемый точный контракт

Это recommendation для review, а не разрешение на реализацию. Он конкретизирует вариант A и ограничивает v1 импортом комментариев в Project-scoped inbox.

### Mapping и source identity

- Один GitHub repository может быть привязан максимум к одному активному локальному Project. Mapping задаёт пользователь в Project Settings; связь из Issue title/body, labels, branch или модели не выводится.
- V1 принимает канонический GitHub repository в форме `owner/repository`, нормализует `owner` и `repository` в lowercase и включает host `github.com` в source identity: `github.com:{owner/repository}:issue-comment:{commentId}`.
- Комментарии к незамапленному repository не получают receipt и не импортируются. Sync возвращает `SYNC_PENDING` с безопасной причиной `PROJECT_MAPPING_REQUIRED`; повтор после настройки mapping перечитывает ещё не доставленные comments.
- Mapping уникален по normalized repository key. Передача repository другому Project не меняет уже сохранённые feedback rows: они остаются в первоначальном Project.

### Inbox record и lifecycle

Предлагается отдельная `human_feedback` таблица с Orchestrator-generated `id`, `project_id`, `source_key` (UNIQUE), `source_repository`, `source_issue_number`, `source_comment_id`, `author_login`, `body`, `source_url`, `source_created_at`, `received_at`, `status`, nullable `task_id`/`epic_id` и `triaged_at`. `source_key` уникален во всей таблице, а локальная запись хранится неизменно после получения; mutable triage поля обновляются только через HumanFeedback module API.

Начальный статус — `UNTRIAGED`. Человек может связать feedback с существующим Task/Epic того же Project (`LINKED`), закрыть triage как `IGNORED` либо `RESOLVED`; все переходы проверяются детерминированным service. Получение, `LINKED`, `IGNORED` и `RESOLVED` не меняют Task/Epic workflow state и не создают Proposal автоматически. Создание Task или Proposal из feedback — отдельное явное действие в UI/application flow.

### Durable delivery и recovery

Worker сначала проверяет repository mapping, затем запрашивает Issue comments. Для каждого принятого comment одна SQLite transaction вставляет inbox row и переводит существующий technical delivery receipt в `DELIVERED`; unique `source_key` делает повторный poll безопасным. Если SQLite transaction не завершилась, следующий poll повторяет доставку. Старые `PENDING` receipts миграция не объявляет доставленными: sync перечитывает источник и вставляет inbox row по source identity.

Repository polling сериализуется как сейчас в одном процессе. SQLite uniqueness защищает от дублей при повторе/restart, но distributed/multi-process workers остаются вне v1. GitHub timeout, 401/403 или rate limit оставляют sync pending/blocked по существующей GitHosting модели и не блокируют local workflow.

### Module/API/UI boundary

- `GitHubSyncWorker` передаёт типизированный comment DTO application service; он не записывает domain rows напрямую.
- Новый `HumanFeedbackService` владеет mapping lookup, транзакционной вставкой, dedupe и triage transitions. `GitHubAdapter` остаётся владельцем только GitHub transport/auth.
- В защищённом Web UI предлагается Project inbox: список `UNTRIAGED` items и detail с source link/body; действия связать с существующим Task/Epic, отметить `IGNORED` или `RESOLVED`. Body показывается как недоверенный текст, без HTML execution.
- Application routes ограничены выбранным Project и используют существующие local-session, Origin и CSRF проверки. Ошибка cross-project link возвращает controlled `404`/`409` без раскрытия существования чужого Task.
- Предлагаемые endpoints: `GET /api/v1/projects/{projectId}/human-feedback?status=UNTRIAGED`; `POST /api/v1/projects/{projectId}/human-feedback/{feedbackId}/link` с `{ targetType: "TASK" | "EPIC", targetId }`; `POST .../{feedbackId}/ignore`; `POST .../{feedbackId}/resolve`. Ответы содержат только DTO inbox item, pagination cursor и безопасный status; route не принимает repository/comment identity от клиента.
- Ни API, ни logs не возвращают credentials; structured logs содержат только source identity, Project ID, безопасный status/reason и correlation ID, но не body.

### Migration, retention и verification

- Добавить append-only migration для repository-to-Project mapping и `human_feedback`; technical delivery receipts остаются техническими receipts и не переинтерпретируются как inbox rows.
- Рекомендуемая retention policy: хранить body вместе с активным локальным Project до явного удаления feedback/Project пользователем; удаление feedback сохраняет минимальный source identity tombstone, чтобы последующий poll не импортировал удалённый comment повторно. Удаление Project удаляет mapping и inbox в рамках явного Project deletion flow.
- Acceptance включает duplicate poll/restart, crash до и после transaction, mapping отсутствует/переназначен, cross-project link, hostile body rendering, session/Origin/CSRF, redaction, migration из поддерживаемой схемы и GitHub outage без влияния на local workflow.

### Решения, необходимые до implementation plan

1. Принять предложенный Project-scoped inbox и правило «один repository → один Project» либо выбрать другой вариант из раздела 3.
2. Принять retention policy с явным пользовательским удалением либо задать срок автоматического хранения.
3. Подтвердить UI inbox с link/ignore/resolve действиями как часть Plan06 Task 8 либо ограничить v1 API и вынести UI в отдельный план.

Без решений 1–3 production wiring и реализация HumanFeedback не начинаются. До их принятия текущий импорт остаётся выключенным в production.

## 11. Решение пользователя

Пользователь попросил определить mapping отдельным proposal. Этот документ содержит предлагаемую конкретизацию варианта A; решения 1–3 выше ожидают review. Production wiring и implementation plan остаются заблокированы до их явного принятия.
