# Completion evidence record

Для каждого claim запиши:

Record operation scope (`task / integrated-source / release-publication / release-withdrawal`), full SHA/tree and proof provenance. Keep pinned develop base, approved task SHA, actual squash-integrated develop SHA and release candidate/version/old-master/inventory identities as separate fields; unavailable fields are `N/A`/`NOT_INTEGRATED`, never guessed. Drift invalidates affected evidence.

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
- docs-worthy change has affected-owner README/.env.example sync evidence from `ebb-maintain-project-docs`; changed-scope sync never asserts full project audit;
- integrated-source claim has fresh mandatory local/CI gates at actual squash SHA; task PASS alone is insufficient;
- publication/withdrawal evidence follows explicit `ebb-release` operation contract, not automatic completion;
- withdrawal safety covers exact identities/provenance, permissions/deletability, supported tool/regression and applicable local/CI checks; a broken withdrawn app suite is not a requirement to turn green. No data/deployment rollback is implied.
