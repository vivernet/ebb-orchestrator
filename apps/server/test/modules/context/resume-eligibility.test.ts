import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertResumeContextEligible, captureWorkspaceSnapshotV1, createResumeContextBaselineV1,
  decodeResumeContextBaselineV1, digestResumeBindingV1, type ResumeContextEvidenceV1 } from "../../../src/modules/context/resume-eligibility.js";
import type { ContextFingerprintInputV1 } from "../../../src/modules/context/context-types.js";

function evidence(): ResumeContextEvidenceV1 {
  const contextHash = "a".repeat(64);
  const workspaceHash = "b".repeat(64);
  return { originalSessionId: "original-session", capturedSessionId: "original-session", captureState: "BOUND",
    persistedContextHash: contextHash, reconstructedContextHash: contextHash,
    persistedWorkspaceSnapshotHash: workspaceHash, currentWorkspaceSnapshotHash: workspaceHash,
    persistedResumeBindingHash: digestResumeBindingV1(contextHash, workspaceHash) };
}

describe("resume context eligibility", () => {
  let directory = "";
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });
  it("accepts exact Ebb context/workspace and original durable session without provider identity fields", () => {
    expect(() => assertResumeContextEligible(evidence())).not.toThrow();
  });
  it.each(["UNBOUND", "INVALID"])("rejects %s capture even with otherwise matching evidence", (captureState) => {
    expect(() => assertResumeContextEligible({ ...evidence(), captureState })).toThrow("RESUME_ORIGINAL_SESSION_UNAVAILABLE");
  });
  it.each([null, "different-session", "unsafe/session"])("rejects missing or changed original session %s", (originalSessionId) => {
    expect(() => assertResumeContextEligible({ ...evidence(), originalSessionId })).toThrow("RESUME_ORIGINAL_SESSION_UNAVAILABLE");
  });
  it.each(["reconstructedContextHash", "currentWorkspaceSnapshotHash"] as const)("refuses changed %s", (field) => {
    expect(() => assertResumeContextEligible({ ...evidence(), [field]: "c".repeat(64) })).toThrow("RESUME_NOT_SAFE_WORKSPACE_CHANGED");
  });
  it("rejects corrupted binding digest", () => {
    expect(() => assertResumeContextEligible({ ...evidence(), persistedResumeBindingHash: "c".repeat(64) })).toThrow("RESUME_BASELINE_UNAVAILABLE");
  });
  it("fails closed for malformed hashes instead of inventing a baseline", () => {
    expect(() => assertResumeContextEligible({ ...evidence(), reconstructedContextHash: "unknown" })).toThrow("RESUME_BASELINE_UNAVAILABLE");
    expect(() => digestResumeBindingV1("unknown", "b".repeat(64))).toThrow("RESUME_BASELINE_UNAVAILABLE");
  });
  it("stores exact source fingerprint metadata while excluding workspace paths", () => {
    const fingerprint: ContextFingerprintInputV1 = {
      promptHash: "a".repeat(64), subjectType: "TASK", subjectId: "task-1", contractOrRequestDigest: "b".repeat(64),
      items: [], contextBuilderVersion: "1", role: "developer", roleVersion: "1", runtime: "hermes",
      runtimeVersion: "1", model: "default", modelVersion: null, outputSchemaVersion: "1", contextVersion: "1",
      workspaceIdentity: { repository: "private-repo-path", workspace: "private-workspace-path", worktree: "private-worktree-path" },
      targetHead: "a".repeat(40), targetBranch: "task-1", effectiveCapabilityIds: ["workspace.read"],
      projectConfigRevisionId: null, projectConfigHash: null,
      policyIdentity: { providerId: null, providerPolicyId: null, runtimeId: "default", runtimePolicyId: null },
    };
    const baseline = createResumeContextBaselineV1(fingerprint);
    const source = JSON.stringify(baseline);
    expect(source).not.toContain("private-");
    expect(source).not.toContain("workspaceIdentity");
    expect(decodeResumeContextBaselineV1(source)).toEqual(baseline);
    expect(() => decodeResumeContextBaselineV1(source.replace('"formatVersion":1', '"formatVersion":2'))).toThrow("RESUME_BASELINE_UNAVAILABLE");
  });
  it("captures ignored/untracked contents, index changes and stable repeat snapshots without returning raw paths", () => {
    directory = mkdtempSync(join(tmpdir(), "ebb-resume-snapshot-"));
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=", ...args], { cwd: directory, stdio: "pipe" });
    git(["init", "-q"]);
    writeFileSync(join(directory, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(directory, "tracked.txt"), "initial");
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
    const first = captureWorkspaceSnapshotV1(directory);
    expect(first).toEqual(captureWorkspaceSnapshotV1(directory));
    expect(Object.keys(first).sort()).toEqual(["formatVersion", "hash"]);
    writeFileSync(join(directory, "ignored.txt"), "ignored content one");
    const ignoredOne = captureWorkspaceSnapshotV1(directory);
    expect(ignoredOne.hash).not.toBe(first.hash);
    writeFileSync(join(directory, "ignored.txt"), "ignored content two");
    const ignoredTwo = captureWorkspaceSnapshotV1(directory);
    expect(ignoredTwo.hash).not.toBe(ignoredOne.hash);
    writeFileSync(join(directory, "untracked.txt"), "untracked content");
    const untracked = captureWorkspaceSnapshotV1(directory);
    expect(untracked.hash).not.toBe(ignoredTwo.hash);
    writeFileSync(join(directory, "tracked.txt"), "modified content");
    const unstaged = captureWorkspaceSnapshotV1(directory);
    git(["add", "tracked.txt"]);
    expect(captureWorkspaceSnapshotV1(directory).hash).not.toBe(unstaged.hash);
  });
  it("refuses a missing/nonrepository workspace with a bounded error", () => {
    directory = mkdtempSync(join(tmpdir(), "ebb-resume-nonrepo-"));
    expect(() => captureWorkspaceSnapshotV1(directory)).toThrow("RESUME_WORKSPACE_SNAPSHOT_UNAVAILABLE");
    expect(() => captureWorkspaceSnapshotV1(join(directory, "absent"))).toThrow("RESUME_WORKSPACE_SNAPSHOT_UNAVAILABLE");
  });
});
