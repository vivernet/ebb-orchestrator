/**
 * Тесты канонического построения запросов (plan-24, Task 3).
 */

import { describe, expect, it } from "vitest";
import { ProviderRuntimeError } from "../../../../src/modules/runtime/providers/provider-error-mapper.js";
import {
  attachCredentialToRequest,
  buildProviderRequest,
  messageText,
  resolveProviderEndpoint,
  safeParseArguments,
  serializeProviderJsonBody,
  toAnthropicMessage,
  toOpenAIMessage,
} from "../../../../src/modules/runtime/providers/provider-request.js";
import { createOpenAICompatibleAdapter } from "../../../../src/modules/runtime/providers/adapters/openai-compatible-adapter.js";
import { createAnthropicCompatibleAdapter } from "../../../../src/modules/runtime/providers/adapters/anthropic-adapter.js";
import { createOllamaNativeAdapter } from "../../../../src/modules/runtime/providers/adapters/ollama-native-adapter.js";
import { createGoogleGenerativeAdapter } from "../../../../src/modules/runtime/providers/adapters/google-generative-adapter.js";
import type { ProviderChatMessage } from "../../../../src/modules/runtime/providers/provider-runtime-port.js";

describe("provider-request: сообщения", () => {
  it("toOpenAIMessage: tool-сообщения и tool_calls", () => {
    const tool: ProviderChatMessage = { role: "tool", content: "ok", toolCallId: "call_1" };
    expect(toOpenAIMessage(tool)).toEqual({ role: "tool", tool_call_id: "call_1", content: "ok" });

    const assistant: ProviderChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "git.head", arguments: "{}" } }],
    };
    expect(toOpenAIMessage(assistant)).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "git.head", arguments: "{}" } }],
    });
  });

  it("toAnthropicMessage: tool_use и tool_result блоки", () => {
    const assistant: ProviderChatMessage = {
      role: "assistant",
      content: "думаю",
      toolCalls: [{ id: "toolu_1", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }],
    };
    const mapped = toAnthropicMessage(assistant);
    expect(mapped.content).toEqual([
      { type: "text", text: "думаю" },
      { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } },
    ]);

    const tool: ProviderChatMessage = { role: "tool", content: "res", toolCallId: "toolu_1" };
    expect(toAnthropicMessage(tool).content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "res" },
    ]);
  });

  it("safeParseArguments", () => {
    expect(safeParseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseArguments("not-json")).toBeNull();
    expect(safeParseArguments("[1,2]")).toBeNull();
  });
});

