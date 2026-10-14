# Plan20 macOS feasibility harness

This is a disposable, isolated feasibility harness for the approved Plan20 spike. It is not a production controller, does not implement a VM lifecycle, and cannot establish macOS support.

Run from the repository root on an exact commit:

```sh
pnpm --dir tools/plan20-macos-feasibility run preflight
pnpm --dir tools/plan20-macos-feasibility run lifecycle -- --scenario orchestrator-crash-restart-reattach
pnpm --dir tools/plan20-macos-feasibility run provider
pnpm --dir tools/plan20-macos-feasibility run report
```

The preflight writes evidence only to `temp/plan20-macos-feasibility/<exact-ebb-sha>/evidence.json`. On a non-macOS host it records `NOT_VERIFIED` and exits nonzero. On macOS it requires the literal physical-host attestation, verifies the allowlisted host facts, then stops because this isolated package is not a signed controller with the Virtualization entitlement. It does not create a VM.

The lifecycle command accepts only the scenario names listed in `src/contract.mjs`. Reattach scenarios hard-fail because the public Virtualization API describes restoration of a stopped VM from saved state, not reattaching a new controller to the same live VM. Other lifecycle scenarios hard-fail because no VM controller is installed. The `provider` command does not run Hermes; it refuses to do so until the existing Hermes setup is proven reachable from a proven guest without copying or changing it.

`report` outputs only allowlisted identity fields, fixed gate statuses, the exact Ebb SHA, and fixed blocker codes. It never retains raw command output, paths, credentials, or provider response bodies. The only valid report result for this harness is currently `NOT_VERIFIED`; a passing result requires physical-host execution, actual lifecycle/provider/package evidence, and independent architecture and security review records. No test fixture can manufacture those records.

Before any command reads or writes evidence, the harness requires `git status` to show no modified or untracked files under `tools/plan20-macos-feasibility`. This makes the reported HEAD SHA correspond to the harness code that produced the evidence. Evidence is stored under the ignored `temp/plan20-macos-feasibility/<exact-ebb-sha>/` path, outside this source-tree check; changing harness code invalidates eligibility until that code is committed and clean.

The distinction between stop and restore matters: Apple's `VZVirtualMachine.stop(completionHandler:)` completion reports that the controlled VM stopped; `restoreMachineStateFrom` restores a **stopped** VM from saved state. Neither documentation describes attaching to the same still-running VM after the controller process crashes. See Apple's current [stop API](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop%28completionhandler%3A%29), [restore API](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/restoremachinestatefrom%28url%3Acompletionhandler%3A%29), and [VM state enum](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/state-swift.enum).
