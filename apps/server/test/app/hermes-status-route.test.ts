import Fastify from "fastify";
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesStatusRoutes } from "../../src/app/routes/hermes-status.js";
import { listSupportedModels } from "../../src/modules/runtime/hermes/hermes-provider-registry.js";
import type { HermesExecutableResolution } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";

const originalEnv = {
  home: process.env.EBB_ORCHESTRATOR_HOME,
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
};

function restoreOrchestratorEnv(): void {
  if (originalEnv.home === undefined) delete process.env.EBB_ORCHESTRATOR_HOME;
  else process.env.EBB_ORCHESTRATOR_HOME = originalEnv.home;
  if (originalEnv.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalEnv.openai;
  if (originalEnv.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalEnv.anthropic;
}

/** Пустой временный home: загрузчик возвращает {}, все keyConfigured = false. */
async function withEmptyOrchestratorHome(fn: () => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "ebb-status-unit-home-"));
  try {
    process.env.EBB_ORCHESTRATOR_HOME = home;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await fn();
  } finally {
    restoreOrchestratorEnv();
    rmSync(home, { recursive: true, force: true });
  }
}

const fakeResolution = {
  executablePath: "C:/fake/hermes.exe",
  executableIdentity: { platform: "win32", volumeSerial: "0".repeat(16), fileId: "0".repeat(32) },
  runtimeExecutablePath: "C:/fake/python.exe",
  runtimeExecutableIdentity: { platform: "win32", volumeSerial: "0".repeat(16), fileId: "0".repeat(32) },
  hermesProjectRoot: "C:/fake",
  sourceCommit: null,
  hermesConfigHome: "C:/fake/home",
} as unknown as HermesExecutableResolution;

const expectedModelSelection = listSupportedModels().map((entry) => ({
  model: entry.model,
  provider: entry.provider,
  keyConfigured: false,
}));

test("returns Hermes status with resolved version and registry model selection", async () => {
  await withEmptyOrchestratorHome(async () => {
    const app = Fastify();
    await hermesStatusRoutes(app, {
      resolveHermesExecutable: async () => fakeResolution,
      probeHermesVersion: async () => "v1.2.3",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/hermes/status" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      hermesVersion: "v1.2.3",
      defaultProvider: "hermes-managed",
      defaultModel: "default",
      keyConfigured: false,
      modelSelection: expectedModelSelection,
    });
    expect(response.body).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(response.body).not.toContain("OPENAI_API_KEY");
    await app.close();
  });
});

test("reports null hermesVersion when executable resolution fails", async () => {
  await withEmptyOrchestratorHome(async () => {
    const app = Fastify();
    await hermesStatusRoutes(app, {
      resolveHermesExecutable: async () => {
        throw new Error("HERMES_LAUNCHER_NOT_FOUND");
      },
      probeHermesVersion: async () => "should-not-run",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/hermes/status" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.hermesVersion).toBeNull();
    expect(body.defaultProvider).toBe("hermes-managed");
    expect(body.defaultModel).toBe("default");
    expect(body.keyConfigured).toBe(false);
    expect(body.modelSelection).toEqual(expectedModelSelection);
    await app.close();
  });
});

test("reports null hermesVersion when the version probe returns null", async () => {
  await withEmptyOrchestratorHome(async () => {
    const app = Fastify();
    await hermesStatusRoutes(app, {
      resolveHermesExecutable: async () => fakeResolution,
      probeHermesVersion: async () => null,
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/hermes/status" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).hermesVersion).toBeNull();
    await app.close();
  });
});
