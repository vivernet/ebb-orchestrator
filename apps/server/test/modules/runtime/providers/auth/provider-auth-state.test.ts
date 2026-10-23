/**
 * Состояние потока авторизации: модель, безопасные проекции, vault секретов
 * и срок действия (plan-24, Task 4).
 */

import { describe, expect, it } from "vitest";
import {
  AuthFlowSecretVault,
  InMemoryAuthFlowStore,
  isFlowExpired,
  isTerminalFlowStatus,
  toSafeFlowProjection,
} from "../../../../../src/modules/runtime/providers/auth/provider-auth-state.js";

const NOW = "2030-01-01T00:00:00.000Z";

describe("provider-auth-state: InMemoryAuthFlowStore", () => {
  it("create/get/update/listBySession/delete", () => {
    const store = new InMemoryAuthFlowStore();
    const record = store.create({
      providerId: "chatgpt",
      methodId: "oauth-device-code",
      sessionBinding: "s1",
      expiresAt: "2030-01-01T01:00:00.000Z",
      pollIntervalSeconds: 8,
      now: NOW,
    });
    expect(store.get(record.flowId)?.status).toBe("PENDING");
    expect(store.listBySession("s1")).toHaveLength(1);
    expect(store.listBySession("s2")).toHaveLength(0);

    const updated = store.update(record.flowId, { status: "COMPLETE" });
    expect(updated?.status).toBe("COMPLETE");
    expect(store.update(record.flowId, { failureKind: "token-exchange" })?.failureKind).toBe("token-exchange");
    expect(store.delete(record.flowId)).toBe(true);
    expect(store.get(record.flowId)).toBeUndefined();
    expect(store.delete(record.flowId)).toBe(false);
  });

  it("update неизвестного потока возвращает undefined", () => {
    const store = new InMemoryAuthFlowStore();
    expect(store.update("missing", { status: "EXPIRED" })).toBeUndefined();
  });
});

describe("provider-auth-state: безопасная проекция", () => {
  it("никогда не содержит секретных полей", () => {
    const store = new InMemoryAuthFlowStore();
    const record = store.create({
      providerId: "chatgpt",
      methodId: "oauth-device-code",
      sessionBinding: "s1",
      expiresAt: "2030-01-01T01:00:00.000Z",
      pollIntervalSeconds: 8,
      now: NOW,
    });
    const projection = toSafeFlowProjection(record, { verificationUrl: "https://auth.example.com/device", userCode: "ABCD-EFGH" });
    expect(projection.status).toBe("PENDING");
    expect(projection.verificationUrl).toBe("https://auth.example.com/device");
    expect(projection.userCode).toBe("ABCD-EFGH");
    const raw = JSON.stringify(projection);
    expect(raw).not.toContain("deviceCode");
    expect(raw).not.toContain("verifier");
    expect(raw).not.toContain("nonce");
    expect(raw).not.toContain("sessionBinding");
  });
});

describe("provider-auth-state: срок действия", () => {
  it("isFlowExpired граничит по expiresAt", () => {
    const store = new InMemoryAuthFlowStore();
    const record = store.create({
      providerId: "chatgpt",
      methodId: "oauth-device-code",
      sessionBinding: "s1",
      expiresAt: "2030-01-01T01:00:00.000Z",
      pollIntervalSeconds: 8,
      now: NOW,
    });
    expect(isFlowExpired(record, new Date("2030-01-01T00:59:59.000Z"))).toBe(false);
    expect(isFlowExpired(record, new Date("2030-01-01T01:00:00.000Z"))).toBe(true);
    expect(isFlowExpired(record, new Date("2030-01-01T02:00:00.000Z"))).toBe(true);
  });

  it("isTerminalFlowStatus", () => {
    expect(isTerminalFlowStatus("PENDING")).toBe(false);
    expect(isTerminalFlowStatus("COMPLETE")).toBe(true);
    expect(isTerminalFlowStatus("EXPIRED")).toBe(true);
    expect(isTerminalFlowStatus("DENIED")).toBe(true);
    expect(isTerminalFlowStatus("FAILED")).toBe(true);
    expect(isTerminalFlowStatus("CANCELLED")).toBe(true);
  });
});

describe("provider-auth-state: секретный vault", () => {
  it("take извлекает one-use запись и обнуляет значения", () => {
    const vault = new AuthFlowSecretVault();
    vault.set("f1", { deviceCode: "device-code-1", verifier: "v", state: "s" });
    const entry = vault.take("f1");
    expect(entry?.deviceCode).toBe("");
    expect(entry?.verifier).toBe("");
    expect(entry?.state).toBe("");
    expect(vault.get("f1")).toBeUndefined();
  });

  it("zeroFor обнуляет без удаления", () => {
    const vault = new AuthFlowSecretVault();
    vault.set("f1", { deviceCode: "secret" });
    vault.zeroFor("f1");
    expect(vault.get("f1")?.deviceCode).toBe("");
  });

  it("delete обнуляет и удаляет", () => {
    const vault = new AuthFlowSecretVault();
    vault.set("f1", { deviceCode: "secret" });
    expect(vault.delete("f1")).toBe(true);
    expect(vault.get("f1")).toBeUndefined();
    expect(vault.delete("f1")).toBe(false);
  });
});
