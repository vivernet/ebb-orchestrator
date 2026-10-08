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

  it("diagnoses cache-root traversal with bounded categories without changing path checks", () => {
    expect(launcherSource).toContain("int openCacheRootDirectory(const std::string& value)");
    expect(launcherSource).toContain("HERMES_SOURCE_CACHE_ROOT_PATH_INVALID");
    expect(launcherSource).toContain("HERMES_SOURCE_CACHE_ROOT_COMPONENT_OPEN_FAILED_");
    expect(launcherSource).toContain("HERMES_SOURCE_CACHE_ROOT_COMPONENT_METADATA_UNAVAILABLE_");
    expect(launcherSource).toContain("HERMES_SOURCE_CACHE_ROOT_COMPONENT_OWNER_MODE_UNSAFE_");
    expect(launcherSource).toContain("HERMES_SOURCE_CACHE_ROOT_FINAL_OWNER_MODE_UNSAFE");
    expect(launcherSource).toContain("case ENOENT: return \"NO_ENTRY\"");
    expect(launcherSource).toContain("case EACCES:");
    expect(launcherSource).toContain("case ELOOP:");
    expect(launcherSource).toContain("case ENAMETOOLONG: return \"PATH_TOO_LONG\"");
    expect(launcherSource).toContain("constexpr size_t kMaxReportedComponentIndex = 15");
    expect(launcherSource).toContain("directoryPermissionsAreSafe(info, geteuid(), finalComponent)");
    expect(launcherSource).toContain("O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW" );
  });

  it("builds only on Linux and has no shell compiler invocation", () => {
    expect(buildScript).toContain("process.platform !== \"linux\"");
    expect(buildScript).toContain("\"-std=c++17\"");
    expect(buildScript).toContain("shell: false");
    expect(buildScript).not.toMatch(/\bsh\s+-c\b/u);
  });
});
