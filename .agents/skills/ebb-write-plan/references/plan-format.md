# Ebb implementation plan format

## Header

```markdown
# <Feature> Implementation Plan

**Goal:** <one sentence>
**Architecture:** <2–4 sentences>
**Authority:** <approved design/spec paths>
**Global Constraints:** <project-wide invariants>
**Specialist Constraints:** <only triggered domain owners, e.g. database/security/Web>
**Review Focus:** <highest-risk uncovered conditions>
```

## File / interface map

До tasks перечисли создаваемые/изменяемые файлы и ответственность каждого. Файлы, меняющиеся вместе, группируй по ответственности, а не механически по layer.

## Task contract

Каждая task содержит:

- `Task ID`, проверяемый deliverable, `Depends on`;
- exact `Create` / `Modify` / `Test` paths;
- `Interfaces`: что consumes и produces, exact names/types/error semantics на load-bearing seams;
- **RED:** тест/сценарий, команда и ожидаемая причина failure;
- **GREEN:** минимальная реализация и команда с ожидаемым PASS/output;
- triggered specialist constraints/evidence, не скопированный specialist workflow;
- neighboring/applicable gates;
- `Review Focus` конкретно для task;
- completion contract и условия `BLOCKED`;
- commit step только если это разрешено repository governance.

Один шаг = одно проверяемое действие. Не оставляй `TBD`, `or equivalent`, «при необходимости», будущий artifact как существующий evidence или скрытое design decision.

## Self-review

1. Каждое требование имеет task owner.
2. Task dependencies ацикличны; producer существует до consumer.
3. Имена/interfaces согласованы между tasks.
4. RED действительно должен падать до изменения, GREEN проверяет нужный production path.
5. Commands существуют и Expected конкретен.
6. High-risk failure modes либо тестируются, либо явно отданы triggered specialist/final review.
7. План не превращён в транскрипт кода: bodies приводятся только там, где без них остаётся неоднозначность.
