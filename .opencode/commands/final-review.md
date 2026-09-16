---
description: Run an independent whole-branch review for a completed implementation plan.
agent: final-reviewer
subagent: true
---

Perform the final whole-branch review for this implementation plan:

`$ARGUMENTS`

Current branch:
!`git branch --show-current`

Current Git status:
!`git status --short`

Read the plan and its referenced specification, determine the read-only diff against `master`, run the relevant full verification suite, and return the formal final-review verdict.

Do not edit, commit, push, merge, publish, deploy, or switch branches.
