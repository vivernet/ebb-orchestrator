import { describe, expect, it } from "vitest";
import { resolveHermesProviderBridgeConfig } from "../../../src/modules/runtime/hermes/hermes-provider-bridge.js";

describe("Hermes provider bridge configuration", () => {
  it("is disabled when no provider bridge values are configured", () => {
    expect(resolveHermesProviderBridgeConfig({})).toBeUndefined();
  });

  it("requires both endpoint and SecretStore reference", () => {
    expect(() => resolveHermesProviderBridgeConfig({ EBB_HERMES_PROVIDER_BASE_URL: "https://models.example.test/v1" }))
      .toThrow("Hermes provider bridge configuration is incomplete");
  });

  it("accepts HTTPS and returns only non-secret routing configuration", () => {
    expect(resolveHermesProviderBridgeConfig({
      EBB_HERMES_PROVIDER_BASE_URL: "https://models.example.test/v1/",
      EBB_HERMES_PROVIDER_SECRET_NAME: "release-key",
    })).toEqual({ baseUrl: "https://models.example.test/v1", secretName: "release-key" });
  });

  it("allows HTTP only for loopback development endpoints", () => {
    expect(resolveHermesProviderBridgeConfig({
      EBB_HERMES_PROVIDER_BASE_URL: "http://127.0.0.1:8080/v1",
      EBB_HERMES_PROVIDER_SECRET_NAME: "local",
    })?.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(() => resolveHermesProviderBridgeConfig({
      EBB_HERMES_PROVIDER_BASE_URL: "http://models.example.test/v1",
      EBB_HERMES_PROVIDER_SECRET_NAME: "release-key",
    })).toThrow(/HTTPS or loopback HTTP/);
  });

  it("rejects invalid names and embedded URL credentials", () => {
    expect(() => resolveHermesProviderBridgeConfig({
      EBB_HERMES_PROVIDER_BASE_URL: "https://models.example.test/v1",
      EBB_HERMES_PROVIDER_SECRET_NAME: "bad/name",
    })).toThrow("Hermes provider secret name is invalid");
    expect(() => resolveHermesProviderBridgeConfig({
      EBB_HERMES_PROVIDER_BASE_URL: "https://user:password@models.example.test/v1",
      EBB_HERMES_PROVIDER_SECRET_NAME: "release-key",
    })).toThrow(/HTTPS or loopback HTTP/);
  });
});
