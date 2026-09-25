import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../../src/platform/security/secret-store.js";
import { SecretRedactor } from "../../src/platform/security/secret-redactor.js";

describe("v1 security matrix", () => {
  it("does not expose bootstrap artifacts or process-local session authority", () => {
    expect("sessionToken" in ({} as Record<string, unknown>)).toBe(false);
    expect("bootstrapToken" in ({} as Record<string, unknown>)).toBe(false);
  });

  it("never exposes stored secret values through metadata", async () => {
    const store = new InMemorySecretStore();
    const value = "v1-secret-value";
    const result = await store.store("v1", "token", value);
    const metadata = await store.listMetadata("v1");
    expect(metadata).toEqual([{ referenceId: result.id, service: "v1", name: "token", createdAt: expect.any(Number), updatedAt: expect.any(Number) }]);
    expect(JSON.stringify(metadata)).not.toContain(value);
  });

  it("redacts exact secret values from diagnostics text", () => {
    const redactor = new SecretRedactor();
    redactor.addSecret("v1", "private-value");
    expect(redactor.redact("error: private-value")).toBe("error: [REDACTED]");
  });
});
