import { describe, expect, it } from "vitest";
import { ProcessExecutor } from "../../../src/platform/process/process-executor.js";

describe("ProcessExecutor stdin input", () => {
  it("forwards an explicit bounded payload to child stdin", async () => {
    const input = "mcp_servers:\n  ebb-orchestrator-mcp: {}\n";
    const script = "process.stdin.once('data', data => { process.stdout.write(data); process.exit(0); }); setTimeout(() => { process.stdout.write('NO_STDIN'); process.exit(0); }, 100);";

    const result = await new ProcessExecutor().exec(process.execPath, ["-e", script], {
      timeout: 5_000,
      input,
    });

    expect(result).toMatchObject({ exitCode: 0, stdout: input });
  });
});
