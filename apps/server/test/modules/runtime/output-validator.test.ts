import { describe, expect, it } from "vitest";
import { validateRoleOutput, type ValidatedRoleOutput } from "../../../src/modules/runtime/output-validator.js";
import type { RoleOutput } from "../../../src/modules/runtime/output-validator.js";

describe("validateRoleOutput", () => {
  describe("Developer output validation", () => {
    it("accepts valid COMPLETED outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "COMPLETED",
        summary: "Feature implemented",
      };
      const result = validateRoleOutput("developer", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("COMPLETED");
    });

    it("accepts valid BLOCKED outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "BLOCKED",
        summary: "Waiting on dependency",
        findings: [{ type: "BLOCKING", description: "Missing API key" }],
      };
      const result = validateRoleOutput("developer", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("BLOCKED");
    });

    it("rejects invalid outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "PASS" as any,
        summary: "Should not pass",
      };
      const result = validateRoleOutput("developer", value);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid");
    });
  });

  describe("Reviewer output validation", () => {
    it("accepts valid PASS outcome without findings", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "PASS",
        summary: "Code looks good",
      };
      const result = validateRoleOutput("reviewer", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("PASS");
    });

    it("rejects PASS with blocking findings", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "PASS",
        summary: "Code looks good",
        findings: [{ type: "BLOCKING", description: "Security issue" }],
      };
      const result = validateRoleOutput("reviewer", value);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("PASS");
      expect(result.error).toContain("blocking");
    });

    it("accepts CHANGES_REQUESTED with findings", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "CHANGES_REQUESTED",
        summary: "Need some changes",
        findings: [{ type: "MINOR", description: "Add comments" }],
      };
      const result = validateRoleOutput("reviewer", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("CHANGES_REQUESTED");
    });

    it("accepts BLOCKED outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "BLOCKED",
        summary: "Cannot review",
        findings: [{ type: "BLOCKING", description: "Missing context" }],
      };
      const result = validateRoleOutput("reviewer", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("BLOCKED");
    });
  });

  describe("QA output validation", () => {
    it("accepts valid PASS outcome without failed criteria", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "PASS",
        summary: "All tests passed",
      };
      const result = validateRoleOutput("qa", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("PASS");
    });

    it("rejects PASS with failed required criteria", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "PASS",
        summary: "All tests passed",
        failedCriteria: [{ id: "ac1", required: true, description: "Must work offline" }],
      };
      const result = validateRoleOutput("qa", value);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("PASS");
      expect(result.error).toContain("failed required");
    });

    it("accepts valid FAIL outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "FAIL",
        summary: "Some tests failed",
        failedCriteria: [{ id: "ac1", required: true, description: "Must work offline" }],
      };
      const result = validateRoleOutput("qa", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("FAIL");
    });

    it("accepts BLOCKED outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "BLOCKED",
        summary: "Cannot test",
        findings: [{ type: "BLOCKING", description: "Test environment down" }],
      };
      const result = validateRoleOutput("qa", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("BLOCKED");
    });
  });

  describe("Integration output validation", () => {
    it("accepts valid PASS outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "PASS",
        summary: "Integration successful",
      };
      const result = validateRoleOutput("integration", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("PASS");
    });

    it("accepts valid BLOCKED outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "BLOCKED",
        summary: "Cannot integrate",
        findings: [{ type: "BLOCKING", description: "Merge conflicts" }],
      };
      const result = validateRoleOutput("integration", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("BLOCKED");
    });

    it("rejects invalid outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "FAIL" as any,
        summary: "Should not fail",
      };
      const result = validateRoleOutput("integration", value);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid");
    });
  });
});
