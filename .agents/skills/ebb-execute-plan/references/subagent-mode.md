# SUBAGENT execution mode

Per task:

1. Capture BASE and create a compact task brief.
2. Dispatch fresh implementer with exact scope, interfaces, tests and report path.
3. Implementer follows `ebb-implement-task`, runs checks, returns concise report/artifact.
4. Build review package: task requirements, BASE..HEAD diff, test evidence, relevant rulings.
5. Dispatch fresh read-only `ebb-review-task`; reviewer never inherits implementer history.
6. `PASS` → ledger DONE. `CHANGES_REQUIRED` → narrow fix round and scoped re-review.
7. Fix rounds 1–3 may resume implementer; 4–5 use fresh/higher-capability implementer. After 5, adjudicate remaining findings and block only load-bearing unresolved issues.

## Model/cost policy

- Mechanical single-file work: cheapest model that reliably follows exact brief.
- Multi-file integration/debugging: standard capable model.
- Architecture/final whole-change review: strongest available model.
- Reviewers need enough judgment for risk, not automatically the most expensive model.
- Always specify role/model when runtime supports it; accidental inheritance wastes cost.

Large logs live in artifacts. Controller receives verdict + material findings only.
