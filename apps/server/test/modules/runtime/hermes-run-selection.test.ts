import { describe, expect, it } from "vitest";
import {
  bindHermesRunSelectionToOptions,
  deriveHermesNativeAuthRouteEvidence,
} from "../../../src/modules/runtime/hermes/hermes-run-selection.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-provider-selection.js";
import type { StartRunOptions } from "../../../src/modules/runtime/run-types.js";
import { createHermesAuthRouteFixture } from "../../helpers/hermes-auth-route-fixture.js";

const sourceSnapshotKey = JSON.stringify({
  formatVersion: 1,
  hermesVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
  manifestDigest: "c".repeat(64),
  sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
  sourceTree: "d".repeat(40),
});

function startOptions(runId: string): StartRunOptions {
  return {
    role: "developer", model: "scheduler-model", taskId: "task-1", epicId: null,
    triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
    runId, prompt: "caller prompt",
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
}

describe("bindHermesRunSelectionToOptions", () => {
  it("binds the verified native scanner projection and native-created profile into context identity", async () => {
    const options = startOptions("9f91161b-bafd-4ce2-9ac9-101936ef6b47");
    const fixture = await createHermesAuthRouteFixture(options.runId!);
    const selection = {
      runId: options.runId!,
      providerId: fixture.providerSelection.providerId,
      modelId: fixture.providerSelection.modelId,
      endpointIdentity: fixture.providerSelection.endpointIdentity!,
      endpointRevision: fixture.providerSelection.endpointRevision!,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceSnapshotKey,
      profileHome: fixture.profileHome,
      authRouteEvidence: fixture.authRouteEvidence,
    };

    const bound = bindHermesRunSelectionToOptions(options, selection);

    expect(bound.model).toBe(fixture.providerSelection.modelId);
    expect(bound.runId).toBe(options.runId);
    expect(bound.contextInput?.versions).toMatchObject({ runtime: "hermes", runtimeVersion: selection.sourceVersion, model: selection.modelId });
    expect(bound.contextInput?.execution.policyIdentity.providerPolicyId)
      .toContain(`auth=hermes-native-global-default-auth-v2@${selection.sourceCommit}`);
    expect(bound.contextInput?.prompt).toBe(options.contextInput?.prompt);
  });

  it("rejects forged profile/projection receipts and altered IDs", async () => {
    const runId = "9f91161b-bafd-4ce2-9ac9-101936ef6b47";
    const fixture = await createHermesAuthRouteFixture(runId);
    const secretSentinel = "TEST_ONLY_MUST_NOT_ESCAPE";
    expect(() => deriveHermesNativeAuthRouteEvidence({
      profileReceipt: { ...fixture.profileReceipt },
      providerSelection: { ...fixture.providerSelection, modelId: secretSentinel },
      authRoot: fixture.authRoot,
      hermesProjectRoot: fixture.hermesProjectRoot,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      environment: { OPENAI_API_KEY: secretSentinel },
    })).toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");

    const selection = {
      runId, providerId: "attacker-selected", modelId: secretSentinel,
      endpointIdentity: "hermes-provider:attacker-selected", endpointRevision: "a".repeat(40),
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceSnapshotKey, profileHome: fixture.profileHome,
      authRouteEvidence: { ...fixture.authRouteEvidence },
    };
    expect(() => bindHermesRunSelectionToOptions(startOptions(runId), selection))
      .toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
  });

  it("rejects environment-backed and plugin-like caller claims without exposing values", async () => {
    const runId = "9f91161b-bafd-4ce2-9ac9-101936ef6b47";
    const fixture = await createHermesAuthRouteFixture(runId);
    const secretSentinel = "TEST_ONLY_MUST_NOT_ESCAPE";
    expect(() => deriveHermesNativeAuthRouteEvidence({
      profileReceipt: fixture.profileReceipt,
      providerSelection: fixture.providerSelection,
      authRoot: fixture.authRoot,
      hermesProjectRoot: fixture.hermesProjectRoot,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      environment: { OPENAI_API_KEY: secretSentinel },
    })).toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
    const forged = { ...fixture.authRouteEvidence, route: "SECRET_SOURCE_PLUGIN" };
    expect(() => bindHermesRunSelectionToOptions(startOptions(runId), {
      runId, providerId: fixture.providerSelection.providerId, modelId: fixture.providerSelection.modelId,
      endpointIdentity: fixture.providerSelection.endpointIdentity!, endpointRevision: fixture.providerSelection.endpointRevision!,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version, sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceSnapshotKey, profileHome: fixture.profileHome,
      authRouteEvidence: forged as unknown as typeof fixture.authRouteEvidence,
    })).toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
  });

  it("rejects a genuine scanner projection whose endpoint identity is unsupported", async () => {
    const runId = "9f91161b-bafd-4ce2-9ac9-101936ef6b47";
    await expect(createHermesAuthRouteFixture(runId, "openai-codex", "test-model", undefined, true))
      .rejects.toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
  });

  it("rejects projection receipts bound to another Run or environment", async () => {
    const runA = "9f91161b-bafd-4ce2-9ac9-101936ef6b47";
    const runB = "d844e81a-148b-45f8-a9b0-96c52c7163ad";
    const fixtureA = await createHermesAuthRouteFixture(runA);
    const fixtureB = await createHermesAuthRouteFixture(runB);

    expect(() => deriveHermesNativeAuthRouteEvidence({
      profileReceipt: fixtureB.profileReceipt,
      providerSelection: fixtureA.providerSelection,
      authRoot: fixtureA.authRoot,
      hermesProjectRoot: fixtureA.hermesProjectRoot,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      environment: {},
    })).toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");

    const environmentBound = await createHermesAuthRouteFixture(
      runA, "openai-codex", "test-model", undefined, false, undefined, { NODE_ENV: "fixture-a" },
    );
    expect(() => deriveHermesNativeAuthRouteEvidence({
      profileReceipt: environmentBound.profileReceipt,
      providerSelection: environmentBound.providerSelection,
      authRoot: environmentBound.authRoot,
      hermesProjectRoot: environmentBound.hermesProjectRoot,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      environment: {},
    })).toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
  });

  it("rejects endpoint identity and revision substituted after evidence issuance", async () => {
    const runId = "9f91161b-bafd-4ce2-9ac9-101936ef6b47";
    const fixture = await createHermesAuthRouteFixture(runId);
    const selection = {
      runId, providerId: fixture.providerSelection.providerId, modelId: fixture.providerSelection.modelId,
      endpointIdentity: fixture.providerSelection.endpointIdentity!, endpointRevision: fixture.providerSelection.endpointRevision!,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version, sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceSnapshotKey, profileHome: fixture.profileHome, authRouteEvidence: fixture.authRouteEvidence,
    };

    expect(() => bindHermesRunSelectionToOptions(startOptions(runId), {
      ...selection, endpointIdentity: "hermes-provider:substituted",
    })).toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
    expect(() => bindHermesRunSelectionToOptions(startOptions(runId), {
      ...selection, endpointRevision: "e".repeat(40),
    })).toThrow("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
  });
});
