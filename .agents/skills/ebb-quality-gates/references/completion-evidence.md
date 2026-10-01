# Completion evidence record

Для каждого claim запиши:

| Claim | Proof command/inspection | Fresh result | Scope/limitations |
|---|---|---|---|
| focused behavior | `<cmd>` | exit/count/assertion | exact task |
| type/build | `<cmd>` | exit/output | packages covered |
| broader tests | `<cmd>` | pass/fail counts | known exclusions |
| database/security/Web specialist | `<cmd or specialist verdict>` | result | applicability + starting state |
| docs | `<cmd or inspection>` | result | scope |
| hygiene | `git diff --check` + status/diff scan | result | current HEAD |

Completion checklist:

- original symptom/RED now GREEN when applicable;
- every plan acceptance item traced to evidence;
- database change has applicable fresh/upgrade/schema/data evidence from `ebb-database-engineering`;
- no unreviewed BLOCKER/IMPORTANT findings;
- no accidental secrets/generated/unrelated changes;
- stated limitations are explicit, not hidden behind PASS wording.
