---
name: ebb-debug-issue
description: Используй, когда Ebb Orchestrator имеет bug, failing test/build, performance problem или unexpected behavior и требуется доказать root cause до исправления.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Debug Issue

**Никаких fixes до root-cause investigation.** Симптомный patch без доказанной причины не считается debugging.

## Phase 1 — Evidence

1. Получи `ebb-repository-context`; запиши exact expected/actual, reproduction command, exit/status, environment и affected scope.
2. Воспроизведи стабильно. Прочитай полный error/stack, проверь recent changes и environment/config propagation.
3. Для multi-component path проследи data/control flow через каждую boundary и собери evidence, где именно contract ломается.

## Phase 2 — Pattern

4. Найди близкий working path/reference внутри repo; перечисли различия и зависимости без отбрасывания «маленьких» отличий.
5. Для cross-boundary/load-bearing issue используй [architectural checklist](references/architectural-debugging-checklist.md). Независимые investigations можно делегировать через `ebb-dispatch-agents`.

## Phase 3 — Hypothesis

6. Сформулируй **одну** гипотезу: root cause X, потому что evidence Y. Проверяй минимальным probe, одна переменная за раз.
7. Не сработало → новая гипотеза на основе нового evidence, а не дополнительный случайный fix.

## Phase 4 — Fix

8. После доказанного cause: bounded fix → `ebb-implement-task`; multi-task/cross-component → `ebb-write-plan` → review → execute.
9. Повтори исходное reproduction на текущем HEAD, regression checks и applicable specialist gates.
10. После трёх неудачных fix-направлений останови patch churn и пересмотри architecture/assumption. Verdict: `DONE / BLOCKED / PARTIALLY_VERIFIED / NOT_REPRODUCED` с evidence.
