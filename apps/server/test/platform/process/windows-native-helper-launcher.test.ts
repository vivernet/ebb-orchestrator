import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getNativeHelperIntegrityDigest } from "../../../src/platform/process/native-helper-integrity.js";
import { createWindowsNativeHelperInvocation } from "../../../src/platform/process/windows-native-helper-launcher.js";

vi.mock("../../../src/platform/process/native-helper-integrity.js", () => ({
  getNativeHelperIntegrityDigest: vi.fn(),
}));

describe("Windows native helper PowerShell gate", () => {
  it("suppresses CopyToAsync completion values from the native helper protocol stream", async () => {
    const source = await readFile(new URL("../../../src/platform/process/windows-native-helper-launcher.ts", import.meta.url), "utf8");

    expect(source).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(source).toContain("[void]$stdoutTask.GetAwaiter().GetResult()");
    expect(source).toContain("[void]$stderrTask.GetAwaiter().GetResult()");
    expect(source).not.toMatch(/try\s*\{\s*\$stdoutTask\.GetAwaiter\(\)\.GetResult\(\)\s*\}/u);
    expect(source).not.toMatch(/try\s*\{\s*\$stderrTask\.GetAwaiter\(\)\.GetResult\(\)\s*\}/u);
  });

  it("retains a created inspection process handle and proves cleanup after resume failure", async () => {
    const source = await readFile(new URL("../../../src/platform/process/windows-native-helper-launcher.ts", import.meta.url), "utf8");

    // A ResumeThread failure happens after CreateProcessW created a suspended process.
    // Keep its handle so the caller can terminate and verify that exact process and Job.
    expect(source).toContain("if (ResumeThread(created.hThread) != 1) {");
    expect(source).toContain("process = created.hProcess;\n        created.hProcess = IntPtr.Zero;\n        return false;");
    expect(source).toContain("if ($inspectionProcess -ne [IntPtr]::Zero) {\n        $inspectionAssigned = $true\n        $phase = 'inspection-resume'");
    expect(source).toContain("$processStopped = [EbbNativeHelperGate]::WaitForInspectionProcess($inspectionProcess, 5000)");
    expect(source).toContain("$jobEmpty = -not $inspectionAssigned -or [EbbNativeHelperGate]::WaitForInspectionJobEmpty($inspectionJob, 5000)");
    expect(source).toContain("$failurePhase = 'inspection-cleanup-unproven'");
  });
});

describe.skipIf(process.platform !== "win32" || process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE !== "1")(
  "Windows native helper stdin relay (real binary transport)",
  () => {
    let directory: string;
    let helperPath: string;
    let hangingHelperPath: string;

    beforeAll(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "ebb-helper-stdin-regression-"));
      helperPath = path.join(directory, "handshake.exe");
      hangingHelperPath = path.join(directory, "inspect-hang.exe");
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!systemRoot) throw new Error("WINDOWS_SYSTEM_ROOT_UNAVAILABLE");
      const source = `using System;
using System.Threading;
public class Handshake {
  public static void Main(string[] args) {
    using (var timer = new Timer(delegate { Environment.Exit(91); }, null, 6000, Timeout.Infinite)) {
      var input = Console.OpenStandardInput();
      if (args[0] == "eof") {
        int count = 0, value;
        while ((value = input.ReadByte()) != -1) {
          if (value != count % 251) Environment.Exit(92);
          count++;
        }
        Console.WriteLine("EOF:" + count); Console.Out.Flush();
        return;
      }
      byte[] frame = new byte[131072]; int length = 0;
      while (length < frame.Length) {
        int count = input.Read(frame, length, frame.Length - length);
        if (count == 0) Environment.Exit(93);
        length += count;
      }
      for (int i = 0; i < frame.Length; i++) if (frame[i] != i % 251) Environment.Exit(94);
      Console.WriteLine("FRAME"); Console.Out.Flush();
      if (input.ReadByte() != 0xa5) Environment.Exit(95);
      Console.WriteLine("ACK"); Console.Out.Flush();
      Console.Error.WriteLine("HELPER_STDERR"); Console.Error.Flush();
      Environment.Exit(37);
    }
  }
}`;
      const compilation = `Add-Type -TypeDefinition @'\n${source}\n'@ -OutputAssembly '${helperPath.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
      const child = spawn(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(compilation, "utf16le").toString("base64"),
      ], { stdio: ["pipe", "pipe", "pipe"] });
      const result = collectChild(child);
      child.stdin.end();
      expect(await result.exit).toBe(0);
      vi.mocked(getNativeHelperIntegrityDigest).mockResolvedValue(createHash("sha256").update(await readFile(helperPath)).digest("hex"));

      const hangingSource = `using System;
