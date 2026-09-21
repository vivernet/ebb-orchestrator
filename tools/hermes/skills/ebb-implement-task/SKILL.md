---
name: ebb-implement-task
description: Use when implementing one isolated Ebb Orchestrator plan task.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, implementation, tdd]
---

# Ebb Implement Task

Implement exactly one assigned plan task or one confirmed finding cluster.

## Before editing

1. Read `.hermes.md`.
2. Read the assigned task.
3. Read referenced spec/code/tests.
4. Confirm the allowed file set.
5. Run focused baseline tests when available.

## Implementation loop

For each behavior change:
1. prove/reproduce;
2. write/update a regression test;
3. run it and confirm expected failure when practical;
4. implement the smallest correct change;
5. update Russian JSDoc when a public contract/invariant changed;
6. run the focused test;
7. run neighboring tests;
8. run `git diff --check`;
9. inspect your diff.

## Boundaries

- Do not change unrelated files.
- Do not change another task's owned files without escalation.
- Do not merge/push/tag/release.
- Do not start subagents.
- Do not claim completion without test evidence.

Return files changed, tests run, result and remaining risks.
