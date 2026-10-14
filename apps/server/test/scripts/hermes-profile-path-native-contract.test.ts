import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtimeAdapterSource = readFileSync(
  new URL("../../src/modules/runtime/hermes/hermes-runtime-adapter.ts", import.meta.url),
  "utf8",
);
const launchTicketSource = readFileSync(
  new URL("../../src/modules/runtime/hermes/hermes-launch-ticket.ts", import.meta.url),
  "utf8",
);
const windowsSupervisorSource = readFileSync(
  new URL("../../src/platform/process/windows-job-supervisor.ts", import.meta.url),
  "utf8",
);
const linuxLauncherSource = readFileSync(
  new URL("../../native/linux-hermes-launcher/ebb-linux-hermes-launcher.cpp", import.meta.url),
  "utf8",
);
const hermesProfilePathHelperSource = readFileSync(
  new URL("../../native/hermes-profile-path/ebb-hermes-profile-path.cpp", import.meta.url),
  "utf8",
);

describe("direct installed Hermes launch contract", () => {
  it("uses the shared Hermes home and binds each launch ticket to its Run", () => {
    expect(runtimeAdapterSource).toMatch(/mode: "HERMES_MANAGED", runId, hermesHome: resolution\.hermesConfigHome/u);
    expect(runtimeAdapterSource).not.toMatch(/createHermesRunProfileHome|writeHermesRunProfileConfig|readHermesProviderSelection/u);
    expect(launchTicketSource).toContain("runId");
    expect(launchTicketSource).toContain("hermesHome");
    expect(launchTicketSource).not.toMatch(/snapshot|profileHome|acl|credential|api.?key/iu);
  });

  it("passes direct installed-runtime identities to the Windows Job supervisor", () => {
    const encoder = /function encodeMetadataFrame\([\s\S]*?\n\}/u.exec(windowsSupervisorSource)?.[0] ?? "";
    expect(encoder).toMatch(/addU32\(launchIdentity \? 0x45424236 : 0x45424233\)/u);
    expect(encoder).toContain("launchIdentity.hermesExecutablePath");
    expect(encoder).toContain("launchIdentity.hermesExecutableIdentity");
    expect(encoder).not.toMatch(/snapshot|projection|profileHome/iu);
  });

  it("runs the installed Linux Python image and preserves process supervision", () => {
    expect(linuxLauncherSource).toContain("--run-hermes-v3");
    expect(linuxLauncherSource).toContain("execveat(pythonFd.get()");
    expect(linuxLauncherSource).toContain("PR_SET_CHILD_SUBREAPER");
    expect(linuxLauncherSource).toContain("forwardSignal");
    expect(linuxLauncherSource).not.toMatch(/snapshot|projection|AppArmor|source-cache/iu);
  });

  it("reports sanitized stages for Windows file identity failures", () => {
    expect(hermesProfilePathHelperSource).toContain("kPathFileIdQueryFailed = 34");
    expect(hermesProfilePathHelperSource).toContain("kPathFinalPathQueryFailed = 35");
    expect(hermesProfilePathHelperSource).toContain("kPathExpectedPathMismatch = 36");
    expect(hermesProfilePathHelperSource).toContain("kPathUtf8ConversionFailed = 37");
    expect(hermesProfilePathHelperSource).toContain('"HERMES_PATH_IDENTITY_" << stage');
    expect(hermesProfilePathHelperSource).toContain('reportIdentityFailure("FILE_ID_QUERY_FAILED", error, true)');
    expect(hermesProfilePathHelperSource).toContain('reportIdentityFailure("FINAL_PATH_QUERY_FAILED", finalPathError, true)');
    expect(hermesProfilePathHelperSource).toContain('reportIdentityFailure("EXPECTED_PATH_FORMAT_UNSUPPORTED")');
    expect(hermesProfilePathHelperSource).toContain('reportIdentityFailure("FINAL_PATH_FORMAT_UNSUPPORTED")');
    expect(hermesProfilePathHelperSource).toMatch(/reportIdentityFailure\(driveMatches\s*\?\s*"SAME_DRIVE_PATH_MISMATCH"\s*:\s*"DRIVE_MISMATCH"\)/u);
    expect(hermesProfilePathHelperSource).toContain('reportIdentityFailure("UTF8_CONVERSION_FAILED")');
    expect(hermesProfilePathHelperSource).toMatch(/GetFinalPathNameByHandleW\([\s\S]*?\);\s*const DWORD finalPathError = GetLastError\(\);/u);
    expect(hermesProfilePathHelperSource).toContain("bool normalizeDosDrivePath(");
    expect(hermesProfilePathHelperSource).toContain("normalizeDosDrivePath(std::wstring(finalPath.data(), length), normalizedFinalPath)");
    expect(hermesProfilePathHelperSource).toContain("normalizeDosDrivePath(expectedPath, normalizedExpectedPath)");
    const diagnosticReporter = /void reportIdentityFailure\([\s\S]*?\n\}/u.exec(hermesProfilePathHelperSource)?.[0] ?? "";
    expect(diagnosticReporter).not.toMatch(/filename|expectedPath|canonicalPath/iu);
  });
});
