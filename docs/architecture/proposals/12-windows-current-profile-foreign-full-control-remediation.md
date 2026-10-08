---
id: proposal-12
kind: proposal
title: Narrow operator-only Windows profile ACL remediation prerequisite
status: accepted
created: 2026-10-08
accepted: 2026-10-08
updated: 2026-10-08
---

# Proposal 12 — Narrow operator-only Windows profile ACL remediation prerequisite

**Status:** Accepted as an operator-only remediation contract under the user's explicit authorization to make the changes necessary to complete the Goal. This approval does not authorize Orchestrator, test helpers, or unattended scripts to edit ACLs; it does not change the native verifier; and no host ACL has been changed by this proposal.

## Goal and non-goals

Allow the current user's Windows Hermes profile-path checks to proceed when read-only inventory proves that the current user profile root contains one explicit `FullControl` allow ACE for another local SID and that exact ACE is the sole cause of the native verifier rejection. Preserve the current user's own access and all system/administrator and unrelated ACEs.

This proposal does not relax the native verifier, does not permit an ACL repair from product code or acceptance code, does not modify the volume root or any ancestor, and does not authorize recursive ACL reset, ownership takeover, privilege elevation, or changes to other profiles. It is not an OS sandbox claim.

## Alternatives

1. **A — Leave the ACL untouched and keep the native verifier fail-closed.** This preserves current ACLs, but the affected Windows profile-path acceptance and provider gate remain blocked until the ACL is independently corrected.
2. **B — Remove exactly one qualifying explicit FullControl ACE from the current user's profile root, as a separately performed operator action.** This narrows the change to the identified foreign grant while preserving the strict verifier and all other ACL entries. **Selected.**
3. **C — Weaken the verifier to accept FullControl or additional mutation rights on user-profile ancestors.** Rejected: it would broaden the path trust boundary for every deployment and conceal unsafe ACL state.

## Exact preconditions and target

- Resolve the current user's SID from the process token and the current user's profile root from the Windows profile API; do not trust environment variables or a caller-supplied path as authority.
- Open the API-resolved profile root and each ancestor without following reparse points, bind the exact profile-root directory object to its volume serial/file ID, and retain the verified handle chain through the operation. Before any DACL write, recheck the held target's identity and exact current security descriptor against the read-only inventory/backup. A canonical path string alone is never write authority.
- Perform a read-only inventory first. Record the profile-root owner, DACL control/inheritance flags, all ACE types/SIDs/masks/inheritance flags, and the relevant descendant effective/inherited access impact. Do not read credentials or file contents.
- A candidate ACE must be an explicit, effective `ACCESS_ALLOWED_ACE` on that exact profile-root object, granted to a different local account SID, with the exact Windows `FullControl` mask and no extra rights. It must not be inherited, deny, audit, generic/unknown, compound, or trustee-ambiguous. The current user's SID, profile owner, `SYSTEM`, and built-in Administrators are protected principals and can never be selected.
- Proceed only if read-only inventory identifies exactly one ACE satisfying every condition and confirms that all other ACEs and the owner will be preserved. If zero or multiple candidates exist, the SID cannot be resolved unambiguously, or another verifier condition is present, do not modify ACLs; keep the gate blocked and investigate separately.

## Selected change and ownership

Only the human operator performs this one-time host maintenance action outside Orchestrator and outside test execution. Remove that exact ACE from the current user's profile-root DACL while preserving owner, group, DACL protection/inheritance state, ACE order/canonicalization where possible, and every other ACE byte-for-byte/semantically unchanged. Apply the update through a supported handle-bound security API to the same verified directory object; do not use path-based `Set-Acl` or another path-reopening write as though it were bound to the verified handle. If the selected PowerShell/.NET mechanism cannot make the write against that exact handle, stop and obtain a supported handle-bound implementation before mutation. Do not modify any child object directly. The existing native verifier and its accepted-rights policy remain unchanged and must independently pass afterward.

