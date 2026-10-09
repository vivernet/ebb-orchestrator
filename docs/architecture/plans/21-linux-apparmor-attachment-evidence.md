---
id: plan-21
kind: plan
status: proposed
title: Проверяемое Linux AppArmor attachment evidence
summary: Добавить ограниченный versioned evaluator compiled AppArmor xmatch для Linux Task5A-WL, сохраняя fail-closed поведение для неизвестных ABI и форматов.
created: 2026-10-09
updated: 2026-10-10
depends_on: []
specs:
  - ../specs/01-system-design.md
evidence:
  - ../proposals/16-linux-apparmor-attachment-evidence.md
  - 20-production-context-manifest.md
  - ../../../.github/workflows/production-gates.yml
  - ../../../scripts/linux-hermes-namespace-prerequisite.sh
  - ../../../scripts/linux-hermes-namespace-prerequisite.test.mjs
---

# Проверяемое Linux AppArmor attachment evidence — draft implementation plan

> **Статус:** `proposed`, не одобрен для исполнения целиком. Разрешён только ограниченный F0 feasibility task: подготовка и review maintained read-only probe в существующем Linux CI. Реализация matcher/parser, изменение Linux admission, Tasks1–T5 и обновление статусов Plan20/19 запрещены до полного F0 evidence, заполнения ABI-специфичных решений, независимого security/architecture review обновлённого плана и отдельного approval пользователя.

**Goal:** Разблокировать Linux часть Plan20 Task5A-WL только для явно поддержанных compiled AppArmor attachment representations, доказывая непересечение каждого foreign profile с каждым точным helper/probe path и сохраняя отказ для любого неизвестного или неоднозначного случая.

**Architecture:** Новый versioned evaluator — чистая bounded функция над уже собранным in-memory snapshot и точными target path bytes. Отдельный acquisition boundary читает текущую kernel policy snapshot, проверяет `raw_sha256` для каждого точного сериализованного export/load, а затем связывает его с live profile inventory только по доказанному mapping; digest не приписывается отдельным profile, если ABI этого не доказывает. Namespace identity/revision связывает всю выборку и проверяется повторно до использования результата. Evaluator воспроизводит pathname matching kernel `aa_dfa_leftmatch`; он не читает файловую систему, не выполняет команды и не меняет policy. Существующий `scripts/linux-hermes-namespace-prerequisite.sh` остаётся владельцем Linux acceptance lifecycle и ephemeral setup; его текущая fail-closed проверка `<unknown>` заменяется только после того, как весь новый evidence pipeline пройдёт live hosted acceptance.

**Authority:** Утверждённый пользователем Option C из [Proposal16](../proposals/16-linux-apparmor-attachment-evidence.md), `spec-01`, существующий Linux scope/cleanup contract в Plan20 Task5A-WL. Plan21 — отдельный prerequisite/support plan, не часть Plan20 metadata: Plan20 Task5A-WL может потребить его Linux acceptance, но Plan21 не зависит от завершения Plan20. Не добавлять Plan20→Plan21 или Plan21→Plan20 plan-level edge; это предотвращает цикл и не меняет Plan20.

**Global Constraints:** Не менять host ACL/permissions, global policy, sysctl, systemd services, cache, secrets, network или чужие профили. Не загружать/удалять/перезагружать policy ради анализа. Не сохранять, логировать, публиковать или прикладывать сырые kernel policy bytes: они существуют только в памяти одноразового hosted runner во время проверки. Не выводить profile names, paths из profiles или raw payload; допустимы только ограниченные reason codes, version/ABI identifiers, counts, hashes и классификации. `NO_PATH_MATCH` для всех профилей и целей — единственный разрешающий результат. `PATH_MATCH`, `UNSUPPORTED`, malformed/truncated/trailing bytes, unknown version/flag/table/encoding, missing export/hash, race, timeout или cap hit означают отказ до дальнейшего setup. Нельзя использовать regex/glob approximations, profile names, source certificates, labels, успешный `exec` или собственный approximate matcher как production evidence.

