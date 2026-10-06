import { describe, expect, it } from "vitest";
import { bindHermesRunSelectionToOptions } from "../../../src/modules/runtime/hermes/hermes-run-selection.js";
import type { StartRunOptions } from "../../../src/modules/runtime/run-types.js";

const sourceSnapshotKey = JSON.stringify({
  formatVersion: 1,
  hermesVersion: "v0.21.5+7357.g9244275",
  manifestDigest: "c".repeat(64),
  sourceCommit: "b".repeat(40),
  sourceTree: "d".repeat(40),
});

describe("bindHermesRunSelectionToOptions", () => {
  it("binds the projected Hermes provider/model and source policy identity into the exact context input", () => {
    const options: StartRunOptions = {
      role: "developer", model: "scheduler-model", taskId: "task-1", epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
      runId: "9f91161b-bafd-4ce2-9ac9-101936ef6b47", prompt: "caller prompt",
      contextInput: {
        prompt: "caller prompt", subject: { type: "TASK", id: "task-1" }, role: "developer",
        versions: { roleVersion: "1", runtime: "default", runtimeVersion: null, model: "scheduler-model", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1" },
        execution: {
          workspaceIdentity: { repository: "repo", workspace: "worktree", worktree: "task-1" },
          targetHead: null, targetBranch: null, effectiveCapabilityIds: ["submit_result"],
          policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
        },
      },
    };
    const selection = {
      runId: options.runId!, providerId: "openai-codex", modelId: "gpt-5.6-codex",
      endpointIdentity: "hermes-provider:openai-codex", endpointRevision: "a".repeat(40),
      sourceVersion: "v0.21.5+7357.g9244275", sourceCommit: "b".repeat(40),
      sourceSnapshotKey,
      profileHome: "C:\\Users\\runner\\AppData\\Local\\hermes\\profiles\\ebb-orchestrator-run-9f91161b-bafd-4ce2-9ac9-101936ef6b47",
    };

    const bound = bindHermesRunSelectionToOptions(options, selection);

    expect(bound.model).toBe(selection.modelId);
    expect(bound.runId).toBe(selection.runId);
    expect(bound.contextInput?.versions).toMatchObject({ runtime: "hermes", runtimeVersion: selection.sourceVersion, model: selection.modelId });
    expect(bound.contextInput?.execution.policyIdentity).toEqual({
      providerId: selection.providerId,
      providerPolicyId: `${selection.endpointIdentity}@${selection.endpointRevision};auth=hermes-native-auth-json-root-fallback-v1@${selection.sourceCommit}`,
      runtimeId: "hermes",
      runtimePolicyId: `${selection.sourceVersion}@${selection.sourceSnapshotKey};bootstrap=hermes-source-snapshot-bootstrap-v1`,
    });
    expect(bound.contextInput?.prompt).toBe(options.contextInput?.prompt);
    expect(bound.contextInput?.execution.workspaceIdentity).toEqual(options.contextInput?.execution.workspaceIdentity);
  });

  it("rejects a selection for a different Run ID", () => {
    const options: StartRunOptions = {
      role: "developer", model: "persisted", taskId: "task-1", epicId: null,
      triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
      runId: "9f91161b-bafd-4ce2-9ac9-101936ef6b47",
      contextInput: {
        prompt: "caller prompt", subject: { type: "TASK", id: "task-1" }, role: "developer",
        versions: { roleVersion: null, runtime: "default", runtimeVersion: null, model: "persisted", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1" },
        execution: {
          workspaceIdentity: { repository: "repo", workspace: "worktree", worktree: "task-1" },
          targetHead: null, targetBranch: null, effectiveCapabilityIds: ["submit_result"],
          policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
        },
      },
    };
    const selection = {
      runId: "4a18194c-c9fa-4dda-bbbc-4ca7b79b0e38", providerId: "openai-codex", modelId: "gpt-5.6-codex",
      endpointIdentity: "hermes-provider:openai-codex", endpointRevision: "a".repeat(40),
      sourceVersion: "v0.21.5+7357.g9244275", sourceCommit: "b".repeat(40), profileHome: "C:\\hermes\\profiles\\run",
      sourceSnapshotKey,
    };

    expect(() => bindHermesRunSelectionToOptions(options, selection)).toThrow("HERMES_RUN_SELECTION_BINDING_MISMATCH");
  });
});
