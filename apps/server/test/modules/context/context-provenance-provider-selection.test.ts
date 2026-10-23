import { describe, expect, it } from "vitest";
import { digestRunContextV1 } from "../../../src/modules/context/context-provenance.js";
import { createResumeContextBaselineV1, decodeResumeContextBaselineV1 } from "../../../src/modules/context/resume-eligibility.js";
import type { ContextFingerprintInputV1 } from "../../../src/modules/context/context-types.js";

function baseFingerprint(): ContextFingerprintInputV1 {
  return {
    promptHash: "a".repeat(64),
    subjectType: "TASK",
    subjectId: "task-1",
    contractOrRequestDigest: null,
    items: [],
    contextBuilderVersion: "1.0.1",
    role: "developer",
    roleVersion: null,
    runtime: "default",
    runtimeVersion: null,
    model: "default",
    modelVersion: null,
    outputSchemaVersion: "1",
    contextVersion: "1",
    workspaceIdentity: { repository: "repo", workspace: "work", worktree: "work" },
    targetHead: null,
    targetBranch: null,
    effectiveCapabilityIds: [],
    projectConfigRevisionId: null,
    projectConfigHash: null,
    policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
  };
}

describe("provider selection context fingerprint versioning (plan-24 Task 5)", () => {
  it("keeps the legacy fingerprint valid when providerSelection is absent (dual-version)", () => {
    const legacy = baseFingerprint();
    expect(() => digestRunContextV1(legacy)).not.toThrow();
    const baseline = createResumeContextBaselineV1(legacy);
    expect(decodeResumeContextBaselineV1(JSON.stringify(baseline)).fingerprint.providerSelection).toBeUndefined();
  });

  it("includes stable provider/model/auth/config-revision IDs and changes the digest on revision change", () => {
    const withSelection = (configRevision: number): ContextFingerprintInputV1 => ({
      ...baseFingerprint(),
      contextBuilderVersion: "1.0.2",
      providerSelection: { providerId: "openai", modelId: "gpt-4o", authMethodId: "api-key", configRevision },
    });
    const digestA = digestRunContextV1(withSelection(1));
    const digestB = digestRunContextV1(withSelection(2));
    expect(digestA).not.toBe(digestB);
    const baseline = createResumeContextBaselineV1(withSelection(1));
    const decoded = decodeResumeContextBaselineV1(JSON.stringify(baseline));
    expect(decoded.fingerprint.providerSelection).toEqual({
      providerId: "openai", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 1,
    });
    expect(decoded.fingerprint.contextBuilderVersion).toBe("1.0.2");
    expect(JSON.stringify(baseline)).not.toContain("endpoint");
    expect(JSON.stringify(baseline)).not.toContain("sk-ant-api03");
    expect(JSON.stringify(baseline)).not.toContain("secret");
  });

  it("rejects malformed provider selection fields in the fingerprint", () => {
    expect(() => digestRunContextV1({
      ...baseFingerprint(),
      providerSelection: { providerId: "", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 1 },
    })).toThrow(TypeError);
    expect(() => digestRunContextV1({
      ...baseFingerprint(),
      providerSelection: { providerId: "openai", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 0 },
    })).toThrow(TypeError);
  });
});