**Specialist Constraints:** Security-sensitive parser: требуется `ebb-security-review`, независимый task review и whole-change review. Exact matcher semantics и supported encodings должны быть сверены с version-pinned Linux kernel source и дифференциальным oracle. Test oracle не импортирует production evaluator и реализует semantics независимо по exact reviewed kernel sources.

**Review Focus:** Звено `raw_sha256` → точные in-memory bytes → version dispatch → kernel-equivalent pathname matcher → unchanged namespace/revision must be complete and race-safe. Ни один parse/ABI/table/permission uncertainty не должен превращаться в `NO_PATH_MATCH`. Hosted Linux PASS должен быть свежим и live; parser fixtures и seeded profiles сами по себе не меняют Plan20 Task5A-WL status.

## Предварительный блокер до approval плана

### Gate F0 — persistent read-only raw-ABI feasibility (before parser-plan approval)

F0 is a prerequisite evidence task, not an evaluator implementation and not approval to change Linux admission behavior. The previous one-shot probe is retired and must not be recreated or retried. Its run `37939852804` stopped at `F0_NAMESPACE_UNAVAILABLE` before profile enumeration or raw reads, so it provides no ABI evidence. A replacement must be a normal, maintained, read-only feasibility check in the existing Linux production-gates job; no disposable branch, one-shot run-number guard, or standalone privileged workflow.

Start with metadata-only diagnostics that do not require an AppArmor namespace. Report the runner image/kernel package identity and revision, AppArmor enablement/version, parser package identity/version, export configuration, and the exact kernel source revision controlling the exported format and `aa_dfa_leftmatch`. Only if the runner exposes a reviewed read-only raw export should the probe inspect it. The collector must use pinned descriptors and no-follow identity checks, bounded in-memory reads, fixed refusal codes, suppressed exception details, and no persistent outputs. It must not load/remove/reload profiles or alter ACLs, policy, services, sysctls, ownership, permissions, credentials, cache, or runner configuration. Raw bytes, profile names, and policy paths must not enter logs, files, artifacts, cache, workflow outputs, or job summaries.

The feasibility report must establish what each exported hash binds (an individual profile or a complete serialized load), how each exported load maps to live profile inventory, the exact ABI/version/encoding, supported feature/table identifiers, the source-pinned binary structure, and whether a stable namespace/revision can be sampled before and after reads. Keep digest verification at the granularity actually established by the ABI; report profile mapping as separate evidence and never copy a load digest onto its member profiles. Report only allowlisted identities, bounded counts, aggregate SHA-256 values, and fixed classifications. Do not assume that a per-profile `raw_sha256` proves the bytes of an entire load, or that an upstream kernel source version matches the hosted Ubuntu kernel. No matcher result is emitted by this feasibility task.

**Current evidence:** Hosted run `37929857217`, job `113817636201`, SHA `c587fb918d90507ae9300d336f39179d2dd5e684` reached `SNAPSHOT` and failed with `HERMES_NAMESPACE_SETUP_POLICY_ATTACHMENT_UNKNOWN`; it lacks exact kernel/package source revision, AppArmor/parser version, export configuration, raw ABI, and raw payload/hash binding. The retired run `37939852804`, attempt 1, SHA `433b20ee36551eeaeeb99895b268e67a31a1049c`, Ubuntu 24.04.5 image `20261004.327.1`, runner `2.337.0`, emitted `F0_NAMESPACE_UNAVAILABLE` before enumeration/read. Linux v6.17's `/sys/kernel/security/apparmor/policy/raw_data/<id>/raw_data` remains a source-backed candidate only; availability and schema on the hosted runner are unverified. Keep Linux admission fail-closed.

