# Execution ledger format

Store under the plan-owned Git metadata scratch path so it survives conversation compaction without polluting the worktree.

```markdown
# Ebb execution ledger — plan: <repo-relative plan path>
Develop-base: <full pinned develop SHA>
Task-branch: <branch>; PR-target: develop; Diff-base: <full SHA>
Task-head: <full SHA/tree>; Approved-task: <full SHA/tree or NOT_APPROVED>
PR: <identity or NONE>; Integrated-develop: <full squash SHA/tree or NOT_INTEGRATED>
Integration-verification: <NOT_RUN / PASS / BLOCKED, exact local/CI evidence>
Release-candidate: <NONE unless explicit ebb-release; candidate SHA/tree + external metadata identity>
Mode: SUBAGENT
Concurrency: <default max 2 active subagents total; narrower plan/runtime limit or explicit user amendment; implementers/fixes/reviewers/scouts counted together>

## Pre-flight
- Task 1 → Task 2: produces X / consumes X — OK
- Ruling: <finding> — <decision> — <evidence> — <risk if wrong>

## Tasks
- Task 1: DONE — accepted-task SHA <sha/tree> — diff <base..head> — tests <command/result> — review <verdict bound to SHA> — docs <affected-owner evidence or N/A>
- Task 2: RUNNING — BASE <sha> — brief <artifact path> — attempt <n>
```

After compaction/restart, ledger + Git history override conversational recollection. Never redispatch a task marked `DONE` unless its acceptance evidence was invalidated by later change. Technical retry increments `attempt`; it does not duplicate a completed task.

Approved task SHA identifies reviewed task state; squash-integrated develop SHA identifies actual integrated source; candidate SHA identifies release-only commit. They are not interchangeable. Record invalidated evidence explicitly on drift and rerun affected gates/review. Integration and publication have separate states; candidate creation never follows automatically from DONE. Never store secrets in ledger or release metadata.
