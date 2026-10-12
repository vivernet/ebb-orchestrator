import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const resolverSource = readFileSync(
  new URL("../../../src/modules/runtime/hermes/hermes-executable-resolver.ts", import.meta.url), "utf8",
);
const runtimeAdapterSource = readFileSync(
  new URL("../../../src/modules/runtime/hermes/hermes-runtime-adapter.ts", import.meta.url), "utf8",
);
const launchTicketSource = readFileSync(
  new URL("../../../src/modules/runtime/hermes/hermes-launch-ticket.ts", import.meta.url), "utf8",
);
const nativeLauncherSource = readFileSync(
  new URL("../../../native/linux-hermes-launcher/ebb-linux-hermes-launcher.cpp", import.meta.url), "utf8",
);

describe("Linux direct installed Hermes launch contract", () => {
  it("builds the ordinary installed-source Python entrypoint and registers Ebb MCP in memory", () => {
    expect(resolverSource).toMatch(/buildHermesInstalledRuntimeArgs/u);
    expect(resolverSource).toMatch(/sys\.path\.insert\(0,/u);
    expect(resolverSource).toMatch(/import hermes_bootstrap/u);
    expect(resolverSource).toMatch(/runpy\.run_module\('hermes_cli\.main'/u);
    expect(resolverSource).toMatch(/register_mcp_servers\(ebb_mcp\)/u);
    expect(resolverSource).not.toMatch(/HermesSnapshotFinder|verifyPinnedGitSource|HERMES_SOURCE_SNAPSHOT_REQUIRED/u);
  });

  it("uses Run-bound executable identities and shared configured Hermes home", () => {
    expect(runtimeAdapterSource).toMatch(/mode: "HERMES_MANAGED", runId, hermesHome: resolution\.hermesConfigHome/u);
    expect(runtimeAdapterSource).toContain("hermesExecutableIdentity: resolution.executableIdentity");
    expect(runtimeAdapterSource).toContain("executableIdentity: resolution.runtimeExecutableIdentity");
    expect(launchTicketSource).toContain("runId");
    expect(launchTicketSource).toContain("hermesHome");
    expect(launchTicketSource).not.toMatch(/snapshot|profileHome|acl|credential|api.?key/iu);
  });

  it("launches Python by exact device/inode and supervises the process tree", () => {
    expect(nativeLauncherSource).toContain("--run-hermes-v3");
    expect(nativeLauncherSource).toContain("openAbsoluteExecutable(pythonPath, expectedPythonDevice, expectedPythonInode)");
    expect(nativeLauncherSource).toContain("execveat(pythonFd.get()");
    expect(nativeLauncherSource).toContain("PR_SET_CHILD_SUBREAPER");
    expect(nativeLauncherSource).toContain("forwardSignal");
    expect(nativeLauncherSource).not.toMatch(/snapshot|projection|AppArmor|source-cache/iu);
  });
});
