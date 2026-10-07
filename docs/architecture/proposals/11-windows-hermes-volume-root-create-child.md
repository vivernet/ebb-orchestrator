---
id: proposal-11
kind: proposal
title: Bounded Windows Hermes volume-root child-directory right
status: proposed
created: 2026-10-07
updated: 2026-10-07
---

# Proposal 11 — Bounded Windows Hermes volume-root child-directory right

**Status:** Proposed security-contract amendment for Plan20 Task5. This document does not approve Plan20 implementation or acceptance.

## Problem

The configured Hermes auth-owning root may be on a Windows volume whose exact volume-root directory grants a foreign principal `FILE_ADD_SUBDIRECTORY` (`CreateDirectories`). The current Plan20 bounded-ancestor policy rejects that ACE before the protected Hermes root is reached. Changing the host ACL is not acceptable, and accepting this right on arbitrary ancestors would expand the namespace trust boundary.

## Decision proposed

Permit one narrowly scoped exception: while walking the verified path to a protected Hermes root, the native verifier may accept `FILE_ADD_SUBDIRECTORY` only on the exact volume-root directory handle for the volume containing that path. Open that directory handle, query `GetFinalPathNameByHandleW` with `FILE_NAME_NORMALIZED | VOLUME_NAME_GUID`, and require exactly `\\?\Volume{GUID}\` (canonical GUID syntax, trailing root separator, and no child component). Obtain `FILE_ID_INFO` with `GetFileInformationByHandleEx(FileIdInfo)` and bind the root handle's `VolumeSerialNumber` and `FileId`; require every captured descendant identity in the chain to use that same volume serial. Unsupported queries, another path form, missing identity, or serial mismatch fail closed. Never infer root identity from drive letters, caller-supplied paths, ACL shape, or a string prefix. On this exact handle, an effective foreign `ACCESS_ALLOWED_ACE` may contain only the already allowed bounded-ancestor rights plus `FILE_ADD_SUBDIRECTORY`:

`FILE_TRAVERSE | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_READ_EA | READ_CONTROL | SYNCHRONIZE | FILE_ADD_SUBDIRECTORY`.

The exception does not permit `FILE_ADD_FILE`, file writes, delete/rename, ACL/owner changes, generic rights, unknown rights, or compound ACEs. Effective `ACCESS_DENIED_ACE` and `SYSTEM_AUDIT_ACE` retain their existing handling; `INHERIT_ONLY_ACE` remains ignored for the handle to which it does not apply. The exception is evaluated only at the volume-root component index; it never authorizes the same right on a later component, even when the root ACE is inheritable. Every non-volume-root ancestor, including `C:\Users`, remains under the existing read-only bounded policy. The auth-owning Hermes root, `profiles`, per-Run profile, `home`, `config.yaml`, and all descendants retain their existing strict owner/private or mutation-safe policy.

This is a path-validation exception, not a host ACL change: Orchestrator must never edit host ACLs, and acceptance must never edit system, user-profile, or Hermes ACLs. ACL setup/restoration is allowed only on disposable test-owned fixtures fully contained under the test temporary directory, after every fixture child process is proven stopped; use synthetic DACL inputs where practical. It does not claim protection against a deliberately hostile process running as the same user and does not weaken component identity, no-follow/reparse, or protected-root checks.

## Required ownership and failure behavior

- The native path verifier owns volume-root identification, ACE evaluation, no-follow relative opens, and volume/file identity capture for every component.
- The Run/profile path owner binds the complete captured identity chain into the one-use launch ticket. The ticket contains identities only, never ACL text, paths, credentials, or provider configuration.
- The native supervisor must independently reopen the chain relative to verified parent handles, compare every identity with the ticket, and keep no-delete-sharing handles for the verified chain through authoritative `STOPPED`. It must do this before process creation and revalidate at the suspended-create-to-resume boundary.
- A capture-to-ticket-to-supervisor race, changed/replaced component, missing component, impostor identity, reparse point, incompatible sharing mode, failed handle open, or missing STOPPED evidence fails closed before resume; no alternate path or ACL repair is attempted.
- Handle lifetime must bridge capture/ticket handoff safely: either the native owner retains/duplicates the verified handles until the supervisor has acquired its no-delete-sharing chain, or the supervisor's identity re-open must prove exact ticket equality before it can proceed. Tests must exercise the actual production handoff, not a model-only comparison.

## Acceptance required before adoption

Provider-free native Windows tests must prove all of the following:

1. The exact volume-root handle passes the native identity protocol: open the root directory handle; call `GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED | VOLUME_NAME_GUID)`; require exactly `\\?\Volume{GUID}\`; bind `FILE_ID_INFO.VolumeSerialNumber` and `FileId`; and require that every held descendant identity has the same volume serial. Any unsupported API/query, other form, absent identity, or serial mismatch fails closed. The verified root handle accepts the bounded existing read rights plus `FILE_ADD_SUBDIRECTORY`, while `C:\Users` and every other non-root component reject that right.
2. The volume-root handle rejects `FILE_ADD_FILE`, delete/rename, ACL/owner mutation, generic rights, unknown rights, and compound ACEs. Existing effective deny/audit and inherit-only semantics remain unchanged.
3. A missing component, pre-created impostor, changed file identity, or reparse-point component fails closed; no path-string or leaf-only check can substitute for each component's identity.
4. A race after capture and before ticket consumption is detected by the production capture→ticket→supervisor flow. The supervisor holds no-delete-sharing handles for the verified chain through authoritative `STOPPED`; replacement/deletion attempts are denied or make the pre-resume identity check fail.
5. The auth-owning Hermes root and every protected descendant reject the new exception; existing strict policy tests remain intact.
6. An inheritable `FILE_ADD_SUBDIRECTORY` ACE on the root does not authorize any later path component: test its effective inherited ACE at a non-root component index and prove rejection there, as well as at the protected root and descendants. All fixtures are disposable and cleaned only after process scope is proven stopped. Tests never edit system, user-profile, or Hermes ACLs; any ACL changes are confined to disposable test-owned temporary fixtures and restored, or replaced with synthetic DACL inputs. Tests launch no real provider.

## Non-goals

- No host ACL modification, ownership change, privilege elevation, or broad ancestor-rights allowance.
- No exception for `C:\Users`, arbitrary parent directories, Hermes root, Run profile, or descendants.
- No provider/auth changes, credential access, or relaxation of Hermes profile isolation.
- No claim that this is an OS sandbox or a defense against hostile same-user code.

## Approval boundary

This proposal is separate from the already approved Hermes provider/auth ownership and recovery behavior. Until a fresh independent security/plan review accepts this amendment and the required Windows acceptance passes, Plan20 remains unapproved for the changed Task5 contract and no completion status may be inferred.
