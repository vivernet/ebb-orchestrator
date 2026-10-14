import { describe, expect, it } from "vitest";
import { validateRoleOutput } from "../../../src/modules/runtime/output-validator.js";
import type { RoleOutput } from "../../../src/modules/runtime/output-validator.js";

describe("validateRoleOutput", () => {
  describe("Developer output validation", () => {
    it("rejects COMPLETED without the commit SHA required by Plan04 acceptance", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "COMPLETED",
        summary: "Feature implemented",
      };
      const result = validateRoleOutput("developer", value);
      expect(result.valid).toBe(false);
    });

    it("accepts COMPLETED with a nonblank commit SHA", () => {
      const value: RoleOutput = {
        version: "1.0.0",
        outcome: "COMPLETED",
        summary: "Feature implemented",
        commitSha: "abc123",
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

    it("allows BLOCKED without a commit SHA", () => {
      const result = validateRoleOutput("developer", {
        version: "1.0.0",
        outcome: "BLOCKED",
        summary: "Waiting on dependency",
      });
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("BLOCKED");
    });

    it("rejects invalid outcome", () => {
      const value: RoleOutput = {
        version: "1.0.0",
         outcome: "PASS" as RoleOutput["outcome"],
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

    it("accepts explicit updates to existing stable finding IDs", () => {
      const result = validateRoleOutput("reviewer", {
        version: "1.0.0",
        outcome: "PASS",
        finding_updates: [
          { id: "FINDING-3", status: "RESOLVED" },
          { id: "FINDING-8", status: "STILL_PRESENT" },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects malformed or duplicate finding updates", () => {
      expect(validateRoleOutput("reviewer", {
        version: "1.0.0", outcome: "PASS", finding_updates: [{ id: "not-a-finding", status: "RESOLVED" }],
      }).valid).toBe(false);
      expect(validateRoleOutput("reviewer", {
        version: "1.0.0", outcome: "PASS", finding_updates: [
          { id: "FINDING-3", status: "RESOLVED" },
          { id: "FINDING-3", status: "STILL_PRESENT" },
        ],
      }).valid).toBe(false);
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

    it("accepts explicit updates to existing stable defect IDs", () => {
      const result = validateRoleOutput("qa", {
        version: "1.0.0",
        outcome: "PASS",
        defect_updates: [{ id: "DEFECT-2", status: "RESOLVED" }],
      });
      expect(result.valid).toBe(true);
    });

    it("rejects duplicate failed criteria and malformed defect updates", () => {
      expect(validateRoleOutput("qa", {
        version: "1.0.0", outcome: "FAIL", failedCriteria: [
          { id: "AC-1", required: true, description: "Criterion" },
          { id: "AC-1", required: true, description: "Criterion" },
        ],
      }).valid).toBe(false);
      expect(validateRoleOutput("qa", {
        version: "1.0.0", outcome: "PASS", defect_updates: [{ id: "FINDING-1", status: "RESOLVED" }],
      }).valid).toBe(false);
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
        baseSha: "target-sha",
        sourceSha: "source-sha",
        provenance: ["integration_attempt:attempt-1"],
        evidence: ["Verified merged commit contains the prepared source SHA"],
      };
      const result = validateRoleOutput("integration", value);
      expect(result.valid).toBe(true);
      expect(result.outcome).toBe("PASS");
    });

    it("rejects PASS without SHA, exact-attempt provenance, or evidence", () => {
      const result = validateRoleOutput("integration", {
        version: "1.0.0",
        outcome: "PASS",
        summary: "Integration successful",
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Schema validation failed");
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
         outcome: "FAIL" as RoleOutput["outcome"],
        summary: "Should not fail",
      };
      const result = validateRoleOutput("integration", value);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid");
    });
  });
});
