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
});

describe.skipIf(process.platform !== "win32" || process.env.EBB_RUN_NATIVE_SCOPE_ACCEPTANCE !== "1")(
  "Windows native helper stdin relay (real binary transport)",
  () => {
    let directory: string;
    let helperPath: string;

    beforeAll(async () => {
      directory = await mkdtemp(path.join(tmpdir(), "ebb-helper-stdin-regression-"));
      helperPath = path.join(directory, "handshake.exe");
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
  },
);

function collectChild(child: ChildProcessWithoutNullStreams): {
  readonly exit: Promise<number | null>;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString("utf8"); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exit, stdout: () => stdout, stderr: () => stderr };
}

async function waitForOutput(result: ReturnType<typeof collectChild>, marker: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!result.stdout().includes(marker) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect(result.stdout()).toContain(marker);
}
