---
name: ebb-implement-task
description: Использовать, когда нужно выполнить одну конкретную task из implementation plan Ebb Orchestrator или один подтверждённый finding cluster в текущем worktree.
version: 4.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, implementation, tdd, subagents]
---

# Ebb Implement Task

Task-controller не пишет код. Он запускает одного leaf-agent за раз; leaf не создаёт субагентов.

## Loop

1. Прочитай task brief и relevant Context Brief; зафиксируй BASE.
2. Fresh Implementer выполняет behavior changes по RED → GREEN → REFACTOR:
   - regression/behavior test;
   - доказанный RED до production fix;
   - минимальный implementation;
   - focused + neighboring checks;
   - `git diff --check`;
   - self-review и report artifact.
3. Создай BASE..HEAD review package.
4. Обязательно вызови `ebb-review-task`.
5. BLOCKER/IMPORTANT → fix-loop:
   - rounds 1–3: resume исходного implementer, если возможно;
   - rounds 4–5: fresh более сильный Fixer;
   - каждый round заканчивается scoped `ebb-review-task`.
6. Security-sensitive diff → обязательный `ebb-security-review`.
7. Web/browser/API/SSE scope → обязательный `ebb-web-e2e`.
8. После clean review вызови `ebb-quality-gates` для task-required gates, особенно после fix-loop/public interface/high-risk change.
9. Верни `DONE` только при выполненном completion contract.

После round 5 residual load-bearing finding → `BLOCKED`; MINOR можно defer только с `Ruling:`.

Crash/timeout/tool error → fresh same-role agent с brief + artifacts. После 2 reasoning failures повышай модель и сужай scope.

Никаких merge/push/tag/release. Commit — только если task/plan требует.
