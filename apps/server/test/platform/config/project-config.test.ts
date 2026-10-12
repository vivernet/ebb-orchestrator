import { describe, expect, it } from "vitest";
import { parseProjectConfig, parseProjectConfigYaml } from "../../../src/platform/config/project-config.js";

describe("parseProjectConfig", () => {
  it("parses the repository YAML document with strict schema validation", () => {
    const result = parseProjectConfigYaml("schema_version: 1\nproject:\n  name: sample\n  default_branch: main\n");
    expect(result).toEqual({
      schema_version: 1,
      project: { name: "sample", default_branch: "main" },
      execution: { mode: "local" },
    });
  });

  it("rejects duplicate keys and non-mapping YAML documents", () => {
    expect(() => parseProjectConfigYaml("schema_version: 1\nschema_version: 1\nproject: {}\n")).toThrow();
    expect(() => parseProjectConfigYaml("- not\n- a mapping\n")).toThrow();
  });

  it("parses a valid V1 config", () => {
    const result = parseProjectConfig({
      schema_version: 1,
      project: { name: "my-project", default_branch: "main" },
    });
    expect(result.schema_version).toBe(1);
    expect(result.project.name).toBe("my-project");
    expect(result.project.default_branch).toBe("main");
    expect(result.execution.mode).toBe("local");
  });

  it("applies default execution mode", () => {
    const result = parseProjectConfig({
      schema_version: 1,
      project: { name: "x", default_branch: "master" },
    });
    expect(result.execution).toEqual({ mode: "local" });
  });

  it("preserves explicitly reviewed executable and ordered arguments in V1 config", () => {
    const result = parseProjectConfigYaml(`schema_version: 1\nproject:\n  name: sample\n  default_branch: main\nexecution:\n  commands:\n    test:\n      executable: pnpm\n      args:\n        - --filter\n        - "@sample/server"\n        - test\n`);

    expect(result.execution).toEqual({
      mode: "local",
      commands: { test: { executable: "pnpm", args: ["--filter", "@sample/server", "test"] } },
    });
  });

  it.each([
    "ash", "bash", "bash.exe", "bosh", "csh", "C:\\\\Windows\\\\System32\\\\cmd.exe", "dash", "elvish", "fish",
    "ksh", "mksh", "nu", "oksh", "osh", "pdksh", "powershell", "pwsh.exe", "rc", "/bin/sh", "tcsh", "xonsh", "yash", "zsh",
    "command.com", "env", "busybox", "wsl.exe",
  ])(
    "rejects shell executable %s from approved Project Config",
    (executable) => {
      expect(() => parseProjectConfig({
        schema_version: 1,
        project: { name: "x", default_branch: "main" },
        execution: { commands: { test: { executable, args: ["-c", "echo unsafe"] } } },
      })).toThrow(/known shell interpreters or launchers are not allowed/i);
    },
  );

  it("rejects unknown command names and command fields", () => {
    expect(() => parseProjectConfig({
      schema_version: 1,
      project: { name: "x", default_branch: "main" },
      execution: { commands: { deploy: { executable: "pnpm", args: [] } } },
    })).toThrow(/unrecognized/i);
    expect(() => parseProjectConfig({
      schema_version: 1,
      project: { name: "x", default_branch: "main" },
      execution: { commands: { test: { executable: "pnpm", args: [], shell: true } } },
    })).toThrow(/unrecognized/i);
  });

  it("bounds executable and argv size before approval", () => {
    const command = { executable: "pnpm", args: [] as string[] };
    const config = (value: typeof command) => ({
      schema_version: 1,
      project: { name: "x", default_branch: "main" },
      execution: { commands: { test: value } },
    });

    expect(() => parseProjectConfig(config({ ...command, executable: "x".repeat(4097) }))).toThrow();
    expect(() => parseProjectConfig(config({ ...command, args: Array.from({ length: 257 }, () => "x") }))).toThrow();
    expect(() => parseProjectConfig(config({ ...command, args: ["x".repeat(8193)] }))).toThrow();
    expect(parseProjectConfig(config({ executable: "x".repeat(4096), args: Array.from({ length: 256 }, () => "x") }))).toBeDefined();
    expect(parseProjectConfig(config({ ...command, args: ["x".repeat(8192)] }))).toBeDefined();
  });

  it("rejects unknown project config fields", () => {
    expect(() =>
      parseProjectConfig({
        schema_version: 1,
        project: { name: "x", default_branch: "master" },
        reocvery: {},
      })
    ).toThrow(/unrecognized/i);
  });

  it("rejects unknown nested project fields", () => {
    expect(() =>
      parseProjectConfig({
        schema_version: 1,
        project: {
          name: "x",
          default_branch: "master",
          unknown_field: "bad",
        },
      })
    ).toThrow(/unrecognized/i);
  });

  it("rejects missing schema_version", () => {
    expect(() =>
      parseProjectConfig({
        project: { name: "x", default_branch: "master" },
      })
    ).toThrow();
  });

  it("rejects wrong schema_version", () => {
    expect(() =>
      parseProjectConfig({
        schema_version: 2,
        project: { name: "x", default_branch: "master" },
      })
    ).toThrow();
  });

  it("rejects missing project name", () => {
    expect(() =>
      parseProjectConfig({
        schema_version: 1,
        project: { default_branch: "master" },
      })
    ).toThrow();
  });

  it("rejects empty project name", () => {
    expect(() =>
      parseProjectConfig({
        schema_version: 1,
        project: { name: "", default_branch: "master" },
      })
    ).toThrow();
  });
});
