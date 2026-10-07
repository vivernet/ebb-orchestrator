---
id: proposal-10
kind: proposal
title: Durable Hermes same-Run recovery
status: proposed
created: 2026-10-07
updated: 2026-10-07
---

# Proposal 10 — Durable Hermes same-Run recovery

**Status:** Design update for approved Proposal 08; preserves the approved same-Run/same-session behavior.

## Goal and non-goals

Make Plan20's approved recovery behavior implementable across Orchestrator restarts while retaining the original logical `Run`, Hermes `session_id`, context manifest, capability, and scheduler reservation until the resumed Run completes or is safely terminalized.

This proposal does not change provider ownership, Hermes-native authentication, the approved resume behavior, or the rule that every process scope needs authoritative full-scope `STOPPED` evidence. It does not permit credentials, prompt text, context text, endpoint URLs, or secrets in recovery metadata.

## Current state

- `run_process_owners` has one row per `run_id`; its `STOPPED` state is terminal.
- Task5B stores session capture validity in sticky `capture_state` and the original session ID in `agent_runs.session_id`.
- Startup process-owner preflight precedes ordinary recovery, but `RunService.reconcileInterruptedRuns()` then marks every interrupted active Run `FAILED`, sets terminal output/timestamps, and clears capability. Scheduler reconciliation releases reservations for terminal Runs.
- `RunService.resumeRun()` accepts only active Runs with their capability, so the same logical Run cannot resume after that reconciliation.
- The existing manifest does not retain every safe typed input needed to recompute the exact `context_hash` after restart. Inferring omitted inputs from prompt/output, Hermes stores, current configuration, or guessed defaults is forbidden.

## Decision

Keep the approved same-Run/same-session behavior and separate the stable logical Run binding from successive OS process-scope generations.

Add a forward migration (next ID after the current repository head) with:

1. A durable `run_process_owner_generations` table keyed by `(run_id, generation)` is the canonical record of every process scope. It stores exact process identity and state: nullable `run_attempt` where historically unknown, containment kind/ID, launch nonce, supervisor/process/systemd identities, state, stop evidence, and timestamp. It references `agent_runs(id)` with `ON DELETE CASCADE`; containment IDs and nonces remain unique across generations. Existing owner data is copied exactly into generation 1 without synthesizing missing values. The existing `run_process_owners` row remains the stable per-Run binding for Hermes `source_tag`, `hermes_home`, source-snapshot key, and sticky capture validity, and gains `current_generation`; its existing process fields remain a transactionally maintained projection of the selected generation for compatibility. On every transition, the canonical generation row and current projection must be updated atomically and cross-checked on read. A STOPPED generation is immutable.
2. A per-Run `run_resume_bindings` row containing `schema_version=1`, canonical RFC 8785 JCS bytes for `ContextResumeBaselineV1`, the original `context_hash`, and a separate workspace snapshot. The baseline contains exactly the safe `ContextFingerprintInputV1` fields except `workspaceIdentity`: `promptHash`, `subjectType`, `subjectId`, `contractOrRequestDigest`, `items`, `contextBuilderVersion`, `role`, `roleVersion`, `runtime`, `runtimeVersion`, `model`, `modelVersion`, `outputSchemaVersion`, `contextVersion`, `targetHead`, `targetBranch`, `effectiveCapabilityIds`, `projectConfigRevisionId`, `projectConfigHash`, and `policyIdentity`; nested fields are exactly `items[{id,version,digest}]` and `policyIdentity{providerId,providerPolicyId,runtimeId,runtimePolicyId}`. Preserve nullable values and sort arrays using `digestRunContextV1()` semantics. The selected model is represented by `model`/`modelVersion`; source-backed non-secret provider/endpoint/auth-policy revisions map to existing `providerPolicyId`/`runtimePolicyId` semantics without adding keys or storing a URL. Do not persist `workspaceIdentity` or any absolute workspace path in this table. On recovery, resolve the current canonical `workspaceIdentity` from its existing authoritative Project/repository/worktree records, reconstruct the exact `ContextFingerprintInputV1`, and call `digestRunContextV1()` with no added fields. Missing/ambiguous source values fail closed; any changed identity makes the result differ from the original manifest `context_hash`. Test byte-for-byte reconstruction against the manifest.

   The binding separately contains `WorkspaceSnapshotV1` with `version=1` and a digest; workspace content is not added to `context_hash`. Version 1 uses the exact configured workspace-tool root, does not follow symlinks, excludes `.git` internals but records current HEAD and index-tree identity, and covers staged, unstaged, untracked, and ignored regular files accessible to workspace tools. For each sorted normalized relative path, the in-memory record contains file class (`tracked`, `untracked`, or `ignored`), mode, Git staged/unstaged state, and available HEAD-blob, index-blob, and working-tree SHA-256 values; untracked/ignored files have a working-tree digest. JCS-canonicalized records plus the HEAD/index identity are hashed with `ebb-run-workspace-v1\0`. Raw paths and records are not persisted. An inaccessible path, path escaping the boundary, symlink, or special file inside the enumerated boundary fails closed. A separate `resume_binding_hash` is SHA-256 over JCS `{schemaVersion, runId, contextHash, workspaceSnapshotVersion, workspaceSnapshotHash}` with domain separator `ebb-run-resume-binding-v1\0`, binding the Run, context hash, and workspace check without changing the existing context hash. No prompt/context text, raw URL, credential, auth material, or absolute workspace path is retained. Existing Runs without a complete source-backed baseline are not backfilled and remain ineligible for resume.