using System.Threading;
public class HangingInspect {
  public static void Main(string[] args) {
    Console.WriteLine(System.Diagnostics.Process.GetCurrentProcess().Id);
    Console.Out.Flush();
    while (true) Thread.Sleep(1000);
  }
}`;
      const hangingCompilation = `Add-Type -TypeDefinition @'\n${hangingSource}\n'@ -OutputAssembly '${hangingHelperPath.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
      const hangingBuild = spawn(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(hangingCompilation, "utf16le").toString("base64"),
      ], { stdio: ["pipe", "pipe", "pipe"] });
      const hangingBuildResult = collectChild(hangingBuild);
      hangingBuild.stdin.end();
      expect(await hangingBuildResult.exit).toBe(0);
    }, 20_000);

    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("delivers a one-byte ACK after a large binary frame while parent stdin remains open", async () => {
      const invocation = await createWindowsNativeHelperInvocation(helperPath, "windowsRunSupervisor", ["ack"]);
      const child = spawn(invocation.file, [...invocation.args], { env: invocation.env, stdio: ["pipe", "pipe", "pipe"] });
      const result = collectChild(child);
      try {
        const frame = Buffer.alloc(131_072);
        for (let index = 0; index < frame.length; index++) frame[index] = index % 251;
        child.stdin.write(frame);
        await waitForOutput(result, "FRAME");
        child.stdin.write(Buffer.from([0xa5]));
        // Exit must arrive while stdin is open: waiting for the relay itself would deadlock.
        expect(await result.exit).toBe(37);
        expect(child.stdin.writableEnded).toBe(false);
        expect(result.stdout()).toBe("FRAME\r\nACK\r\n");
        expect(result.stderr()).toBe("HELPER_STDERR\r\n");
      } finally {
        child.stdin.end();
        await result.exit;
      }
    }, 15_000);

    it("flushes the final short binary chunk and closes child stdin before waiting for exit", async () => {
      const invocation = await createWindowsNativeHelperInvocation(helperPath, "windowsRunSupervisor", ["eof"]);
      const child = spawn(invocation.file, [...invocation.args], { env: invocation.env, stdio: ["pipe", "pipe", "pipe"] });
      const result = collectChild(child);
      child.stdin.end(Buffer.from([0, 1, 2, 3, 4]));
      expect(await result.exit).toBe(0);
      expect(result.stdout()).toBe("EOF:5\r\n");
      expect(result.stderr()).toBe("");
    }, 15_000);

    it("kills and waits for a digest-pinned inspection helper before the bounded gate returns", async () => {
      vi.mocked(getNativeHelperIntegrityDigest).mockResolvedValue(
        createHash("sha256").update(await readFile(hangingHelperPath)).digest("hex"),
      );
      const invocation = await createWindowsNativeHelperInvocation(hangingHelperPath, "windowsRunSupervisor", ["inspect"]);
      expect(invocation.args[4]!.length).toBeLessThan(32767);
      const child = spawn(invocation.file, [...invocation.args], { env: invocation.env, stdio: ["pipe", "pipe", "pipe"] });
      const result = collectChild(child);
      child.stdin.end();
      let pid: number | undefined;
      let completion: "exited" | "deadline";
      let wrapperTeardownUnproven: boolean;
      try {
        const started = await Promise.race([
          waitForPidOutput(result).then((value) => ({ kind: "pid" as const, value })),
          result.exit.then(() => ({ kind: "exit" as const })),
        ]);
        if (started.kind === "exit") throw new Error(`TEST_GATE_EXITED_BEFORE_HELPER_PID:${result.stderr()}`);
        pid = started.value;
        completion = await Promise.race([
          result.exit.then(() => "exited" as const),
          new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 12_000)),
        ]);
        expect(completion).toBe("exited");
        expect(result.exitCode()).toBe(126);
        expect(result.stderr()).toContain("NATIVE_HELPER_GATE_FAIL:inspection-timeout:TimeoutException");
        expect(await isProcessAlive(pid)).toBe(false);
        expect(`${result.stdout()}${result.stderr()}`).not.toMatch(/OPENAI_API_KEY|C:\\\\Users|inspect-hang/i);
      } finally {
        if (pid && await isProcessAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* teardown below verifies disappearance */ }
          await waitForProcessExit(pid);
        }
        if (child.exitCode === null) child.kill("SIGKILL");
        const wrapperExited = await Promise.race([
          result.exit.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ]);
        wrapperTeardownUnproven = !wrapperExited;
      }
      if (wrapperTeardownUnproven) throw new Error("TEST_GATE_TEARDOWN_UNPROVEN");
    }, 30_000);
  },
);

function collectChild(child: ChildProcessWithoutNullStreams): {
  readonly exit: Promise<number | null>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exitCode: () => number | null;
} {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exit, stdout: () => stdout, stderr: () => stderr, exitCode: () => child.exitCode };
}

async function waitForOutput(result: ReturnType<typeof collectChild>, marker: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!result.stdout().includes(marker) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect(result.stdout()).toContain(marker);
}

async function waitForPidOutput(result: ReturnType<typeof collectChild>): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = Number.parseInt(result.stdout().split(/\r?\n/u)[0] ?? "", 10);
    if (Number.isSafeInteger(value) && value > 0) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("TEST_INSPECT_HELPER_PID_UNAVAILABLE");
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("TEST_INSPECT_HELPER_TEARDOWN_UNPROVEN");
}
