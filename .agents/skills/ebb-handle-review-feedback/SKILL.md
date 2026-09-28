---
name: ebb-handle-review-feedback
description: Используй после получения review findings по Ebb Orchestrator, прежде чем менять код, чтобы проверить каждое замечание, отсеять false positives и исправлять подтверждённые проблемы по одной.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Handle Review Feedback

Review — технический input, а не автоматический приказ.

1. Прочитай весь feedback и нормализуй каждый finding: requirement, severity, affected path/symbol, claimed evidence.
2. Проверь finding против актуального code/diff/tests. Классифицируй `VALID`, `FALSE_POSITIVE`, `NEEDS_CLARIFICATION` или `CONFLICTS_WITH_AUTHORITY`.
3. Не реализуй непонятный finding частично: сначала разреши ambiguity. Конфликт с approved architecture/user decision эскалируется как decision, а не «исправляется» reviewer preference.
4. Исправляй `BLOCKER/IMPORTANT` по одному или небольшими связанными clusters. Для behavior fix используй `ebb-implement-task` с RED→GREEN evidence.
5. После каждого fix запусти затронутые tests; затем scoped re-review только изменённого range + список прежних findings со статусом `ADDRESSED/NOT_ADDRESSED/FALSE_POSITIVE`.
6. Не добавляй YAGNI functionality только потому, что reviewer назвал её «правильной». Сначала докажи реального consumer/requirement.
7. При технически неверном feedback дай короткий evidence-backed pushback; не делай бессмысленный code churn для согласия.
8. После закрытия task-level findings вернись в `ebb-execute-plan`; whole-change findings проходят тот же цикл перед новым `ebb-final-review`.
