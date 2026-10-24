# Execution state machine

## Task states

- `WAITING`: dependency not accepted.
- `READY`: all dependencies accepted; no owner conflict.
- `RUNNING`: implementer owns mutable scope.
- `REVIEW`: implementation produced evidence and is under review.
- `DONE`: task completion contract + required review/gates satisfied at recorded exact task SHA/tree; no assertion about squash-integrated state or publication.
- `BLOCKED`: cannot continue without named unresolved dependency/decision.

Only `READY` may enter `RUNNING`. Only accepted dependencies unlock downstream tasks.

## Integration state

Keep task states separate from `NOT_INTEGRATED / INTEGRATED_UNVERIFIED / INTEGRATED_VERIFIED / BLOCKED`. Authorized PR squash targets `develop`; after it record the actual integrated SHA and run mandatory local/CI post-integration gates. Only their fresh PASS at that identity allows `INTEGRATED_VERIFIED`. A task review at approved task SHA does not approve a different tree. Release candidate/version/old-master identities belong to explicitly invoked `ebb-release`, never task state transitions.

Default max 2 active subagents is a shared limit across implementers/fixes/reviewers/scouts; a narrower plan/runtime limit applies, and only explicit user policy amendment permits more than 2. Controller remains coordinator; availability/retry pressure does not authorize controller implementation.

## Continuous execution stop conditions

Stop only for:

1. irreversible/destructive operation not already approved;
2. security-sensitive policy/credential side effect requiring authorization;
3. push/merge/publish/shared-system mutation outside approved plan;
4. plan/spec contradiction so severe that every continuation path is guesswork.

Ordinary ambiguity is a `Ruling:` backed by spec/repository evidence, not a reason to stall.

## Pre-flight scan

Before Task 1, compare every producer→consumer task pair and every shared file/interface pair. Record expected contract and any mismatch in ledger. Resolve conflicts against authoritative design/spec before execution.