describe("provider-request: тело запроса", () => {
  const endpoint = "https://api.example.com/v1";

  it("OpenAI-совместимый адаптер строит корректный запрос", () => {
    const adapter = createOpenAICompatibleAdapter({
      providerId: "openai",
      family: "openai-compatible",
      auth: { kind: "bearer" },
    });
    const prepared = buildProviderRequest(adapter, {
      endpoint,
      model: "gpt-4o",
      messages: [{ role: "user", content: "привет" }],
      tools: [{ type: "function", function: { name: "git.head", description: "head", parameters: { type: "object", properties: {} } } }],
      stream: false,
    });
    expect(prepared.url).toBe("https://api.example.com/v1/chat/completions");
    expect(prepared.method).toBe("POST");
    expect(prepared.auth).toEqual({ kind: "bearer" });
    const body = JSON.parse(prepared.body!) as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o");
    expect((body.messages as unknown[])[0]).toMatchObject({ role: "user", content: "привет" });
    expect((body.tools as unknown[])[0]).toMatchObject({ type: "function" });
    expect(body.stream).toBe(false);
  });

  it("endpointQuery добавляется к URL", () => {
    const adapter = createOpenAICompatibleAdapter({
      providerId: "azure",
      family: "azure-openai",
      auth: { kind: "bearer" },
    });
    const prepared = buildProviderRequest(adapter, {
      endpoint: "https://res.openai.azure.com/openai/deployments/gpt-4o",
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      endpointQuery: { "api-version": "2024-06-01" },
    });
    expect(prepared.url).toBe(
      "https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01",
    );
  });

  it("Anthropic-адаптер требует max_tokens и system-блок", () => {
    const adapter = createAnthropicCompatibleAdapter({ providerId: "anthropic", auth: { kind: "bearer" } });
    const prepared = buildProviderRequest(adapter, {
      endpoint,
      model: "claude-3-5-sonnet",
      messages: [
        { role: "system", content: "ты агент" },
        { role: "user", content: "hi" },
      ],
      stream: false,
    });
    const body = JSON.parse(prepared.body!) as Record<string, unknown>;
    expect(body.max_tokens).toBeTypeOf("number");
    expect(body.system).toEqual(["ты агент"]);
    expect(body.messages).toHaveLength(1);
    expect(prepared.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("Ollama-native адаптер строит /api/chat", () => {
    const adapter = createOllamaNativeAdapter({ providerId: "ollama", auth: { kind: "none" } });
    const prepared = buildProviderRequest(adapter, {
      endpoint: "http://127.0.0.1:11434",
      model: "llama3",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(prepared.url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(prepared.body!) as Record<string, unknown>;
    expect(body.model).toBe("llama3");
  });

  it("Google Generative строит :generateContent URL", () => {
    const adapter = createGoogleGenerativeAdapter({ providerId: "google", auth: { kind: "bearer" } });
    const prepared = buildProviderRequest(adapter, {
      endpoint: "https://generativelanguage.googleapis.com",
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(prepared.url).toBe(
      "https://generativelanguage.googleapis.com/models/gemini-2.0-flash:generateContent?alt=sse",
    );
    const body = JSON.parse(prepared.body!) as Record<string, unknown>;
    expect((body.contents as Record<string, unknown>[])[0]).toMatchObject({ role: "user" });
  });
});

describe("provider-request: credential-прикрепление", () => {
  it("bearer-схема добавляет Authorization (Buffer-значение, без строковой копии)", () => {
    const adapter = createOpenAICompatibleAdapter({
      providerId: "openai",
      family: "openai-compatible",
      auth: { kind: "bearer" },
    });
    const prepared = buildProviderRequest(adapter, {
      endpoint: "https://api.example.com/v1",
      model: "m",
      messages: [{ role: "user", content: "x" }],
      stream: false,
    });
    const credential = Buffer.from("sk-secret");
    const final = attachCredentialToRequest(prepared, credential);
    expect(Buffer.isBuffer(final.headers.authorization)).toBe(true);
    expect(final.headers.authorization!.toString()).toBe("Bearer sk-secret");
  });

  it("bearer без значения → AUTH_DEVICE_FLOW_TOKEN_MISSING для oauth", () => {
    const adapter = createOpenAICompatibleAdapter({
      providerId: "chatgpt",
      family: "openai-compatible",
      auth: { kind: "bearer" },
    });
    const prepared = buildProviderRequest(adapter, {
      endpoint: "https://api.chatgpt.com/v1",
      model: "m",
      messages: [{ role: "user", content: "x" }],
      stream: false,
    });
    expect(() => attachCredentialToRequest(prepared, null)).toThrow(ProviderRuntimeError);
  });

  it("none-схема не требует credential", () => {
    const adapter = createOllamaNativeAdapter({ providerId: "ollama", auth: { kind: "none" } });
    const prepared = buildProviderRequest(adapter, {
      endpoint: "http://127.0.0.1:11434",
      model: "m",
      messages: [{ role: "user", content: "x" }],
      stream: false,
    });
    expect(attachCredentialToRequest(prepared, null).headers.authorization).toBeUndefined();
  });
});

describe("provider-request: сериализация и endpoint", () => {
  it("сериализация ограничивает размер", () => {
    expect(serializeProviderJsonBody({ a: 1 })).toBe('{"a":1}');
  });

  it("resolveProviderEndpoint: endpoint из конфигурации", () => {
    const reference = {
      providerId: "deepseek",
      family: "openai-compatible" as const,
      auth: { kind: "bearer" as const },
      chatPath: "/chat/completions",
      requiresEndpointConfig: true,
      supportsStreaming: true,
      supportsToolCalls: true,
      capabilities: ["chat", "streaming"],
      create: () => createOpenAICompatibleAdapter({ providerId: "deepseek", family: "openai-compatible", auth: { kind: "bearer" } }),
    };
    const resolved = resolveProviderEndpoint(reference, { endpoint: "https://api.deepseek.com/ " });
    expect(resolved.baseUrl).toBe("https://api.deepseek.com");
    expect(resolved.isLocalEndpoint).toBe(false);
    expect(() => resolveProviderEndpoint(reference, undefined)).toThrow(ProviderRuntimeError);
  });

  it("resolveProviderEndpoint: локальный endpoint распознаётся", () => {
    const reference = {
      providerId: "ollama",
      family: "ollama-native" as const,
      auth: { kind: "none" as const },
      chatPath: "/api/chat",
      requiresEndpointConfig: true,
      supportsStreaming: true,
      supportsToolCalls: true,
      capabilities: ["chat", "streaming", "local-endpoint"],
      create: () => createOllamaNativeAdapter({ providerId: "ollama", auth: { kind: "none" } }),
    };
    expect(resolveProviderEndpoint(reference, { endpoint: "http://127.0.0.1:11434" }).isLocalEndpoint).toBe(true);
    expect(resolveProviderEndpoint(reference, { endpoint: "https://api.ollama.com" }).isLocalEndpoint).toBe(false);
  });

  it("messageText", () => {
    expect(messageText({ role: "user", content: "abc" })).toBe("abc");
    expect(messageText({ role: "user", content: [{ type: "text", text: "x" }] })).toBe("x");
  });
});
