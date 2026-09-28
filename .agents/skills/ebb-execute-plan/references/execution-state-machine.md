# Execution state machine

## Task states

- `WAITING`: dependency not accepted.
- `READY`: all dependencies accepted; no owner conflict.
- `RUNNING`: implementer owns mutable scope.
- `REVIEW`: implementation produced evidence and is under review.
- `DONE`: completion contract + required review/gates satisfied.
- `BLOCKED`: cannot continue without named unresolved dependency/decision.

Only `READY` may enter `RUNNING`. Only accepted dependencies unlock downstream tasks.

## Continuous execution stop conditions

Stop only for:

1. irreversible/destructive operation not already approved;
2. security-sensitive policy/credential side effect requiring authorization;
3. push/merge/publish/shared-system mutation outside approved plan;
4. plan/spec contradiction so severe that every continuation path is guesswork.

Ordinary ambiguity is a `Ruling:` backed by spec/repository evidence, not a reason to stall.

## Pre-flight scan

Before Task 1, compare every producer→consumer task pair and every shared file/interface pair. Record expected contract and any mismatch in ledger. Resolve conflicts against authoritative design/spec before execution.
