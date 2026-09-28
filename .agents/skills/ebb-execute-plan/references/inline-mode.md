# INLINE execution mode

Use when delegation is unavailable, tasks are tightly coupled, or user explicitly prefers one implementation context.

1. Same plan-owned ledger and pre-flight scan as SUBAGENT mode.
2. For each READY task, create/read the task brief; do not repeatedly reload entire plan.
3. Follow `ebb-implement-task`: RED → minimal GREEN → refactor → focused/neighbor checks.
4. Compare every command against plan `Expected`. Code mismatch → `ebb-debug-issue`; plan mismatch → ledger `Ruling:` based on authoritative spec.
5. Record task completion only after its completion contract and fresh evidence. Task self-review is not represented as independent review.
6. Continue without check-ins between tasks unless a named stop condition occurs.
7. After final task, run `ebb-quality-gates` and seek a fresh-context `ebb-final-review` when runtime permits. If only self-review is possible, report reduced assurance explicitly.

INLINE saves repeated context startup; it does not relax evidence or completion requirements.