**Review and execution:** First implement the permanent probe/tests with metadata-first behavior and no fake matcher verdict. Obtain an independent security review of the exact code/workflow change, then run the existing push-triggered Linux job on its exact SHA. The probe is a required diagnostic step before the current namespace-dependent prerequisite, and its sanitized output must not expose profile data. A failed/unavailable read remains a meaningful FAIL/BLOCKED result; the maintained probe can be corrected and rerun on a later SHA under the normal workflow. It must never claim Linux acceptance or parser feasibility unless exact raw bytes, their authoritative hash binding, profile/load cardinality, revision stability, exact source/ABI, and bounded format are all demonstrated. No policy setup or native acceptance occurs on a feasibility-only success.

Only after this evidence exists may Tasks 1–3 define the allowlist, acquisition path, and immutable evaluator limits. Limits must be justified for the declared supported Linux scope from format/source bounds and operational requirements; one runner's observed maxima are insufficient. If raw bytes/hash binding or exact source identity cannot be established safely, retain the existing fail-closed gate and mark Plan21 blocked; do not guess an ABI or weaken Linux acceptance.

## File / interface map

| Owner | Files | Responsibility |
|---|---|---|
| F0 — maintained raw-ABI feasibility | Create `scripts/linux-apparmor-raw-policy-feasibility.py` and its synthetic contract tests; modify the existing Linux job in `.github/workflows/production-gates.yml` | Metadata-first, bounded read-only feasibility evidence with sanitized output; runs as part of the normal production workflow before namespace-dependent acceptance. It never evaluates target-path matching. |
| Task 1 — pure evaluator | Create `scripts/linux_apparmor_attachment_evidence.py`; Create `scripts/test_linux_apparmor_attachment_evidence.py` | Versioned byte parser, bounded representation decoder and pure pathname evaluator; deterministic synthetic binary vectors and tests. ABI allowlist remains BLOCKED until F0. |
| Task 2 — test-only oracle | Create `scripts/test_linux_apparmor_xmatch_reference.py` | Independent bounded reference matcher derived from exact reviewed kernel source; oracle is not imported by production and emits no OS/policy changes. |
| Task 3 — live snapshot acquisition and binding | Modify `scripts/linux-hermes-namespace-prerequisite.sh`; Modify `scripts/linux-hermes-namespace-prerequisite.test.mjs` | Read bounded raw bytes into memory, validate raw digest, bind to namespace identity and revision, call pure evaluator and recheck the same policy snapshot before continuing. Keep cleanup/error behavior. |
| Task 4 — existing Linux CI integration | Modify `.github/workflows/production-gates.yml` | Add unit/differential test step to the existing `process-scope-linux-acceptance` job; preserve one job, its push-only hosted-runner boundary, existing ephemeral namespace setup and cleanup. |
| Task 5 — acceptance and evidence | Modify `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md` only after hosted PASS | Record exact workflow run/job/SHA, kernel/parser/ABI identifiers, sanitized digest/count output, all acceptance commands/results, and downstream Plan20 Task5A-WL consumption status. No status/checklist or generated roadmap updates before their own evidence gate. |

### Public pure interface

`evaluate_attachment_evidence(snapshot, targets, limits) -> EvidenceResult`

- `snapshot`: in-memory object for one authenticated kernel export, with an explicit load/profile mapping proven by the feasibility task. Do not assume one export hash corresponds to one profile. Profile names and attachment strings are not trusted as matcher evidence. Exact raw bytes remain in memory; the function never opens paths or performs I/O.
- `targets`: exactly the two path byte strings already produced by `profile_targets(...)` in the current prerequisite script; byte equality is preserved, no locale/Unicode normalization or shell interpretation.
- `limits`: immutable `APPARMOR_XMATCH_LIMITS_V1` constants selected and recorded after F0; callers cannot increase limits per invocation.
- `EvidenceResult`: `{ evidenceVersion, namespaceId, revision, exports: [{ rawSha256, profileResults: [{ profileIdentityDigest, targetResults: ["NO_PATH_MATCH" | "PATH_MATCH" | "UNSUPPORTED"] }] }] }` or a stable bounded refusal code. `rawSha256` belongs to the serialized export/load; it is not copied into or attributed to profile results. `profileIdentityDigest` is a bounded opaque identity derived from the authoritative inventory, not a display name or policy path. The exact export-to-profile mapping must be established at F0. The result never includes raw bytes, profile names, source text, or raw parser exceptions.
- The caller verifies each exported digest against the exact byte stream it authenticates, using the load/profile cardinality established by F0; compares stable kernel namespace/revision evidence before and after collection/evaluation; and rejects missing/duplicate identities, missing bytes, and any revision change. The exact digest-to-profile mapping and revision mechanism remain blocked until F0 evidence.

