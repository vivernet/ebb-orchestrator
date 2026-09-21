/**
 * Проверяет изоляцию профиля Hermes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prepareHermesProfile, getOrchestratorHome, getConfigPath, generateConfigYaml } from "../../../src/modules/runtime/hermes/hermes-profile.js";
import * as path from "path";
import * as os from "os";

const normalizePath = (p?: string) => (p ? p.replace(/\\/g, "/") : "");

describe("Hermes profile isolation", () => {
  let originalEnv: Record<string, string | undefined>;
  const mockToolsetPath = "/mock/toolset";

  beforeEach(() => {
    // Сохраняем исходное окружение.
    originalEnv = { ...process.env };
    
    // Настраиваем тестовое окружение.
    process.env.EBB_ORCHESTRATOR_HOME = "/test/orchestrator";
    process.env.GITHUB_TOKEN = "ghp_sensitive_token";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent";
    process.env.HERMES_PROFILE = "personal_profile";
  });

  afterEach(() => {
    // Восстанавливаем исходное окружение.
    process.env = originalEnv;
  });

  describe("getOrchestratorHome", () => {
    it("returns ORCHESTRATOR_HOME when set", () => {
      const home = getOrchestratorHome();
      expect(home).toBe("/test/orchestrator");
    });

    it("falls back to ~/.ebb-orchestrator when not set", () => {
      delete process.env.EBB_ORCHESTRATOR_HOME;
      const home = getOrchestratorHome();
      expect(home).toBe(path.join(os.homedir(), ".ebb-orchestrator"));
    });
  });

  describe("prepareHermesProfile", () => {
    it("sets HERMES_HOME under orchestrator runtime", () => {
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(normalizePath(profile.env.HERMES_HOME)).toBe("/test/orchestrator/runtime/hermes");
    });

    it("sets HOME inside HERMES_HOME for subprocess isolation", () => {
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(normalizePath(profile.env.HOME)).toBe("/test/orchestrator/runtime/hermes/home");
    });

    it("removes GITHUB_TOKEN from environment", () => {
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(profile.env.GITHUB_TOKEN).toBeUndefined();
    });

    it("removes SSH_AUTH_SOCK from environment", () => {
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(profile.env.SSH_AUTH_SOCK).toBeUndefined();
    });

    it("removes inherited personal HERMES_PROFILE", () => {
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(profile.env.HERMES_PROFILE).toBeUndefined();
    });

    it("preserves non-sensitive environment variables", () => {
      process.env.PATH = "/usr/bin";
      process.env.NODE_ENV = "test";
      
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(profile.env.PATH).toBe("/usr/bin");
      expect(profile.env.NODE_ENV).toBe("test");
    });

    it("includes hermesHome in profile", () => {
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(normalizePath(profile.hermesHome)).toBe("/test/orchestrator/runtime/hermes");
    });

    it("includes toolsetName in profile", () => {
      const profile = prepareHermesProfile({
        capability: { role: "Developer", workspace: "/test/workspace" },
        orchestratorHome: "/test/orchestrator",
        toolsetPath: mockToolsetPath,
      });

      expect(profile.toolsetName).toEqual([mockToolsetPath]);
    });
  });

  describe("getConfigPath", () => {
    it("returns correct config path within hermes home", () => {
      const configPath = getConfigPath("/test/orchestrator/runtime/hermes");
      expect(normalizePath(configPath)).toBe("/test/orchestrator/runtime/hermes/config.yaml");
    });
  });

  describe("generateConfigYaml", () => {
    it("generates config.yaml with a Windows-safe absolute MCP launcher", () => {
      const config = generateConfigYaml({
        capability: { role: "Developer", workspace: "/test/workspace" },
        toolsetPath: "/test/toolset",
      });

      expect(config).toContain("mcp_servers:");
      expect(config).toContain("ebb-orchestrator-mcp:");
       expect(config).toContain(`command: ${JSON.stringify(process.execPath)}`);
       expect(config).toContain("ebb-orchestrator-mcp.js");
       expect(config).not.toContain("tsx/esm");
    });

    it("sets terminal.home_mode to profile", () => {
      const config = generateConfigYaml({
        capability: { role: "Developer", workspace: "/test/workspace" },
        toolsetPath: "/test/toolset",
      });

      expect(config).toContain("terminal:");
      expect(config).toContain("home_mode: profile");
    });

    it("includes capability ref in MCP args", () => {
      const config = generateConfigYaml({
        capability: { role: "Developer", workspace: "/test/workspace" },
        toolsetPath: "/test/toolset",
      });

      expect(config).toContain("args:");
    });

    it("only includes orchestrator-managed settings", () => {
      const config = generateConfigYaml({
        capability: { role: "Developer", workspace: "/test/workspace" },
        toolsetPath: "/test/toolset",
      });

      // Должны присутствовать mcp_servers и terminal.
      expect(config).toContain("mcp_servers:");
      expect(config).toContain("terminal:");
      // Произвольные пользовательские настройки присутствовать не должны.
      expect(config).not.toContain("user_");
    });
  });
});