3. The stable owner row gains a `current_generation` pointer initialized to 1. Before a new process scope can launch, one transaction verifies the current generation is authoritatively `STOPPED`, appends generation N+1 with fresh containment ID/nonce in `PREPARED`, and updates the current-generation pointer/projection. All owner transitions and callbacks compare `(run_id, generation, run_attempt, containment_id, launch_nonce, expected_state)`; old callbacks cannot mutate a newer generation. The scheduler's run attempt and generation are stored separately and their correlation is checked, never inferred.

The migration is additive. Do not edit migrations 037–040, rebuild/copy `context_deltas`, or alter its rows, indexes, foreign keys, delete actions, or diagnostic-only semantics. Run/session identity stays in the existing `agent_runs` and owner binding; `capture_state=INVALID` remains sticky across generations.

## Recovery ordering and failure model

1. Acquire the existing single-instance lock, complete migrations, and enter RECOVERING.
2. Inspect every current process generation. Only authoritative full-scope `STOPPED` proof permits recovery; UNKNOWN, inaccessible, or escaped scope retains owner/capability/reservation and blocks startup recovery.
3. Before blanket interrupted-Run terminalization, identify candidates from durable SQLite state and verify `capture_state=BOUND`, `agent_runs.session_id`, the canonical resume binding, manifest, exact current provider/runtime policy identity, and complete accessible workspace fingerprint. Recompute the context hash; never trust a persisted eligibility flag by itself. Ineligible interrupted Runs use existing terminal reconciliation only after STOPPED proof; an UNKNOWN scope remains retained and fail-closed.
4. A candidate may be durably marked recovery-pending, but startup does not dispatch Hermes before System READY. The existing lifecycle reaches READY only after all mandatory startup reconciliation completes. After READY, ordinary Scheduler dispatch claims the same Run by CAS and applies normal permission, approval, budget, and capacity gates. It reuses the existing reservation exactly once; it neither creates a second reservation nor bypasses Scheduler. If the existing reservation or required gates are invalid, recovery fails closed and reconciles the Run after stop proof.
5. Before dispatch, atomically prepare generation N+1 and increment the Run attempt while preserving the original session/capture/binding. Recapture a fresh native Hermes path ticket, then dispatch exactly one `--resume <session_id read from SQLite>` after revalidating fingerprints and workspace.
6. The resumed generation's live `system/init.session_id` must equal the original SQLite session ID and correlate to generation N+1, attempt, containment ID, and launch nonce. A mismatch atomically makes capture `INVALID`, clears resume eligibility, stops the process scope, and cannot replace the original session ID. Old-generation callbacks cannot mutate the new generation.
7. A crash before spawn leaves a durable PREPARED generation that may proceed only after authoritative proof it never launched or stopped. A crash during/after spawn requires full-scope STOPPED proof before another generation. Duplicate claims and stale callbacks lose CAS. Terminal Runs never resume.

## Alternatives

- Reuse/reset the one current owner row without history: rejected because it erases old STOPPED evidence and permits stale-callback ambiguity.
- Create a new logical Run for each recovery: rejected because it violates approved same-Run/same-session and manifest/capability semantics.
- Keep the current schema and ordinary startup terminalization: rejected because the requested behavior cannot be represented or executed.

## Verification

- Migration tests cover empty install through the new migration, upgrade from the existing schema with populated owner/capture/session rows, rollback/failure atomicity, reopen/no-op, generation-1 data equality and current-owner projection consistency, and exact preservation of every `context_deltas` row/byte, schema SQL, indexes, root page, both foreign-key targets and `ON DELETE` actions, diagnostic-only semantics, and `PRAGMA foreign_key_check`; exercise CASCADE and SET NULL behavior.
- Recovery tests cover every startup ordering branch and prove no Hermes dispatch before READY; same-Run/session retention; reuse of exactly one existing reservation with normal Scheduler permission/approval/budget/capacity gates and no duplicate reservation; generation rotation with old STOPPED proof retained and a new containment ID/nonce; full-scope stop evidence; changed fingerprints/workspace/provider policy; invalid capture; duplicate claims; stale callbacks; crashes at each transition; and terminal-run rejection.
- On each resumed generation, assert the live init session ID equals the original durable `agent_runs.session_id` and correlates to the new generation. A mismatch invalidates capture and cannot overwrite the original ID or make resume eligible.
- Provider-backed acceptance remains required and must use the already selected Hermes provider and Hermes-native authentication; mocks/seeded data cannot satisfy it.

## Approval boundary

This design changes only the durable representation and restart mechanics needed to implement the already approved same-Run/same-session contract. Any choice to replace the logical Run, weaken STOPPED proof, or change Hermes credential ownership is outside this proposal and requires a separate product decision.