### Bounded v1 policy

Candidate hard ceilings for v1: at most 4096 profiles; at most 8 MiB per raw export; at most 64 MiB total raw bytes; at most 2 target paths, each 4096 bytes; at most 262144 DFA states and 1048576 transitions per decoded profile; at most 4194304 transitions across the snapshot; bounded equivalence classes/loop table sizes derived from the same byte/count caps; at most 67108864 deterministic transition steps across all profile/path pairs; fixed wall-clock deadline 2 seconds for one evaluator call. These are proposals, not approved limits. F0's live evidence plus source/format bounds must justify them for declared supported Linux scope or narrow that scope. Any exceeded limit returns refusal/`UNSUPPORTED`, never partial acceptance. Do not silently tune a runtime config.

**BLOCKED design detail:** F0 has not established raw payload layout, table encoding, permission encoding, digest-to-profile cardinality, stable revision semantics, or whether current-runner payloads fit these proposed ceilings. These are not implementation assumptions. The plan cannot be approved until an amendment replaces this paragraph with the exact allowlisted format and evidence-based v1 limits, or retains fail-closed Linux refusal with no parser implementation.

## Task DAG

```text
F0 maintained feasibility probe + review ──> normal hosted Linux run ──[ABI evidence gates plan approval]──┐
                                                                                                          ├─> T1 pure parser/evaluator ──┬─> T3 live snapshot binding ─> T4 existing hosted job integration ─> T5 acceptance/review
                                                                                                          └─> T2 independent oracle/vectors ─┘
```

No dependency points to Plan20 as a plan. Plan20 Task5A-WL is a downstream consumer of Task5 acceptance. Plan20 statuses/checklists remain unchanged until Task5 has fresh live hosted evidence and its existing review gates pass.

## Tasks

### F0: Add and run maintained sanitized raw-ABI feasibility check

**Depends on:** None.

**Create / Modify / Test:** Create maintained `scripts/linux-apparmor-raw-policy-feasibility.py` and synthetic contract tests; modify `.github/workflows/production-gates.yml` so the existing Linux job runs the check before the namespace-dependent prerequisite. Do not create a disposable branch or standalone privileged workflow. The probe starts with metadata-only diagnostics that do not require an AppArmor namespace; raw export inspection is attempted only after reviewed descriptor/root checks. Locally test metadata allowlists, bounded reads, stable refusal codes, exception suppression, and workflow ordering with synthetic fixtures. No policy, service, sysctl, ACL, credential, network, or runner configuration mutation.

**Interfaces:** A single sanitized JSON line on stdout: allowlisted runner/kernel/AppArmor/parser identities, export config booleans, raw ABI/encoding IDs, bounded profile/export/byte counts, count of exported objects whose bytes match their authoritative `raw_sha256`, separate evidence-backed export-to-profile mapping counts, and aggregate digest. No per-profile identifiers, paths, names, or raw bytes. The initial metadata-only probe runs unprivileged and reads no policy export. Raw-export inspection may be added only after independent review establishes its exact source-backed path and safe descriptor contract; that phase may use one bounded root invocation with only `ImageOS` and `ImageVersion` preserved. Shell tracing and core dumps are disabled and command stderr is discarded. Python runs isolated/no-bytecode, uses no writable paths, outputs/artifacts/cache/job summaries or network calls, and catches every exception to return a fixed code without traceback. Raw data are read in bounded chunks, hashed in process memory, and never serialized.

