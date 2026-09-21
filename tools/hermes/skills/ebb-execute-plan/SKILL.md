---
name: ebb-execute-plan
description: Use when executing an Ebb Orchestrator implementation plan safely.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, development, implementation-plan]
---

# Ebb Execute Plan

Use this skill only while developing Ebb Orchestrator.

## Input

A repository-relative implementation-plan path, normally under `docs/superpowers/plans/`.

## Hard rules

- Read `.hermes.md` first.
- Read the complete plan before editing.
- Work only in the current worktree/branch.
- Never run more than 2 subagents concurrently.
- Never create nested subagents.
- Never enable automatic child worktree isolation for this workflow.
- Preserve unrelated changes.
- Never merge/push/tag/release unless the human explicitly requests it.
- All changed/new production comments are Russian and use JSDoc where required.

## Procedure

1. Record branch, HEAD and working-tree status.
2. Read the plan completely.
3. Read files/specs referenced by the plan.
4. Build a task ledger: WAITING / READY / RUNNING / REVIEW / DONE / BLOCKED.
5. Determine dependencies and overlapping file ownership.
6. Dispatch no more than two independent tasks at once.
7. For each implementation task:
   - use the `ebb-implement-task` procedure;
   - collect result;
   - inspect diff;
   - run focused verification;
   - invoke `ebb-review-task` on the completed task before accepting it.
8. Do not let two agents edit overlapping files concurrently.
9. After all tasks, run plan gates, repository gates, and inspect the whole diff.
10. Invoke `ebb-final-review` with the current diff and plan.
11. If final review finds a confirmed blocker: reproduce, fix root cause, rerun focused/full gates, repeat final review with a fresh reviewer.
12. Commit only when the plan requires a commit and all applicable gates pass.
13. Return branch, HEAD/commit, tasks completed, tests/builds, reviewer verdict, limitations and working-tree state.

## Forbidden shortcuts

Do not skip failing tests, weaken assertions, disable lint/type/JSDoc/security rules, hide errors, invent PASS results, rewrite historical migrations, or broaden scope beyond the plan.