The profile-root ACE may have been inheritable. Removing it can remove the other SID's inherited access from descendants that do not protect their DACLs. The operator must review the read-only inheritance-impact inventory and explicitly accept that loss of access before applying the change. Explicit ACEs on descendants are not removed or rewritten. No attempt is made to preserve the foreign SID's inherited FullControl by creating replacement grants. An apparently inactive SID, absence of a currently running process, or lack of an observed recent access is not evidence that no scheduled, service, user-initiated, or future workload depends on the grant. If the affected account's ownership and future-workload impact cannot be understood and expressly accepted, do not apply the change; keep the Windows gate blocked.

## Backup, verification, and rollback

1. Before mutation, save the exact self-relative binary security descriptor for the profile-root object as the authoritative backup, including owner, group, DACL and control flags. Store the target volume serial/file ID, the API-resolved profile-root identity evidence, candidate ACE metadata, and read-only before-inventory alongside it; SDDL is supplemental inventory only, never the authoritative restore source. Define the descriptor digest as lowercase 64-hex `SHA-256(UTF-8("ebb-windows-profile-acl-backup-v1\0") || descriptorBytes)`, where `\0` means one NUL byte and `descriptorBytes` are the exact captured binary descriptor bytes. Store the backup outside the repository in a newly created, no-follow location with a protected, non-inheriting DACL granting access only to the current user, SYSTEM, and built-in Administrators. Read back the binary descriptor and metadata byte-for-byte, recompute the digest, and verify the backup object's ACL and identity before proceeding. If any check fails, do not mutate the target.
2. Immediately before the DACL write, re-read the target identity and current self-relative descriptor through the retained handle chain. Require the same volume serial/file ID and byte-for-byte equality with the captured original descriptor. Use a supported handle-bound security API on that same target handle; never use recursive `icacls /reset`, broad inheritance repair, blanket grant/revoke, or a command that traverses descendants to write ACLs. If identity, descriptor, or handle-bound write preconditions no longer hold, make no change and retain the backup.
3. Derive the exact expected post-change descriptor by removing only the candidate ACE from the captured descriptor while preserving all other fields/ACEs. Read back through the same object handle and require the exact target identity and byte-for-byte equality with that expected descriptor. Verify retained ACE semantics and re-run read-only descendant inventory: only the candidate's inherited grant may disappear where inheritance applies; no explicit descendant ACE or unrelated effective access may change. Any mismatch is an unexpected state: do not overwrite it, do not attempt automatic restore, retain the backup and escalate to the operator.
4. Rollback is permitted only when the target still has the original verified identity and its current self-relative descriptor is byte-for-byte equal to the known expected post-change descriptor. Under those conditions, restore the original binary descriptor through a supported handle-bound API on that same object and verify identity plus byte-for-byte equality with the original descriptor. If identity differs, current descriptor differs from the expected post-change descriptor, or exact restoration cannot be proved, do not write anything; retain the protected backup and escalate. Never perform a recursive restore. After a successful change and acceptance, retain the protected backup until the operator verifies no rollback is needed, then dispose of it using the machine's approved secure-retention procedure.

## External gate and verification strategy

The Windows profile-path-chain provider-free acceptance and any later provider-backed Task5B acceptance remain `NOT RUN` until the operator-only gate has either completed with exact readback verification or read-only inventory proves the candidate ACE is absent and the unchanged verifier now passes. Record the sanitized before/after verification result and exact test command/exit code in plan evidence; do not record profile paths, SIDs, ACL dumps, or secrets in repository evidence. The product/test helper never runs this remediation. Re-run the unchanged native verifier and Windows acceptance after the separate operator action; a verifier failure remains a failure and is not converted to a skip or policy exception.

This gate does not block unrelated provider-free process-scope tests or Linux acceptance. It is a prerequisite only for Windows tests that traverse the affected user-profile path and for Windows provider-backed acceptance using that path.

## Rollback and non-goals

Rollback is the exact profile-root descriptor restore described above, performed by the operator from the verified backup. It is not a recursive restore. This proposal neither changes the status of Plan20 nor supplies acceptance evidence. The native verifier remains fail-closed for all non-approved ACE patterns and every other path component.
