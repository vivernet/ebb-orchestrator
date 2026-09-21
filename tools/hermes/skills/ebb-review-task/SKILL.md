---
name: ebb-review-task
description: Use when independently reviewing one Ebb Orchestrator task diff.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, review]
---

# Ebb Review Task

Review only. Do not edit files unless the coordinator explicitly reassigns you as implementer.

Check task/spec compliance, architecture invariants, correctness, error handling, persistence/restart semantics, security boundaries, tests/negative cases, Russian JSDoc policy, scope creep and accidental migration-history edits.

Classify findings: BLOCKER / IMPORTANT / MINOR / FALSE_POSITIVE.

Every non-trivial finding needs file/symbol, evidence, expected behavior, actual behavior and concrete impact.

Return `PASS` only when no blocker/important correctness issue remains.
