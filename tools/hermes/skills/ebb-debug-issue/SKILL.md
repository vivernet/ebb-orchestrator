---
name: ebb-debug-issue
description: Использовать, когда в Ebb Orchestrator сообщена ошибка, баг, failing test/build, 401/5xx, flaky behavior, performance regression или иное неожиданное техническое поведение до попытки исправления.
version: 3.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, debugging, root-cause, subagents]
---

# Ebb Debug Issue

**NO FIX WITHOUT ROOT CAUSE. NO “FIXED” WITHOUT FRESH VERIFICATION.**

Debug-controller не пишет fix.

1. `ebb-repository-context` → issue brief.
2. Fresh Reproducer фиксирует минимальный сценарий, expected/actual, exit/status и baseline.
3. Fresh Investigator:
   - читает full error/stack;
   - проверяет recent changes/config/dependencies;
   - трассирует bad state назад к origin;
   - сравнивает working vs broken;
   - для regression при возможности использует `git bisect`;
   - проверяет **одну** hypothesis минимальным probe.
4. Fresh Diagnosis Reviewer: `ROOT_CAUSE_CONFIRMED | INSUFFICIENT_EVIDENCE | ALTERNATIVE_CAUSE | ARCHITECTURAL_RISK`.
5. После подтверждения:
   - одна coherent task → `ebb-implement-task`;
   - multi-task/cross-component/public-interface fix → `ebb-write-plan` → `ebb-execute-plan`.
6. Security/Web scope активирует соответствующие specialist skills.
7. Fresh Final Bug Reviewer проверяет causal correctness: исправлен source, а не symptom.
8. Fresh verification повторяет original reproduction и применимые gates.

Три подряд расширяющихся/несвязных гипотезы → остановить patch churn и проверить архитектуру. Пять неудачных attempts одного этапа → `BLOCKED`.

Большие logs/diff → artifacts; controller получает summary + paths.
