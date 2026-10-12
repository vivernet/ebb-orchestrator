import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const launcherSource = readFileSync(
  new URL("../../native/linux-hermes-launcher/ebb-linux-hermes-launcher.cpp", import.meta.url),
  "utf8",
);
const buildScript = readFileSync(new URL("../../scripts/build-linux-hermes-launcher.mjs", import.meta.url), "utf8");

describe("Linux direct-installed Hermes native launch contract", () => {
  it("uses the v3 direct Python ABI and exact executable identities", () => {
    expect(launcherSource).toContain('std::string(argv[1]) != "--run-hermes-v3"');
    expect(launcherSource).toContain("openAbsoluteExecutable(shimPath, expectedShimDevice, expectedShimInode)");
    expect(launcherSource).toContain("openAbsoluteExecutable(pythonPath, expectedPythonDevice, expectedPythonInode)");
    expect(launcherSource).toContain('execveat(pythonFd.get(), "", argumentPointers.data(), environmentPointers.data(), AT_EMPTY_PATH)');
    expect(launcherSource).toContain("argv[12 + index]");
    expect(launcherSource).toContain("12 + argumentCount");
    expect(launcherSource).not.toMatch(/\b(execvp|execlp|system)\s*\(/u);
  });

  it("inherits the configured Hermes home without inspecting it or other host permissions", () => {
    expect(launcherSource).toContain("entries.push_back(item)");
    expect(launcherSource).not.toMatch(/open\w*\(hermesHome|stat\w*\(hermesHome/u);
    expect(launcherSource).not.toMatch(/entries\.push_back\("(?:HERMES_HOME|HERMES_PROFILE|HERMES_CONFIG|HOME)=/u);
    expect(launcherSource).not.toMatch(/st_uid|st_gid|S_IWGRP|S_IWOTH|apparmor/iu);
  });

  it("launches without source copying, cache leases, mounts or namespaces", () => {
    expect(launcherSource).not.toMatch(/snapshot|projection|Sha256|flock|unshare|mount|CLONE_NEW/iu);
    expect(launcherSource).toContain("HERMES_LINUX_LAUNCH_REFUSED:");
    expect(launcherSource).toContain("isUuidV4(runId)");
    expect(launcherSource).toContain("isHexNonce(nonce)");
  });

  it("forwards signals and reaps descendants within the owning systemd cgroup", () => {
    expect(launcherSource).toContain("kill(pid, signalNumber)");
    expect(launcherSource).toContain("PR_SET_CHILD_SUBREAPER");
    expect(launcherSource).toContain("waitpid(-1, &descendantStatus, 0)");
    expect(launcherSource).toContain("sigprocmask(SIG_BLOCK");
    expect(launcherSource).toContain("128 + WTERMSIG(status)");
  });

  it("builds on Linux with a typed compiler invocation", () => {
    expect(buildScript).toContain('process.platform !== "linux"');
    expect(buildScript).toContain('"-std=c++17"');
    expect(buildScript).toContain("shell: false");
  });
});
