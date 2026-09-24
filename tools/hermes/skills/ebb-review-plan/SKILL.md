---
name: ebb-review-plan
description: Использовать, когда draft implementation plan Ebb Orchestrator готов и требуется независимая проверка его полноты, исполнимости, декомпозиции, интерфейсов, TDD-шагов и governance metadata до реализации.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, planning, review]
---

# Ebb Review Plan

Независимый read-only review. Не исправляй plan в той же роли.

Проверь draft против authoritative requirements/spec и repo evidence:

- **Coverage:** каждому acceptance criterion соответствует task.
- **Naming/metadata:** filename, `id`, `roadmap`, `stage`, lifecycle status и dependencies соответствуют governance policy.
- **Task size:** каждая task имеет самостоятельный проверяемый deliverable и meaningful review boundary.
- **Files/Interfaces:** точные пути, реальные symbols, согласованные producer/consumer signatures.
- **TDD:** behavior change имеет RED → GREEN; исключение обосновано.
- **Commands:** каждый `Run` реален и имеет конкретный `Expected`.
- **Review Focus:** конкретные failure modes закреплены тестами в owning tasks.
- **Ordering:** dependency graph ацикличен и достаточен.
- **Restraint:** нет YAGNI, placeholders, hidden architecture decisions и unrelated refactoring.
- **Execution:** свежий task-controller сможет выполнить любую task без истории беседы.

Finding: `BLOCKER | IMPORTANT | MINOR` + section/task + evidence + требуемый outcome.

Verdict: `APPROVED | CHANGES_REQUIRED | REQUIREMENTS_BLOCKED`.

`APPROVED` допустим только без BLOCKER/IMPORTANT findings.
