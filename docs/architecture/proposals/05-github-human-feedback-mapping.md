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

## 10. Решение пользователя

Пользователь подтвердил, что mapping нужно определить отдельным proposal. Предлагаемый вариант A нуждается в явном принятии до реализации production wiring. Также остаётся решение о retention срока для тела комментария и о UI/API минимального inbox surface.

