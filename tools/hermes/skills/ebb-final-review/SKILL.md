---
name: ebb-final-review
description: Используй после выполнения плана для независимого read-only ревью готовности полного изменения Ebb Orchestrator.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, final-review]
---

# Ebb Final Review

В свежем контексте попытайся опровергнуть готовность. Прочитай approved plan/spec, полный текущий diff и актуальные результаты проверок; bootstrap context используй через brief, не перечитывай нерелевантные документы.

Проверь архитектурные authority boundaries, state transitions, scheduler/runtime paths, permissions, persistence/migrations/recovery, security, startup/shutdown, Git/worktree safety, integration, тесты, русскую JSDoc policy и согласованность документации. Для Web/security scope проверь наличие соответствующего specialist evidence.

Не делай косметический review churn. Вердикт `PASS` или `CHANGES_REQUESTED`. Каждый finding — только с evidence, path/symbol, impact и минимальным условием исправления. Review read-only; подтверждённые блокеры возвращай implementer/controller.

