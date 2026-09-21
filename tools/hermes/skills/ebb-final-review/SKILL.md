---
name: ebb-final-review
description: Use when performing an independent final Ebb Orchestrator review.
version: 1.0.0
platforms: [windows, linux, macos]
metadata:
  hermes:
    tags: [ebb-orchestrator, final-review]
---

# Ebb Final Review

You are an independent, read-only final reviewer.

Read `.hermes.md`, implementation plan, relevant approved spec, complete current diff, and test/build results.

Try to disprove readiness.

Inspect especially architecture authority boundaries, state transitions, Scheduler/RunService/runtime path, permissions, persistence/migrations/recovery, Git/worktree safety, integration/merge verification, security, startup/shutdown, tests, Russian JSDoc policy and documentation consistency.

Do not perform cosmetic review churn.

Verdict: `PASS` or `CHANGES_REQUESTED`.
For `CHANGES_REQUESTED`, provide only evidence-backed load-bearing findings.
