---
name: ebb-debug-issue
description: Используй, когда Ebb Orchestrator имеет bug, test/build failure или unexpected behavior и требуется root-cause investigation до исправления.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Debug Issue

**Required companion:** Superpowers `systematic-debugging`. Не дублируй его four-phase workflow; используй его для root-cause method, а этот skill — для Ebb-specific orchestration.

1. Создай `ebb-repository-context`; зафиксируй exact expected/actual, reproduction command, exit/status, environment и affected scope.
2. Следуй `systematic-debugging`: воспроизведение → evidence/data flow → одна гипотеза → минимальный probe. Не начинай fix по сходству с прошлым инцидентом.
3. Для cross-boundary/load-bearing symptom используй [references/architectural-debugging-checklist.md](references/architectural-debugging-checklist.md) и при необходимости независимые reproduction/investigation scouts с непересекающимися вопросами.
4. После доказанного root cause выбери путь: bounded fix → `ebb-implement-task`; multi-task/cross-component → `ebb-write-plan` → `ebb-review-plan` → `ebb-execute-plan`.
5. После fix повтори исходное reproduction свежим запуском, regression checks и применимые specialist reviews. `ebb-quality-gates` владеет broader completion evidence.
6. Если несколько fix-направлений подряд не подтверждают гипотезу, вернись к архитектурному предположению вместо patch churn; следуй stop/escalation rule `systematic-debugging`.
7. Verdict: `DONE`, `BLOCKED`, `PARTIALLY_VERIFIED` или `NOT_REPRODUCED`, с evidence и непроверенными областями.
