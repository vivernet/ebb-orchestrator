# Completion evidence record

Для каждого claim запиши:

| Claim | Proof command/inspection | Fresh result | Scope/limitations |
|---|---|---|---|
| focused behavior | `<cmd>` | exit/count/assertion | exact task |
| type/build | `<cmd>` | exit/output | packages covered |
| broader tests | `<cmd>` | pass/fail counts | known exclusions |
| docs/E2E/security | `<cmd or review verdict>` | result | applicability |
| hygiene | `git diff --check` + status/diff scan | result | current HEAD |

Completion checklist:

- original symptom/RED now GREEN when applicable;
- every plan acceptance item traced to evidence;
- no unreviewed BLOCKER/IMPORTANT findings;
- no accidental secrets/generated/unrelated changes;
- stated limitations are explicit, not hidden behind PASS wording.
