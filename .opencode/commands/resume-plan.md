---
description: Resume an interrupted implementation plan from its durable ledger.
agent: sdd-orchestrator
subagent: false
---

Resume the approved implementation plan at:

`$ARGUMENTS`

Current branch:
!`git branch --show-current`

Current Git status:
!`git status --short`

Read the matching ledger under `.opencode/state/` before dispatching any subagent.

- Trust verified Git commits plus the ledger over conversational memory.
- Do not re-dispatch tasks already recorded as complete unless their commit is missing or the repository state proves the ledger stale.
- If a task was mid-review/fix loop, continue that loop from the next required action.
- Reconcile `HEAD`, task commits, and Git status before resuming.
- Follow the same implementer → reviewer → fix/re-review discipline as `/execute-plan`.
- Finish with `final-reviewer` once all plan tasks are complete.
- Never push, merge, publish, deploy, or start another plan.
