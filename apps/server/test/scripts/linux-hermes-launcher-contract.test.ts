import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const launcherSource = readFileSync(
  new URL("../../native/linux-hermes-launcher/ebb-linux-hermes-launcher.cpp", import.meta.url),
  "utf8",
);
const buildScript = readFileSync(new URL("../../scripts/build-linux-hermes-launcher.mjs", import.meta.url), "utf8");

describe("Linux Hermes native launch boundary source contract", () => {
  it("pins the Python ELF and refuses shell or PATH-based Hermes execution", () => {
    expect(launcherSource).toContain("execveat(pythonFd.get(), \"\", argumentPointers.data(), environmentPointers.data(), AT_EMPTY_PATH)");
    expect(launcherSource).toContain("openAbsoluteExecutable(pythonPath, expectedPythonDevice, expectedPythonInode)");
    expect(launcherSource).toContain("openAbsoluteExecutable(shimPath, expectedShimDevice, expectedShimInode)");
    expect(launcherSource).toContain("argumentCount < 3");
    expect(launcherSource).not.toMatch(/\b(execvp|execlp|system)\s*\(/u);
    expect(launcherSource).not.toMatch(/\/bin\/sh|\bhermes\s+--/iu);
  });

  it("mounts a private per-Run profile view and keeps the Hermes lexical profile path", () => {
    expect(launcherSource).toContain("unshare(CLONE_NEWUSER | CLONE_NEWNS)");
    expect(launcherSource).toContain("attachPrivateProfilesTmpfs(profilesFd.get())");
    expect(launcherSource).toContain("attachDetachedMount(profileTree.get(), profileTargetFd.get())");
    expect(launcherSource).toContain("mountedProfileInfo.st_dev != profileInfo.st_dev");
    expect(launcherSource).toContain("HERMES_HOME=\" + profilePath");
    expect(launcherSource).toContain("HERMES_LINUX_LAUNCH_REFUSED:");
  });

  it("verifies the bounded source projection and holds a read-only source lease through descendants", () => {
    expect(launcherSource).toContain("parseSnapshotProjection");
    expect(launcherSource).toContain("verifySnapshotTree");
    expect(launcherSource).toContain("O_NOFOLLOW");
    expect(launcherSource).toContain("MOUNT_ATTR_RDONLY");
    expect(launcherSource).toContain("flock(lock.get(), LOCK_SH | LOCK_NB)");
    expect(launcherSource).toContain("PR_SET_CHILD_SUBREAPER");
    expect(launcherSource).toContain("waitpid(-1, &descendantStatus, 0)");
    expect(launcherSource).toContain("HERMES_SOURCE_PROJECTION_UNAVAILABLE");
    expect(launcherSource).toContain("HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH");
  });

  it("builds only on Linux and has no shell compiler invocation", () => {
    expect(buildScript).toContain("process.platform !== \"linux\"");
    expect(buildScript).toContain("\"-std=c++17\"");
    expect(buildScript).toContain("shell: false");
    expect(buildScript).not.toMatch(/\bsh\s+-c\b/u);
  });
});