**RED / current result:** Existing Linux hosted run `37929857217`, job `113817636201`, failed before parser preflight with `HERMES_NAMESPACE_SETUP_POLICY_ATTACHMENT_UNKNOWN`; it recorded no raw ABI evidence. The retired one-shot run `37939852804`, attempt 1, commit `433b20ee36551eeaeeb99895b268e67a31a1049c` ([run](https://github.com/vivernet/ebb-orchestrator/actions/runs/37939852804)), Ubuntu 24.04.5 image `20261004.327.1`, runner `2.337.0`, emitted `F0_NAMESPACE_UNAVAILABLE` before profile enumeration/raw payload reads. It proves neither raw export availability nor ABI/hash evidence. Its branch and temporary files were removed; never recreate or retry that flow. The replacement is a maintained metadata-first check under the normal production workflow.

**GREEN:** An independent security reviewer approves the exact probe/workflow diff. On the normal hosted Linux job, metadata-first diagnostics complete; if raw export is available, every discovered export is read within bounds and its digest binding/cardinality is verified without exposing raw data. A source-backed feasibility review identifies exact kernel source/package, parser source, ABI/encoding set, and raw export endpoint. This task can be corrected and rerun on a later commit under the normal workflow. A green feasibility check proves only ABI facts, not Linux Task5A acceptance or parser approval. Do not call F0 green if it depends on guessing a path, storing raw bytes, changing permissions/policy, or relying on a runner label alone.

**Review Focus:** Before run, verify no raw-data sink exists in stdout/stderr, traceback, temp/core files, artifacts/cache, job summary or workflow outputs; verify the single root invocation performs read-only access to only the exact AppArmor export, is symlink-confined and bounded, and changes no permission or policy. After run, determine whether there is an authoritative read-only path from each exported object to its exact serialized bytes and `raw_sha256`, and separately whether each export maps to live profile inventory; whether namespace/profile identities are stable enough to bind; whether the actual runner ABI maps to reviewed kernel matcher source. Do not infer ABI solely from AppArmor parser version.

**Completion evidence:** Workflow run/job/SHA, runner image/kernel/AppArmor/parser revisions, sanitized ABI/format inventory, aggregate raw digest-binding result, bounded profile/load counts and sizes, source references, and reviewer determination. Report contains no profile names, target paths originating in policy, or raw data. For failure, preserve only the sanitized fixed code and run metadata; do not infer hidden fields. Keep the maintained probe for future normal CI runs.

**BLOCKED when:** raw bytes are unavailable/read requires mutation, runner's exact kernel source/format cannot be identified, raw digest cannot be tied to the correct serialized object, any persistent output path cannot be excluded, a cap is reached, or an ABI/permission representation remains unenumerated. Until F0 is accepted and the amended plan independently reviewed and user-approved, no parser implementation starts and Linux admission remains fail-closed.

### Task 1: Implement the versioned bounded pure evaluator

**Depends on:** F0 PASS; this amended plan independently `APPROVED`.

**Create:** `scripts/linux_apparmor_attachment_evidence.py`; `scripts/test_linux_apparmor_attachment_evidence.py`.

**Interfaces:** Implement the pure `evaluate_attachment_evidence(snapshot, targets, limits)` interface above. Dispatch only on the exact ABI/encoding allowlist added from F0. Parse typed stream boundaries, payload lengths, version/feature flags, DFA tables, transitions, equivalence classes, loops, diff/default transitions, and versioned permission data without accepting trailing or duplicate fields. Permission decoding is validated even though path allow/deny bits do not affect the conservative attachment pathname decision. Match exact target pathname bytes with the reviewed kernel revision's exact `aa_dfa_leftmatch` transition and acceptance semantics. Return `NO_PATH_MATCH` only after the full supported representation is validated and every target is proven disjoint; return `PATH_MATCH` on any path match; malformed/unsupported/ambiguous input returns a stable refusal.

**RED:** First add tests in `scripts/test_linux_apparmor_attachment_evidence.py`; run `python3 scripts/test_linux_apparmor_attachment_evidence.py`. Expected: test import fails because `linux_apparmor_attachment_evidence.py` is absent. After adding the minimum test helpers and interface shell, expected focused cases fail on unimplemented ABI decode/matching.

**GREEN:** `python3 scripts/test_linux_apparmor_attachment_evidence.py` exits 0 and reports all deterministic vectors passing. Every malformed/truncated/trailing/unknown-tag/unsupported-ABI/overflow/cap-hit vector refuses; there is no parse exception escape or partial result.

**Limits:** Use only the immutable post-F0 `APPARMOR_XMATCH_LIMITS_V1`; enforce byte/count/work/deadline limits before allocation or iteration. No filesystem, process, network, policy, environment, logging, or secret APIs in this module.

**Review Focus:** Kernel exact transition semantics, integer overflow, table offset validation, pointer/length arithmetic, resource accounting, error normalization, no approximate regex interpretation, no “unknown means no match” branch.

**Completion evidence:** Source-pinned ABI support matrix; exact tests/vector inventory; test output/count; static import/API audit proving evaluator has no I/O/mutation capabilities; independent security review of parser bounds and every accepted encoding.

**BLOCKED when:** A representation/table/flag is absent from the reviewed matrix, limits are exceeded, source evidence disagrees with parser behavior, or any result would require approximate interpretation. Add support only by revising the versioned allowlist, fixtures, plan and review.

### Task 2: Add an independent kernel-semantics oracle and differential vectors

**Depends on:** F0 PASS; Task1's ABI matrix and interface amendment.

**Create:** `scripts/test_linux_apparmor_xmatch_reference.py`.

**Interfaces:** Test-only oracle accepts raw bytes, the exact allowlisted ABI identifier and target bytes, and independently parses/implements the kernel matcher from the exact reviewed source revisions recorded after F0. It must not import production parser/matcher code or consume its decoded transition model. Deterministic synthetic raw vectors are constructed in test code from reviewed binary layout; no raw live policy dump is saved. The oracle returns only a match/no-match boolean and bounded error for the same path bytes.

**RED:** Add reference vectors before production assertions; run `python3 scripts/test_linux_apparmor_xmatch_reference.py`. Expected: source-derived cases expose any mismatch with the current implementation and prove edge vectors for accepting state, prefix/leftmatch, no transition, diff/default chain, loop, EC remapping, and exact target bytes.

**GREEN:** Run both `python3 scripts/test_linux_apparmor_xmatch_reference.py` and `python3 scripts/test_linux_apparmor_attachment_evidence.py`; all supported deterministic vectors agree across independent oracle and evaluator. Every vector has a source citation/line or function pointer to the exact reviewed kernel revision.

**Review Focus:** Oracle independence; no shared helper that duplicates production defects; exact treatment of `aa_dfa_leftmatch`; path bytes with non-ASCII/opaque bytes and NUL rejection; transition boundary behavior; differential mismatch must be a hard test failure.

**Completion evidence:** Machine-readable vector manifest containing case ID, synthetic input digest, expected oracle result, evaluator result, and kernel source revision; no live raw policy bytes in the repository or CI artifacts.

**BLOCKED when:** The supported kernel source cannot be independently pinned, oracle semantics are ambiguous, a mismatch remains, or the only passing evidence uses hand-selected evaluator outputs.

### Task 3: Bind live raw-policy collection to kernel hash and revision

**Depends on:** Tasks1–2; F0 PASS.

**Modify:** `scripts/linux-hermes-namespace-prerequisite.sh`; `scripts/linux-hermes-namespace-prerequisite.test.mjs`.

**Interfaces:** The existing snapshot collector reads raw payloads only from the exact export path established at F0. It verifies the kernel digest against the exact serialized object it authenticates, then applies the evidence-backed load-to-profile mapping; it must not compare a whole-load digest to an assumed per-profile byte stream. Open new nonblocking revision descriptors for before/after comparisons when the kernel export is stateful; do not reuse a read-to-EOF descriptor as proof of a stable revision. Namespace identity and policy revision are captured before and after collection/evaluation; any changed identity/revision invalidates every result. Missing/duplicate identities, malformed links, exports outside the pinned policy root, unsupported digest cardinality, and hash mismatch refuse before evaluator output can authorize. Raw bytes remain in process memory and are never printed or serialized into files.

**RED:** Add shell-contract regressions and in-memory snapshot harness cases, then run `node --test scripts/linux-hermes-namespace-prerequisite.test.mjs`. Expected failures: current script neither reads exact raw bytes nor verifies bytes against `raw_sha256`; race/hash cases fail.

**GREEN:** The script contract suite passes and proves refusal on changed revision, namespace mismatch, digest mismatch, missing/duplicate profile, export link/path mismatch, oversized input, evaluator timeout, and any unsafe result. Existing ephemeral userns setup and teardown checks remain intact.

**Review Focus:** Raw data is never logged, persisted or exported as artifact; raw-hash link resolution is nofollow and same-kernel-namespace bound; revision is checked after evaluator completes but before policy mutation; parser is a separate pure module and cannot acquire filesystem authority.

**Completion evidence:** Synthetic snapshot cases; source readback of acquisition sequence; captured sanitized run output; unit/contract tests; independent security review of hash and revision binding.

**BLOCKED when:** Kernel export identity cannot be safely opened, reading requires relaxing host permissions or policy, stable before/after revision cannot be proved, raw bytes leak to persistent/diagnostic channels, or the implementation would widen existing sudo scope.

### Task 4: Integrate unit/differential checks into the existing Linux hosted job

**Depends on:** Tasks1–3; independent task-level security review with no blocking findings.

**Modify:** `.github/workflows/production-gates.yml` only in existing `process-scope-linux-acceptance` job.

**Interfaces:** Add an explicit step invoking `python3 scripts/test_linux_apparmor_attachment_evidence.py` and `python3 scripts/test_linux_apparmor_xmatch_reference.py` before the namespace prerequisite can create/load its ephemeral profiles. Do not add another Linux job, change push-only runner boundary, use WSL/self-hosted runner, add raw policy artifacts, or suppress errors. The existing `Validate Linux namespace prerequisite contract`, build, acceptance and teardown steps remain authoritative.

**RED:** `node --test scripts/linux-hermes-namespace-prerequisite.test.mjs` must fail before the workflow change on exact required-step contract assertion once that assertion is added; verify no duplicate `process-scope-linux-acceptance` job is present.

**GREEN:** `pnpm docs:check` and `node --test scripts/linux-hermes-namespace-prerequisite.test.mjs` exit 0; workflow readback shows one Linux process-scope job and both checks execute before setup. No CI result is claimed until the job runs on hosted Linux.

**Review Focus:** Ordering before policy setup; no artifact upload or raw-byte echo; no continue-on-error, skip, mocked replacement or runner fallback.

**Completion evidence:** Workflow diff, contract-test output, docs check, and link to exact hosted run/job on final implementation SHA.

**BLOCKED when:** The job cannot execute the tests before setup, requires storing raw policy, duplicates the runner job, or changes the existing acceptance authorization boundary.

### Task 5: Pass live hosted Linux acceptance and hand evidence to Plan20 Task5A-WL

**Depends on:** Tasks0–4; all focused and repository-required gates; independent security/task review.

**Modify:** `docs/architecture/plans/governance/evidence/07-current-plan-reconciliation.md` after a fresh hosted pass. No Plan20 edits or status/checklist/generated roadmap changes in this task.

**RED:** The existing recorded Linux run `37929857217` is a baseline failure `HERMES_NAMESPACE_SETUP_POLICY_ATTACHMENT_UNKNOWN`, not a regression RED and not a pass. No local WSL run may substitute.

**GREEN / acceptance:** Run the normal existing push-triggered hosted workflow `.github/workflows/production-gates.yml` on the final reviewed SHA. Expected `process-scope-linux-acceptance` succeeds from prerequisite through native process-scope/source-snapshot suites and `Record successful Linux owned-scope acceptances`; its `always()` cleanup verifies teardown. Confirm the run's Linux job includes the new parser unit tests, exact supported kernel/AppArmor/raw ABI metadata, every foreign profile mapped to an authenticated export and individually proved `NO_PATH_MATCH` for both exact targets, digest verification at the export/load granularity established by F0, stable namespace/revision, successful ephemeral setup/STOPPED/cleanup, and no raw policy bytes in logs/artifacts. Any `PATH_MATCH`, `UNSUPPORTED`, cap hit, malformed input, revision race, setup/cleanup ambiguity or hosted failure is FAIL/NOT VERIFIED.

**Required quality commands:** `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm build`; `pnpm docs:check`; `pnpm docs:test`; `git diff --check`. Expected exit 0 and clean generated-artifact inventory; record exact SHA and results.

**Review Focus:** Live hosted policy evidence, not synthetic parser vectors, proves the gate; exact native scope process remains contained and STOPPED before cleanup; no success claim based solely on the evaluator; no Plan20 lifecycle status is changed prematurely.

**Completion evidence:** Exact commit SHA; workflow run/job IDs; system/kernel/parser/raw ABI identifiers and only sanitized counts/digests; evaluator/oracle test summaries; Linux native and cleanup step outcomes; quality command exit codes; security review and whole-change review verdicts; diff/status readback. After evidence is recorded, Plan20 owner may consume the Linux Task5A-WL result through Plan20's own fresh review/checklist process. Plan21 completion does not itself change Plan20 status.

**BLOCKED when:** Hosted Linux is unavailable, policy snapshot is unsupported, acceptance fails or is not run, a required review is incomplete, any quality gate fails, or sanitized evidence cannot prove the complete chain. Keep Linux fail-closed and retain Plan20 Task5A-WL as NOT VERIFIED; do not mark Plan21 complete.

## Review and lifecycle gates

1. F0 alone may be implemented before approval of the full Plan21 because it is a bounded feasibility prerequisite. Independently review the exact probe/test/workflow diff before hosted execution. Use the existing normal production workflow; do not recreate the retired one-shot workflow.
2. F0 PASS requires exact kernel/parser sources, raw ABI and format, hash-to-export and export-to-profile cardinality, stable snapshot/revision mechanism, and evidence-backed safe limits. Metadata-only success is not F0 PASS.
3. Amend Tasks1–3 with the exact evidence. Independent `ebb-review-plan` must return `APPROVED` on the amended exact implementation plan, followed by separate user approval. Every amendment requires another fresh review; Option C approval is not Plan21 implementation approval.
4. Until step 3 completes, do not implement the parser/matcher, change Linux admission behavior, run policy-mutating acceptance, or update Plan20/Plan19 statuses. Any F0 uncertainty leaves Linux fail-closed.
5. After implementation, obtain task-level security review, independent code/recovery/architecture review and whole-change review. Any blocking finding returns to its owning task and requires rerun of affected tests and live hosted gate.
6. Plan21 may be marked `completed` only after Task5 evidence and all required gates pass. Plan20's Task5A-WL, Plan20, Plan19 or downstream statuses remain separately controlled by their own acceptance/review criteria.

## Completion criteria

- A source-pinned and evidence-bounded ABI allowlist covers only the exact runner representations proven at F0.
- The evaluator is deterministic, pure, versioned, resource-bounded, byte-exact and matches the reviewed kernel pathname matcher; every unknown/failure mode refuses.
- Live raw bytes are hash-bound to their exact exported object at the granularity established by F0; a separately evidenced export-to-profile mapping and namespace revision bind the matcher result to each profile. Bytes remain ephemeral in memory and never enter logs, files, artifacts, prompts, APIs or persisted evidence.
- Existing Linux prerequisite uses the evaluator before any continuation, while preserving current setup ownership and cleanup/STOPPED contract.
- The existing hosted Linux job passes on final SHA with parser/oracle tests, native acceptance and teardown; no mock/fixture substitute is represented as live acceptance.
- Focused, root quality, security, task, whole-change and whole-plan reviews pass; only then may Plan21 complete. Plan20 status is not changed by this plan alone.
