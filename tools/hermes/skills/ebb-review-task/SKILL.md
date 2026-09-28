---
name: ebb-review-task
description: Используй, когда нужен независимый read-only review одной реализованной задачи Ebb Orchestrator перед её принятием.
metadata:
  project: "ebb-orchestrator"
  version: "4.0.0"
---

# Ebb Review Task

Работай в свежем контексте. Superpowers `requesting-code-review` можно использовать как dispatch mechanism; этот skill определяет Ebb-specific rubric.

1. Прочитай task requirements/approved plan, exact diff и относящееся evidence. Не наследуй историю implementer.
2. Проверь correctness и spec compliance, затем quality: scope creep, error/failure paths, authority/ownership, public/internal contracts, persistence/restart/concurrency при применимости, security boundary, negative tests и документацию.
3. Сверь тестовые assertions с фактическим production path. Не принимай non-zero RED, неверно выбранный test set или agent summary за доказательство.
4. Для auth/security/process/persistence/transport finding укажи, нужен ли specialist review; не пытайся заменить его поверхностным generic review.
5. Finding format: severity `BLOCKER / IMPORTANT / MINOR / FALSE_POSITIVE`, path/symbol, evidence, expected vs actual, concrete impact и минимальное условие исправления.
6. Verdict `PASS` только при отсутствии подтверждённых `BLOCKER/IMPORTANT`; иначе `CHANGES_REQUIRED`.

Не редактируй production code и не превращай style preference в blocker. Если утверждение reviewer опровергается кодом/тестом, пометь его `FALSE_POSITIVE`, а не требуй бессмысленный fix.
