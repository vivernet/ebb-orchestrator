---
name: ebb-quality-gates
description: Используй для выбора и выполнения проверок качества Ebb Orchestrator по затронутому scope, риску и требованиям плана.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, verification, quality]
---

# Ebb Quality Gates

Выбери сначала самое узкое полезное подтверждение, затем соседние проверки и обязательные repository gates. Не запускай весь набор без необходимости, если scope локален; не опускай plan-required gate.

Для каждого запускай свежую команду на текущем HEAD и запиши точную команду, exit code, существенный результат и ограничения. Применяй `pnpm lint`, `pnpm typecheck`, `pnpm test`, build, docs и E2E/security checks согласно изменённому scope и repository policy. Заверши `git diff --check`.

Не объявляй PASS по намерению, старому отчёту, неполному подпроцессу или summary агента. Разделяй дефект текущей задачи и подтверждённую внешнюю dependency failure; при внешнем блокере сохраняй evidence и не называй worktree полностью проверенным. Проверь diff на generated artifacts, secrets и unrelated changes.

