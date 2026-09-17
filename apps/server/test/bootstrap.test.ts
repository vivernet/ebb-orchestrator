import { describe, expect, it } from "vitest";
import { SYSTEM_NAME } from "@ebb-orchestrator/contracts";

describe("workspace", () => {
  it("resolves shared packages", () => {
    expect(SYSTEM_NAME).toBe("ebb-orchestrator");
  });
});
