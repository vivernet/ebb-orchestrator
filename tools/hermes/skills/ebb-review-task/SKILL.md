---
name: ebb-review-task
description: Используй для независимого read-only ревью диффа одной задачи Ebb Orchestrator на соответствие требованиям, архитектуре и критериям задачи.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, review]
---

# Ebb Review Task

Работай в свежем контексте. Только review; не редактируй файлы. Сверь task brief/approved plan, текущий diff и относящиеся к нему тесты/evidence.

Проверь correctness, scope, error/failure paths, ownership/contracts, persistence/restart/concurrency при применимости, security boundaries, negative tests, русскую JSDoc policy и случайные правки migrations/history.

Каждый finding должен содержать severity (`BLOCKER / IMPORTANT / MINOR / FALSE_POSITIVE`), path/symbol, evidence, expected vs actual и конкретный impact. Не выдавай style preference за blocker. `PASS` только если не осталось подтверждённых BLOCKER/IMPORTANT findings; иначе `CHANGES_REQUIRED`.

