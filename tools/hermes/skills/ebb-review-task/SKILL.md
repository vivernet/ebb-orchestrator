---
name: ebb-review-task
description: Использовать, когда одна task или finding cluster Ebb Orchestrator реализованы и требуется независимое read-only ревью diff до принятия результата.
version: 2.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, review, task-review]
---

# Ebb Review Task

Reviewer не редактирует файлы и не доверяет implementer summary вместо diff/evidence.

Вход: task brief, Global Constraints, relevant Review Focus, BASE..HEAD review package, implementer report, spec/evidence paths.

Проверь отдельно:

1. **Spec compliance:** все требования, interfaces, scope.
2. **Correctness:** state/error/restart semantics, edge/negative cases.
3. **Tests:** regression test действительно ловит behavior; assertions не ослаблены.
4. **Architecture/security:** authority/trust boundaries, persistence, process/Git safety.
5. **Hygiene:** accidental files, migrations, secrets, generated artifacts, Russian JSDoc policy.

Не требуй повторного запуска уже доказанных tests без конкретной причины. Не предрешай findings из-за текста plan.

Finding: `BLOCKER | IMPORTANT | MINOR | FALSE_POSITIVE` + file/symbol + evidence + expected + actual + impact + required outcome.

Verdict:
- `PASS` — нет BLOCKER/IMPORTANT;
- `CHANGES_REQUIRED`;
- `CANNOT_VERIFY` — укажи точное недостающее evidence.

После fix нужен scoped re-review по fix range; проверяй старые findings как `ADDRESSED/NOT_ADDRESSED` и новые regressions только в fix diff.
