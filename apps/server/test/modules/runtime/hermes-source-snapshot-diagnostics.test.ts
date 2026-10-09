import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCodeError } from "../../../src/platform/process/process-executor.js";
import { materializeHermesSourceSnapshot } from "../../../src/modules/runtime/hermes/hermes-source-snapshot.js";
import { createPinnedGitFixture } from "../../helpers/hermes-source-snapshot-acceptance-fixture.js";
import {
  safeHermesLaunchFailureAssertionContext,
  safeHermesProfileChainLaunchEvidence,
} from "../../helpers/safe-hermes-profile-chain-message.js";
import {
  HERMES_SOURCE_SNAPSHOT_DIAGNOSTIC_PHASES,
  isSafeHermesPathComponentAclDiagnostic,
  isSafeHermesPathComponentOpenDiagnostic,
  markHermesSourceSnapshotDiagnosticPhase,
  reportHermesSourceSnapshotFailurePhase,
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

  it("reports only fixed native-projection subphases and collapses operation details", async () => {
    const projectionStages = [
      "native-projection-helper-create",
      "native-projection-open-verify-temp",
      "native-projection-write-seal",
      "native-projection-owner-publish-link",
      "native-projection-alias-cleanup",
      "native-projection-final-verify",
    ] as const;
    expect([...HERMES_SOURCE_SNAPSHOT_DIAGNOSTIC_PHASES]).toEqual(expect.arrayContaining([...projectionStages]));

    for (const stage of projectionStages) {
      let observedPhase: HermesSourceSnapshotDiagnosticPhase | undefined;
      let callbackArgumentCount = -1;
      const error = await withHermesSourceSnapshotFailureObserver(
        (...args) => {
          callbackArgumentCount = args.length;
          [observedPhase] = args;
        },
        async () => {
          markHermesSourceSnapshotDiagnosticPhase(stage);
          try {
            throw Object.assign(new Error("C:\\private\\cache\\secret"), {
              path: "C:\\private\\projection.bin",
              stderr: "raw native stderr and credential",
            });
          } catch {
            reportHermesSourceSnapshotFailurePhase();
            throw Object.assign(new Error("HERMES_SOURCE_SNAPSHOT_UNAVAILABLE"), {
              code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE",
            });
          }
        },
      ).catch((caught: unknown) => caught);

      expect(observedPhase).toBe(stage);
      expect(callbackArgumentCount).toBe(1);
      expect(error).toMatchObject({
        code: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE",
        message: "HERMES_SOURCE_SNAPSHOT_UNAVAILABLE",
      });
      expect(String(error)).not.toMatch(/private|projection\.bin|stderr|credential/iu);
    }

    let observedForgedPhase: HermesSourceSnapshotDiagnosticPhase | undefined;
    await withHermesSourceSnapshotFailureObserver(
      (phase) => { observedForgedPhase = phase; },
      async () => {
        markHermesSourceSnapshotDiagnosticPhase("C:\\private\\secret" as HermesSourceSnapshotDiagnosticPhase);
        reportHermesSourceSnapshotFailurePhase();
      },
    );
    expect(observedForgedPhase).toBe("validate");
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

  it.each([
    [10, "VERIFY_SAFE_PATH_REFUSED:USER_IDENTITY", "SECONDARY_PATH_USER_IDENTITY_UNAVAILABLE"],
    [30, "VERIFY_SAFE_PATH_REFUSED:ROOT_OPEN", "SECONDARY_PATH_ROOT_OPEN_FAILED"],
    [31, "VERIFY_SAFE_PATH_REFUSED:ROOT_IDENTITY", "SECONDARY_PATH_IDENTITY_UNAVAILABLE:ROOT"],
    [31, "VERIFY_SAFE_PATH_REFUSED:ROOT_ACL", "SECONDARY_PATH_ROOT_ACL_UNSAFE"],
    [34, "VERIFY_SAFE_PATH_REFUSED:OBJECT_IDENTITY", "SECONDARY_PATH_IDENTITY_UNAVAILABLE"],
    [41, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_OPEN:INDEX_1", "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_1"],
    [51, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_ACL:INDEX_1:ACL_STAGE_1", "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_1"],
    [103, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_OPEN:INDEX_63", "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_63"],
    [56, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_ACL:INDEX_64_PLUS:ACL_STAGE_6", "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_64_PLUS:STAGE_6"],
    [104, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_OPEN:INDEX_64_PLUS", "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_64_PLUS"],
    [120, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_OPEN:INDEX_64_PLUS", "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_64_PLUS"],
  ])("sanitizes standalone verifier refusal with matching exit %s", (exitCode, stderr, expected) => {
    const diagnostic = sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "C:\\private\\helper.exe --secret",
      exitCode,
      "",
      stderr,
    ));

    expect(diagnostic).toBe(expected);
    expect(diagnostic).not.toMatch(/private|secret|stdout|VERIFY_SAFE_PATH_REFUSED/iu);
  });

  it("accepts the native refusal marker with one Windows line ending", () => {
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "helper",
      55,
      "",
      "VERIFY_SAFE_PATH_REFUSED:COMPONENT_ACL:INDEX_15:ACL_STAGE_5\r\n",
    ))).toBe("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_15:STAGE_5");
  });

  it("rejects a standalone refusal marker when the native verifier also wrote stdout", () => {
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "helper",
      55,
      "unexpected output",
      "VERIFY_SAFE_PATH_REFUSED:COMPONENT_ACL:INDEX_15:ACL_STAGE_5\r\n",
    ))).toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
  });

  it.each([
    [31, "VERIFY_SAFE_PATH_REFUSED:ROOT_OPEN"],
    [31, "VERIFY_SAFE_PATH_REFUSED:ROOT_ACL\nC:\\private\\extra"],
    [31, "unexpected\nVERIFY_SAFE_PATH_REFUSED:ROOT_OPEN"],
  ])("does not fall back to legacy root ACL for invalid standalone marker evidence %s", (exitCode, stderr) => {
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", exitCode, "", stderr)))
      .toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
  });

  it.each([
    [11, "VERIFY_SAFE_PATH_REFUSED:USER_IDENTITY"],
    [31, "VERIFY_SAFE_PATH_REFUSED:ROOT_OPEN"],
    [30, "VERIFY_SAFE_PATH_REFUSED:ROOT_ACL"],
    [41, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_OPEN:INDEX_2"],
    [55, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_ACL:INDEX_1:ACL_STAGE_4"],
    [103, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_OPEN:INDEX_64_PLUS"],
    [104, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_OPEN:INDEX_63"],
    [51, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_ACL:INDEX_01:ACL_STAGE_1"],
    [51, "VERIFY_SAFE_PATH_REFUSED:COMPONENT_ACL:INDEX_1:ACL_STAGE_1\nC:\\private\\SECRET"],
  ])("collapses malformed or mismatched standalone refusal %s / %s", (exitCode, stderr) => {
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", exitCode, "", stderr)))
      .toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
  });

  it("reports only a bounded path-chain component and ACL stage for a matching native failure", () => {
    const diagnostic = sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "C:\\private\\powershell.exe -EncodedCommand SECRET",
      55,
      "",
      "SAFE_PATH_CHAIN_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_5",
    ));

    expect(diagnostic).toBe("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_5");
    expect(diagnostic).not.toMatch(/private|powershell|SECRET|SID|ACE|mask/iu);
  });

  it("reports only a bounded path-chain identity failure location", () => {
    const diagnostic = sanitizeHermesPathIdentityDiagnostic(new ExitCodeError(
      "C:\\private\\powershell.exe -EncodedCommand SECRET",
      34,
      "C:\\private\\stdout",
      "SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:COMPONENT_INDEX_12",
    ));

    expect(diagnostic).toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE:COMPONENT_INDEX_12");
    expect(diagnostic).not.toMatch(/private|powershell|SECRET|stdout/iu);
  });

  it.each([
    ["SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:ROOT", "SECONDARY_PATH_IDENTITY_UNAVAILABLE:ROOT"],
    ["SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:COMPONENT_INDEX_64", "SECONDARY_PATH_IDENTITY_UNAVAILABLE:COMPONENT_INDEX_64"],
    ["SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:SERIALIZATION_LIMIT", "SECONDARY_PATH_IDENTITY_UNAVAILABLE:SERIALIZATION_LIMIT"],
  ])("maps only exact bounded identity diagnostic %s", (stderr, expected) => {
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", 34, "", stderr))).toBe(expected);
  });

  it.each([
    [34, "SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:COMPONENT_INDEX_65"],
    [34, "SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:COMPONENT_INDEX_01"],
    [34, "SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:COMPONENT_INDEX_1:C:\\private"],
    [35, "SAFE_PATH_CHAIN_IDENTITY_UNAVAILABLE:ROOT"],
  ])("collapses malformed or exit-mismatched identity diagnostic %s / %s", (exitCode, stderr) => {
    expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", exitCode, "", stderr)))
      .toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
  });

  it("passes through only exact bounded component ACL diagnostics", () => {
    expect(isSafeHermesPathComponentAclDiagnostic("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_5")).toBe(true);
    expect(isSafeHermesPathComponentAclDiagnostic("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_64:STAGE_6")).toBe(true);
    for (const value of [
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_0:STAGE_5",
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_65:STAGE_5",
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_01:STAGE_5",
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_7",
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_5:C:\\private",
    ]) {
      expect(isSafeHermesPathComponentAclDiagnostic(value)).toBe(false);
    }
  });

  it("keeps standalone component ACL overflow separate from path-chain numeric indices", () => {
    expect(isSafeHermesPathComponentAclDiagnostic("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_64:STAGE_6")).toBe(true);
    expect(isSafeHermesPathComponentAclDiagnostic("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_64_PLUS:STAGE_6")).toBe(false);
    expect(isSafeHermesPathComponentAclDiagnostic("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_0:STAGE_1", true)).toBe(true);
    expect(isSafeHermesPathComponentAclDiagnostic("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_63:STAGE_6", true)).toBe(true);
    expect(isSafeHermesPathComponentAclDiagnostic("SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_64_PLUS:STAGE_6", true)).toBe(true);
    for (const value of [
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_64:STAGE_6",
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_65:STAGE_6",
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_01:STAGE_1",
      "SECONDARY_PATH_COMPONENT_ACL_UNSAFE:INDEX_64_PLUS:STAGE_7",
    ]) {
      expect(isSafeHermesPathComponentAclDiagnostic(value, true)).toBe(false);
    }
  });

  it("accepts only bounded standalone component-open indices", () => {
    for (const value of [
      "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_0",
      "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_63",
      "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_64_PLUS",
    ]) {
      expect(isSafeHermesPathComponentOpenDiagnostic(value)).toBe(true);
    }
    for (const value of [
      "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_01",
      "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_64",
      "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_65",
      "SECONDARY_PATH_COMPONENT_OPEN_FAILED:INDEX_64_PLUS:private",
    ]) {
      expect(isSafeHermesPathComponentOpenDiagnostic(value)).toBe(false);
    }
  });

  it("rejects malformed, out-of-range, or exit-code-mismatched path-chain diagnostics", () => {
    for (const [exitCode, stderr] of [
      [55, "SAFE_PATH_CHAIN_COMPONENT_ACL_UNSAFE:INDEX_65:STAGE_5"],
      [55, "SAFE_PATH_CHAIN_COMPONENT_ACL_UNSAFE:INDEX_0:STAGE_5"],
      [55, "SAFE_PATH_CHAIN_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_4"],
      [55, "SAFE_PATH_CHAIN_COMPONENT_ACL_UNSAFE:INDEX_01:STAGE_5"],
      [55, "SAFE_PATH_CHAIN_COMPONENT_ACL_UNSAFE:INDEX_1:STAGE_7"],
    ] as const) {
      expect(sanitizeHermesPathIdentityDiagnostic(new ExitCodeError("helper", exitCode, "", stderr)))
        .toBe("SECONDARY_PATH_IDENTITY_UNAVAILABLE");
    }
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

  it("accepts only exact in-process errors and discards untrusted payload output", () => {
    const expectedError = safeHermesProfileChainLaunchEvidence(new Error("HERMES_TICKET_OBJECT_MISMATCH"));
    const expectedStdout = safeHermesProfileChainLaunchEvidence(undefined, "\r\nHERMES_TICKET_OBJECT_MISMATCH\r\n");
    const expectedStderr = safeHermesProfileChainLaunchEvidence(undefined, "", "HERMES_TICKET_OBJECT_MISMATCH\n");
    const bareTokenWithNativeExit = safeHermesProfileChainLaunchEvidence(undefined, "HERMES_TICKET_OBJECT_MISMATCH", "", 3);
    const substringWithSecrets = safeHermesProfileChainLaunchEvidence(new Error(
      "C:\\private\\powershell.exe --encoded SECRET HERMES_TICKET_OBJECT_MISMATCH OPENAI_API_KEY=secret",
    ));
    const pathAndCommandPayload = safeHermesProfileChainLaunchEvidence(
      undefined,
      "C:\\private\\payload.exe --token SECRET_VALUE",
      "provider credential was printed",
    );

    expect(expectedError).toBe("HERMES_TICKET_OBJECT_MISMATCH");
    expect(expectedStdout).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(expectedStderr).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(bareTokenWithNativeExit).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(substringWithSecrets).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(substringWithSecrets).not.toMatch(/private|powershell|SECRET|OPENAI_API_KEY|secret/iu);
    expect(pathAndCommandPayload).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(pathAndCommandPayload).not.toMatch(/private|payload|token|SECRET|credential|provider/iu);
  });

  it("accepts the exact native UNKNOWN record only with exit code 3", () => {
    const record = "UNKNOWN\tHERMES_TICKET_OBJECT_MISMATCH";
    for (const output of [record, `${record}\n`, `${record}\r\n`]) {
      expect(safeHermesProfileChainLaunchEvidence(undefined, output, "", 3))
        .toBe("HERMES_TICKET_OBJECT_MISMATCH");
    }
    for (const exitCode of [undefined, 0, 2, 4, 255]) {
      expect(safeHermesProfileChainLaunchEvidence(undefined, record, "", exitCode))
        .toBe("UNEXPECTED_LAUNCH_FAILURE");
    }
    for (const output of [
      `\n${record}`,
      `${record}\n\n`,
      `${record}\nextra`,
      `prefix${record}`,
      `${record}suffix`,
      "UNKNOWN\tSECRET_EXFILTRATION",
      `C:\\private\\payload.exe\n${record}`,
    ]) {
      expect(safeHermesProfileChainLaunchEvidence(undefined, output, "", 3))
        .toBe("UNEXPECTED_LAUNCH_FAILURE");
    }
  });

  it("accepts only the exact trusted in-process native wrapper code", () => {
    const exactWrapper = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:HERMES_TICKET_OBJECT_MISMATCH");
    const forgedWrapper = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:SECRET_EXFILTRATION");
    const otherNativeCode = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:LAUNCH_TICKET_EXECUTABLE_MISMATCH");
    const prefixed = new Error("prefix WINDOWS_HELPER_NATIVE_UNKNOWN:HERMES_TICKET_OBJECT_MISMATCH");
    const suffixed = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:HERMES_TICKET_OBJECT_MISMATCH extra");

    expect(safeHermesProfileChainLaunchEvidence(exactWrapper)).toBe("HERMES_TICKET_OBJECT_MISMATCH");
    for (const error of [forgedWrapper, otherNativeCode, prefixed, suffixed]) {
      expect(safeHermesProfileChainLaunchEvidence(error)).toBe("UNEXPECTED_LAUNCH_FAILURE");
    }
  });

  it("preserves the component-unsafe native refusal without relabeling other wrapper codes", () => {
    const componentUnsafe = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
    const unrelatedSafeCode = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:LAUNCH_TICKET_EXECUTABLE_MISMATCH");
    const forgedCode = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:SECRET_EXFILTRATION");

    expect(safeHermesProfileChainLaunchEvidence(componentUnsafe)).toBe("LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE");
    expect(safeHermesProfileChainLaunchEvidence(unrelatedSafeCode)).toBe("UNEXPECTED_LAUNCH_FAILURE");
    expect(safeHermesProfileChainLaunchEvidence(forgedCode)).toBe("UNEXPECTED_LAUNCH_FAILURE");
  });

  it("adds only an allowlisted non-enumerable stage to test assertion context", () => {
    const stableCode = "WINDOWS_HELPER_NATIVE_UNKNOWN:LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH";
    const withStage = new Error(stableCode);
    Object.defineProperty(withStage, "diagnosticStage", { value: "FILE_DACL", enumerable: false });
    const forgedStage = new Error(stableCode);
    Object.defineProperty(forgedStage, "diagnosticStage", { value: "C:\\private\\secret", enumerable: false });

    expect(safeHermesLaunchFailureAssertionContext(withStage)).toBe(`${stableCode}:FILE_DACL`);
    expect(Object.keys(withStage)).not.toContain("diagnosticStage");
    expect(safeHermesLaunchFailureAssertionContext(forgedStage)).toBe(stableCode);
    expect(safeHermesLaunchFailureAssertionContext(new Error("provider secret")))
      .toBe("UNEXPECTED_LAUNCH_FAILURE:name=Error");
  });

  it("rejects forged code-shaped messages and bounds cause metadata depth", () => {
    const forgedCode = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:SECRET_EXFILTRATION");
    const deepest = Object.assign(new Error("hidden fourth cause"), { status: 4 });
    const third = Object.assign(new Error("hidden third cause"), { cause: deepest });
    const second = Object.assign(new Error("hidden second cause"), { cause: third });
    const first = Object.assign(new Error("hidden first cause"), { cause: second });

    const forgedContext = safeHermesLaunchFailureAssertionContext(forgedCode);
    const boundedContext = safeHermesLaunchFailureAssertionContext(first);

    expect(forgedContext).toBe("UNEXPECTED_LAUNCH_FAILURE:name=Error");
    expect(forgedContext).not.toContain("SECRET_EXFILTRATION");
    expect(boundedContext).toBe("UNEXPECTED_LAUNCH_FAILURE:name=Error:cause:name=Error:cause:name=Error");
    expect(boundedContext).not.toContain("status=4");
    expect(boundedContext).not.toMatch(/hidden|fourth|third|second|first/iu);
  });

  it("exposes only allowlisted process failure metadata and redacts messages and paths", () => {
    const childFailure = Object.assign(new Error("C:\\private\\secret\nAPI_KEY=hidden"), {
      status: 5,
      code: "EPERM",
      stdout: "raw stdout secret",
      stderr: "raw stderr token",
      path: "C:\\private\\icacls.exe",
    });
    const unknownFailure = Object.assign(new Error("private payload"), {
      status: 999,
      code: "C:\\private\\secret",
      name: "CredentialError",
      path: "C:\\private\\tool.exe",
    });

    const childContext = safeHermesLaunchFailureAssertionContext(childFailure);
    const unknownContext = safeHermesLaunchFailureAssertionContext(unknownFailure);
    expect(childContext).toBe("UNEXPECTED_LAUNCH_FAILURE:name=Error,status=5,code=EPERM");
    expect(unknownContext).toBe("UNEXPECTED_LAUNCH_FAILURE:name=Error");
    for (const context of [childContext, unknownContext]) {
      expect(context).not.toMatch(/private|secret|API_KEY|stdout|stderr|payload|icacls|credential/iu);
    }
  });
});
