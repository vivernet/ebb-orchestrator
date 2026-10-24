# Agent dispatch brief

```markdown
## Goal
<one independently checkable outcome>

## Scope
- Allowed read paths: ...
- Allowed write paths: ... / read-only
- Must not touch: ...

## Authority
- task/plan/spec paths
- exact interfaces/decisions already fixed

## Evidence / commands
- starting failure or question
- exact command(s) to run

## Constraints
- no scope expansion
- no push/merge/publish
- preserve unrelated changes
- shared active-subagent limit: default 2 across implementers/fixes/reviewers/scouts; lower plan/runtime limit applies; higher limit requires explicit user policy amendment
- controller coordinates; no controller task implementation to evade the limit

## Return contract
- result/verdict
- root cause or changes
- files touched
- commands + exit/results
- unresolved risks
- artifact/report path for long output
```

Controller should be able to decide the next action from this return contract without loading the agent's full transcript.
