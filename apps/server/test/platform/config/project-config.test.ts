import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../../../src/platform/config/project-config.js";

describe("parseProjectConfig", () => {
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
