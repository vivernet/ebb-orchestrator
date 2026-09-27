import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("E2E launcher child shutdown", () => {
  it("waits for graceful backend exit before forcing termination", async () => {
    const launcher = await readFile(resolve("test/e2e/run-e2e.mjs"), "utf8");
    const backendTeardown = launcher.slice(launcher.indexOf('const backend = children.get("backend")'));
    const shutdownRequest = backendTeardown.indexOf('type: "shutdown"');
    const acknowledgementWait = backendTeardown.indexOf("waitForBackendShutdown(backend");
    const exitWait = backendTeardown.indexOf("waitForChildExit(backend");
    const forcedTermination = backendTeardown.indexOf('terminateChild("backend")', exitWait);

    expect(acknowledgementWait).toBeGreaterThanOrEqual(0);
    expect(shutdownRequest).toBeGreaterThan(acknowledgementWait);
    expect(exitWait).toBeGreaterThan(shutdownRequest);
    expect(forcedTermination).toBeGreaterThan(exitWait);
    expect(backendTeardown).not.toMatch(/backend\.disconnect\(\)[\s\S]{0,100}terminateChild\("backend"\)/);
  });
});
