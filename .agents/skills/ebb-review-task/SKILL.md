---
name: ebb-review-task
description: Используй, когда нужен независимый read-only review одной реализованной задачи Ebb Orchestrator перед её принятием.
metadata:
  project: "ebb-orchestrator"
  version: "5.0.0"
---

# Ebb Review Task

Reviewer работает в свежем контексте и получает task requirements, exact diff/range, evidence и relevant rulings — не историю implementer.

1. Сначала проверь spec/task compliance: реализовано ли требуемое, не пропущены ли acceptance/negative paths.
2. Затем quality: scope creep, failure semantics, ownership/contracts, persistence/restart/concurrency, security boundary, tests/docs и accidental generated/history changes при применимости.
3. Сверь тестовые assertions с реальным production path. Agent summary, старый output или не тот targeted set не являются доказательством.
4. Finding: severity `BLOCKER / IMPORTANT / MINOR / FALSE_POSITIVE`, path/symbol, evidence, expected vs actual, concrete impact и минимальное условие исправления.
5. `PASS` только при отсутствии подтверждённых `BLOCKER/IMPORTANT`; иначе `CHANGES_REQUIRED`.
6. Review read-only. Feedback передаётся implementer через `ebb-handle-review-feedback`; reviewer не «чинит за автора».
7. Specialist scope не заменяется generic review: security → `ebb-security-review`, browser/HTTP/session/SSE → `ebb-web-e2e`.

Style preference без correctness/maintainability impact не является blocker.
