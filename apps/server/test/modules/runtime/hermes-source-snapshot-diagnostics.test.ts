import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCodeError } from "../../../src/platform/process/process-executor.js";
import { materializeHermesSourceSnapshot } from "../../../src/modules/runtime/hermes/hermes-source-snapshot.js";
import { createPinnedGitFixture } from "../../helpers/hermes-source-snapshot-acceptance-fixture.js";
import { safeHermesProfileChainLaunchEvidence } from "../../helpers/safe-hermes-profile-chain-message.js";
import {
  sanitizeHermesPathIdentityDiagnostic,
  withHermesSourceSnapshotFailureObserver,
  type HermesSourceSnapshotDiagnosticPhase,
} from "../../../src/modules/runtime/hermes/hermes-source-snapshot-diagnostics.js";

describe("Hermes source snapshot diagnostics", () => {
  it("reports only the fixed validation phase while preserving the generic snapshot error", async () => {
    let observedPhase: HermesSourceSnapshotDiagnosticPhase | undefined;
    const failure = withHermesSourceSnapshotFailureObserver(
      (phase) => { observedPhase = phase; },
      () => materializeHermesSourceSnapshot({
        gitExecutable: "git.exe",
        sourceRoot: "C:\\private-fixture\\source",
        cacheRoot: "C:\\private-fixture\\cache",
        hermesVersion: "pinned",
        commit: "a".repeat(40),
        tree: "b".repeat(64),
      }),
    );

    const error = await failure.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE",
      message: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE",
    });
    expect(String(error)).not.toContain("private-fixture");
    expect(observedPhase).toBe("validate");
  });

  it("reports the source-git phase without exposing the failing tree identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ebb-snapshot-diagnostic-"));
    try {
      const fixture = await createPinnedGitFixture(root);
      const lease = { assertHeld() {}, async release() {} };
      const wrongTree = (fixture.tree[0] === "0" ? "1" : "0") + fixture.tree.slice(1);
      let observedPhase: HermesSourceSnapshotDiagnosticPhase | undefined;
      const failure = withHermesSourceSnapshotFailureObserver(
        (phase) => { observedPhase = phase; },
        () => materializeHermesSourceSnapshot({
          gitExecutable: process.platform === "win32" ? "git.exe" : "git",
          sourceRoot: fixture.sourceRoot,
          cacheRoot: join(root, "cache"),
          hermesVersion: "pinned",
          commit: fixture.commit,
          tree: wrongTree,
          referenceLock: async () => lease,
          publicationLock: async () => lease,
        }),
      );

      const error = await failure.catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE", message: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE" });
      expect(String(error)).not.toContain(fixture.tree);
      expect(observedPhase).toBe("source-git");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ambiguous component exit 55 generic without process details", () => {
    const diagnostic = sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "C:\\private\\powershell.exe -EncodedCommand SECRET",
      55,
      "C:\\private\\stdout",
      "ACL details and SID SECRET",
    ));

    expect(diagnostic).toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
    expect(diagnostic).not.toMatch(/private|powershell|SECRET|SID|ACL details/iu);
  });

  it("distinguishes verified-helper launcher rejection without returning its phase details", () => {
    const diagnostic = sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "C:\\private\\powershell.exe -EncodedCommand SECRET",
      126,
      "",
      "NATIVE_HELPER_GATE_FAIL:parent-directory-open-index-1-win32-5:InvalidOperationException",
    ));

    expect(diagnostic).toBe("VERIFIED_HELPER_LAUNCHER_REJECTED");
    expect(diagnostic).not.toMatch(/private|powershell|index|win32|InvalidOperation|SECRET/iu);
  });

  it("keeps overlapping and unbounded component open-or-policy exit codes generic", () => {
    // Component-open exits are 40 + index, so indices 10–16 collide with ACL codes 50–56.
    // The chain verifier permits up to 64 components, and the legacy verifier has no count bound.
    for (const exitCode of [40, 50, 55, 56, 72, 103]) {
      expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", exitCode, "", "")))
        .toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
    }
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", 31, "", "")))
      .toBe("SECONDARY_PATH_ROOT_ACL_UNSAFE");
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", 34, "", "")))
      .toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
  });

  it("collapses unrecognized native helper output to a fixed secondary diagnostic", () => {
    const diagnostic = sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "C:\\private\\helper.exe --secret",
      126,
      "private stdout",
      "NATIVE_HELPER_GATE_FAIL:arbitrary-private-detail:InvalidOperationException",
    ));

    expect(diagnostic).toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
    expect(diagnostic).not.toMatch(/private|secret|arbitrary/iu);
  });

  it("accepts only exact native tokens and discards secret-bearing errors and payload output", () => {
    const expectedError = safeHermesProfileChainLaunchEvidence(new Error("HERMES_TICKET_OBJECT_MISMATCH"));
    const expectedStdout = safeHermesProfileChainLaunchEvidence(undefined, "\r\nHERMES_TICKET_OBJECT_MISMATCH\r\n");
    const expectedStderr = safeHermesProfileChainLaunchEvidence(undefined, "", "HERMES_TICKET_OBJECT_MISMATCH\n");
    const substringWithSecrets = safeHermesProfileChainLaunchEvidence(new Error(
      "C:\\private\\powershell.exe --encoded SECRET HERMES_TICKET_OBJECT_MISMATCH OPENAI_API_KEY=secret",
    ));
    const pathAndCommandPayload = safeHermesProfileChainLaunchEvidence(
      undefined,
      "C:\\private\\payload.exe --token SECRET_VALUE",
      "provider credential was printed",
    );

    expect(expectedError).toBe("HERMES_TICKET_OBJECT_MISMATCH");
    expect(expectedStdout).toBe("HERMES_TICKET_OBJECT_MISMATCH");
    expect(expectedStderr).toBe("HERMES_TICKET_OBJECT_MISMATCH");
    expect(substringWithSecrets).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(substringWithSecrets).not.toMatch(/private|powershell|SECRET|OPENAI_API_KEY|secret/iu);
    expect(pathAndCommandPayload).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(pathAndCommandPayload).not.toMatch(/private|payload|token|SECRET|credential|provider/iu);
  });
});
