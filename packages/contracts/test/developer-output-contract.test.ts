import { describe, expect, it } from "vitest";
import { DeveloperOutputSchema } from "../src/roles/developer.js";

describe("DeveloperOutputSchema", () => {
  it("requires a nonblank commit SHA for COMPLETED", () => {
    expect(DeveloperOutputSchema.safeParse({
      version: "1.0.0",
      outcome: "COMPLETED",
    }).success).toBe(false);

    expect(DeveloperOutputSchema.safeParse({
      version: "1.0.0",
      outcome: "COMPLETED",
      commitSha: "   ",
    }).success).toBe(false);

    expect(DeveloperOutputSchema.safeParse({
      version: "1.0.0",
      outcome: "COMPLETED",
      commitSha: "abc123",
    })).toMatchObject({ success: true, data: { outcome: "COMPLETED", commitSha: "abc123" } });
  });

  it("allows BLOCKED without a commit SHA", () => {
    expect(DeveloperOutputSchema.safeParse({
      version: "1.0.0",
      outcome: "BLOCKED",
    })).toMatchObject({ success: true, data: { outcome: "BLOCKED" } });
  });

  it("rejects whitespace-only SHA values when BLOCKED includes one", () => {
    expect(DeveloperOutputSchema.safeParse({
      version: "1.0.0",
      outcome: "BLOCKED",
      commitSha: " \t ",
    }).success).toBe(false);
  });
});
