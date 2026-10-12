import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyHermesSourceCheckout } from "../../../src/modules/runtime/hermes/hermes-source-integrity.js";
import { buildHermesInstalledRuntimeArgs } from "../../../src/modules/runtime/hermes/hermes-executable-resolver.js";

let fixtureRoot = "";
afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("Hermes source checkout identity", () => {
  it("accepts only the exact clean checkout commit", async () => {
    const fixture = await gitFixture();
    await expect(verifyHermesSourceCheckout(fixture.source, fixture.commit)).resolves.toBeUndefined();
  });

  it("rejects a new HEAD while the install stamp still records the old approved commit", async () => {
    const fixture = await gitFixture();
    await writeFile(path.join(fixture.source, "hermes_cli", "later.py"), "value = 2\n");
    git(fixture.source, ["add", "."]);
    git(fixture.source, ["commit", "--quiet", "-m", "updated source"]);
    await expectStampUnchanged(fixture.source, fixture.commit);
    await expect(verifyHermesSourceCheckout(fixture.source, fixture.commit))
      .rejects.toThrow("HERMES_SOURCE_IDENTITY_MISMATCH");
  });

  it("rejects modified tracked Python source with an unchanged install stamp", async () => {
    const fixture = await gitFixture();
    await writeFile(path.join(fixture.source, "hermes_cli", "main.py"), "value = 2\n");
    await expectStampUnchanged(fixture.source, fixture.commit);
    await expect(verifyHermesSourceCheckout(fixture.source, fixture.commit))
      .rejects.toThrow("HERMES_SOURCE_IDENTITY_DIRTY");
  });

  it("rejects an untracked importable Python module with an unchanged install stamp", async () => {
    const fixture = await gitFixture();
    await writeFile(path.join(fixture.source, "hermes_cli", "injected.py"), "value = 'untracked'\n");
    await expectStampUnchanged(fixture.source, fixture.commit);
    await expect(verifyHermesSourceCheckout(fixture.source, fixture.commit))
      .rejects.toThrow("HERMES_SOURCE_IDENTITY_DIRTY");
  });

  it("does not allow a global excludes override to hide ordinary untracked source", async () => {
    const fixture = await gitFixture();
    const excludes = path.join(fixtureRoot, "excludes");
    await writeFile(excludes, "injected.py\n");
    await writeFile(path.join(fixtureRoot, ".gitconfig"), `[core]\nexcludesFile = ${JSON.stringify(excludes.replaceAll("\\", "/"))}\n`);
    vi.stubEnv("HOME", fixtureRoot);
    await writeFile(path.join(fixture.source, "hermes_cli", "injected.py"), "value = 'untracked'\n");
    await expect(verifyHermesSourceCheckout(fixture.source, fixture.commit))
      .rejects.toThrow("HERMES_SOURCE_IDENTITY_DIRTY");
  });

  it("does not refresh the installation Git index during a read-only source check", async () => {
    const fixture = await gitFixture();
    await utimes(path.join(fixture.source, "hermes_cli", "main.py"), new Date(0), new Date(0));
    const index = path.join(fixture.source, ".git", "index");
    const before = await readFile(index);
    await verifyHermesSourceCheckout(fixture.source, fixture.commit);
    expect(await readFile(index)).toEqual(before);
  });

  it("checks source again before Python imports and ignores inherited Git config overrides", async () => {
    const fixture = await gitFixture();
    const excludes = path.join(fixtureRoot, "excludes");
    await writeFile(excludes, "injected.py\n");
    const env = {
      ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: excludes,
      GIT_DIR: path.join(fixtureRoot, "wrong-git-directory"), GIT_WORK_TREE: fixtureRoot,
    };
    const args = bootstrapArgs(fixture);
    expect(python(args, env).stdout.trim()).toBe("HERMES_FIXTURE_MAIN");
    await writeFile(path.join(fixture.source, "hermes_cli", "injected.py"), "value = 'untracked'\n");
    const result = python(args, env);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("HERMES_SOURCE_IDENTITY_DIRTY");
  });

  it.each(["tracked", "head"])("fails before the first Hermes import when %s source changes after resolution", async (change) => {
    const fixture = await gitFixture();
    const args = bootstrapArgs(fixture);
    await writeFile(path.join(fixture.source, "hermes_cli", "main.py"), "raise RuntimeError('must not import dirty source')\n");
    if (change === "head") {
      git(fixture.source, ["add", "."]);
      git(fixture.source, ["commit", "--quiet", "-m", "changed after resolution"]);
    }
    const result = python(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(change === "head" ? "HERMES_SOURCE_IDENTITY_MISMATCH" : "HERMES_SOURCE_IDENTITY_DIRTY");
  });

  it("checks source again after hermes_bootstrap and before importing the CLI", async () => {
    const fixture = await gitFixture("from pathlib import Path\nPath(__file__).parent.joinpath('hermes_cli', 'injected.py').write_text('value = 2\\n')\n");
    const result = python(bootstrapArgs(fixture));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("HERMES_SOURCE_IDENTITY_DIRTY");
  });

  it("bounds Python Git output before allocation and kills an over-limit child", async () => {
    const fixture = await gitFixture();
    const bootstrap = bootstrapArgs(fixture)[3] ?? "";
    const verifier = bootstrap.slice(0, bootstrap.indexOf("sys.path.insert(0,"));
    const fake = [
      "class Output:",
      "    def read(self, size=-1):",
      "        print('GIT_READ_BOUND=' + str(size), flush=True)",
      "        return b'x' * (size if size > 0 else 100000)",
      "    def close(self): pass",
      "class Child:",
      "    stdout = Output()",
      "    returncode = None",
      "    def poll(self): return self.returncode",
      "    def kill(self):",
      "        self.returncode = -9",
      "        print('GIT_CHILD_KILLED', flush=True)",
      "    def wait(self, timeout=None): return self.returncode",
      "subprocess.Popen = lambda *args, **kwargs: Child()",
      "ebb_verify_hermes_source()",
    ].join("\n");
    const result = python(["-I", "-B", "-c", verifier + fake]);
    expect(result.status).toBe(1);
    expect(result.stdout.replaceAll("\r\n", "\n")).toBe("GIT_READ_BOUND=8193\nGIT_CHILD_KILLED\n");
    expect(result.stderr.trim()).toBe("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
  });

  it("bounds a hanging Python Git reader and kills the child on timeout", async () => {
    const fixture = await gitFixture();
    const bootstrap = bootstrapArgs(fixture)[3] ?? "";
    const verifier = bootstrap.slice(0, bootstrap.indexOf("sys.path.insert(0,"));
    const fake = [
      "release = threading.Event()",
      "class Output:",
      "    def read(self, size=-1):",
      "        release.wait(timeout=30)",
      "        return b''",
      "    def close(self): pass",
      "class Child:",
      "    stdout = Output()",
      "    returncode = None",
      "    def poll(self): return self.returncode",
      "    def kill(self):",
      "        self.returncode = -9",
      "        release.set()",
      "        print('GIT_CHILD_KILLED', flush=True)",
      "    def wait(self, timeout=None): return self.returncode",
      "subprocess.Popen = lambda *args, **kwargs: Child()",
      "ebb_verify_hermes_source()",
    ].join("\n");
    const started = performance.now();
    const result = python(["-I", "-B", "-c", verifier + fake]);
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("GIT_CHILD_KILLED");
    expect(result.stderr.trim()).toBe("HERMES_SOURCE_IDENTITY_UNAVAILABLE");
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 10_000);
});

async function gitFixture(bootstrap = "value = 1\n"): Promise<{ source: string; commit: string }> {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "ebb-hermes-source-integrity-"));
  const source = path.join(fixtureRoot, "hermes-agent");
  await mkdir(path.join(source, "hermes_cli"), { recursive: true });
  await writeFile(path.join(source, ".gitignore"), "/install-stamp.json\n");
  await writeFile(path.join(source, "hermes_cli", "main.py"), "print('HERMES_FIXTURE_MAIN')\n");
  await writeFile(path.join(source, "hermes_bootstrap.py"), bootstrap);
  git(source, ["init", "--quiet"]);
  git(source, ["config", "user.email", "acceptance@example.invalid"]);
  git(source, ["config", "user.name", "Acceptance Fixture"]);
  git(source, ["add", "."]);
  git(source, ["commit", "--quiet", "-m", "pinned source"]);
  const commit = git(source, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(source, "install-stamp.json"), JSON.stringify({ commit }));
  return { source, commit };
}

async function expectStampUnchanged(source: string, commit: string): Promise<void> {
  const stamp = JSON.parse(await readFile(path.join(source, "install-stamp.json"), "utf8")) as { commit: string };
  expect(stamp.commit).toBe(commit);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.excludesFile=", ...args], { cwd, encoding: "utf8", windowsHide: true });
}

function bootstrapArgs(fixture: { source: string; commit: string }): readonly string[] {
  const runtimeExecutablePath = process.platform === "win32" ? "C:\\Python\\python.exe" : "/usr/bin/python3";
  return buildHermesInstalledRuntimeArgs({
    hermesProjectRoot: fixture.source, sourceCommit: fixture.commit,
    runtimeExecutablePath, hermesHome: path.join(fixtureRoot, "unused-home"),
  });
}

function python(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  // Только tiny source fixture: Hermes/provider/config/auth не импортируются.
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", [...args], {
    env, encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 8 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
