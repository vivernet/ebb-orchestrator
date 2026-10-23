import { describe, expect, it } from "vitest";
import {
  ErrorClassifier,
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_SPECS,
  classifyProviderError,
} from "../../../src/modules/runtime/provider-errors.js";

describe("provider-errors taxonomy", () => {
  describe("classifyProviderError on stderr text", () => {
    it("classifies 401 as auth", () => {
      const classification = classifyProviderError("Error: 401 Unauthorized");
      expect(classification?.category).toBe("auth");
      expect(classification?.code).toBe("AUTH_INVALID_CREDENTIALS");
      expect(classification?.id).toBe("E1001");
    });

    it("classifies 429 rate limit as capacity (rate-limit)", () => {
      const classification = classifyProviderError("HTTP 429 rate limit exceeded");
      expect(classification?.category).toBe("capacity");
      expect(classification?.code).toBe("CAPACITY_RATE_LIMIT_EXCEEDED");
      expect(classification?.id).toBe("E3001");
    });

    it("classifies connection refused as network", () => {
      const classification = classifyProviderError("Error: connect ECONNREFUSED 127.0.0.1:443");
      expect(classification?.category).toBe("network");
      expect(classification?.code).toBe("NETWORK_CONNECTION_REFUSED");
      expect(classification?.id).toBe("E6001");
    });

    it("is case-insensitive", () => {
      expect(classifyProviderError("UNAUTHORIZED")?.category).toBe("auth");
      expect(classifyProviderError("Rate LIMIT")?.category).toBe("capacity");
      expect(classifyProviderError("Connection REFUSED")?.category).toBe("network");
    });

    it("returns undefined for unrecognized text and does not store the error text", () => {
      expect(classifyProviderError("file not found")).toBeUndefined();
      expect(classifyProviderError("")).toBeUndefined();
      const classification = classifyProviderError("invalid api key provided");
      expect(classification?.category).toBe("auth");
      expect(JSON.stringify(classification)).not.toContain("api key");
      expect(JSON.stringify(classification)).not.toContain("provided");
    });
  });

  describe("ErrorClassifier predicates", () => {
    it("isRateLimitExceeded matches 429 / rate limit only", () => {
      expect(ErrorClassifier.isRateLimitExceeded("429 too many requests")).toBe(true);
      expect(ErrorClassifier.isRateLimitExceeded("rate_limit_exceeded")).toBe(true);
      expect(ErrorClassifier.isRateLimitExceeded("insufficient balance")).toBe(false);
    });

    it("isExceededContextWindow matches context-window phrases only", () => {
      expect(ErrorClassifier.isExceededContextWindow("maximum context length exceeded")).toBe(true);
      expect(ErrorClassifier.isExceededContextWindow("prompt is too long")).toBe(true);
      expect(ErrorClassifier.isExceededContextWindow("rate limit exceeded")).toBe(false);
    });

    it("isInsufficientQuota matches billing/quota phrases only", () => {
      expect(ErrorClassifier.isInsufficientQuota("insufficient balance")).toBe(true);
      expect(ErrorClassifier.isInsufficientQuota("quota exceeded")).toBe(true);
      expect(ErrorClassifier.isInsufficientQuota("401 unauthorized")).toBe(false);
    });

    it("isAccountDeactivated matches suspended/deactivated account phrases only", () => {
      expect(ErrorClassifier.isAccountDeactivated("account is suspended")).toBe(true);
      expect(ErrorClassifier.isAccountDeactivated("your account has been deactivated")).toBe(true);
      expect(ErrorClassifier.isAccountDeactivated("401 unauthorized")).toBe(false);
    });
  });

  describe("stable numericId registry", () => {
    it("assigns a stable E1xxx..E9xxx id to every code", () => {
      for (const code of PROVIDER_ERROR_CODES) {
        const spec = PROVIDER_ERROR_SPECS[code];
        expect(spec).toBeDefined();
        expect(spec.numericId).toBeGreaterThanOrEqual(1001);
        expect(spec.numericId).toBeLessThan(10000);
        expect(`E${spec.numericId}`).toMatch(/^E[1-9]\d{3}$/u);
      }
    });

    it("appends only unique ids", () => {
      const ids = PROVIDER_ERROR_CODES.map((code) => PROVIDER_ERROR_SPECS[code].numericId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("freezes the append-only registry", () => {
      expect(Object.isFrozen(PROVIDER_ERROR_SPECS)).toBe(true);
    });
  });
});
