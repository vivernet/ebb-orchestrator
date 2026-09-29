import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function listModuleSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listModuleSources(path)
      : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("runtime schema ownership", () => {
  it("keeps schema creation and alteration in versioned migrations", () => {
    const modulesDirectory = join(import.meta.dirname, "../../../src/modules");
    const moduleSources = listModuleSources(modulesDirectory);
    expect(moduleSources.length).toBeGreaterThan(0);
    for (const sourcePath of moduleSources) {
      const source = readFileSync(sourcePath, "utf8");
      expect(source, sourcePath).not.toMatch(/\b(?:CREATE|ALTER)\s+TABLE\b/i);
      expect(source, sourcePath).not.toMatch(/platform\/database\/migrations\//i);
    }
  });
});
