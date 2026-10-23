/**
 * Покрытие адаптеров: 86/86 разрешений и wire-фикстуры протоколов
 * (plan-24, Task 3). Реальной сети нет.
 */

import { describe, expect, it } from "vitest";
import { PROVIDER_DEFINITIONS } from "../../../../src/modules/runtime/providers/provider-catalog.js";
import { ProviderRuntimeError } from "../../../../src/modules/runtime/providers/provider-error-mapper.js";
import {
  PROVIDER_ADAPTER_REGISTRY,
  ProviderAdapterRegistry,
} from "../../../../src/modules/runtime/providers/adapters/registry.js";
import { EXPECTED_PROVIDER_IDS } from "./provider-ids.fixture.js";
import type {
  ProviderChatAdapter,
  ProviderChatRequestInput,
} from "../../../../src/modules/runtime/providers/provider-runtime-port.js";

const requestInput = (model: string, message = "привет"): ProviderChatRequestInput => ({
  model,
  messages: [{ role: "user", content: message }],
  stream: false,
});

describe("adapters: разрешение 86/86", () => {
  it("каждый provider ID разрешается в конкретный адаптер", () => {
    expect(EXPECTED_PROVIDER_IDS).toHaveLength(86);
    for (const providerId of EXPECTED_PROVIDER_IDS) {
      const reference = PROVIDER_ADAPTER_REGISTRY.get(providerId);
      expect(reference, `нет ссылки адаптера для ${providerId}`).toBeDefined();
      const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter(providerId);
      expect(adapter.providerId).toBe(providerId);
      expect(adapter.protocolFamily).toBe(reference!.family);
    }
  });

  it("реестр покрывает ровно определения каталога", () => {
    expect(PROVIDER_ADAPTER_REGISTRY.list()).toHaveLength(PROVIDER_DEFINITIONS.length);
  });

  it("семейство протокола согласовано с runtimeAdapterId каталога", () => {
    const expectedByAdapterId: Record<string, string> = {
      "openai-compatible": "openai-compatible",
      "openai-router": "openai-compatible",
      "anthropic-compatible": "anthropic-compatible",
      "azure-openai": "azure-openai",
      "azure-ai-inference": "azure-ai-inference",
      "image-rest": "image-rest",
      "image-video-rest": "image-video-rest",
      replicate: "replicate",
      comfyui: "comfyui",
      "ollama-native": "ollama-native",
      "cloudflare-workers-ai": "cloudflare-workers-ai",
      "huggingface-inference": "huggingface-inference",
      "google-generative": "google-generative",
      "aws-bedrock": "aws-bedrock",
      "google-vertex": "google-vertex",
      "platform-cloud": "platform-cloud",
      gateway: "gateway",
    };
    for (const definition of PROVIDER_DEFINITIONS) {
      expect(expectedByAdapterId[definition.runtimeAdapterId], definition.id).toBeDefined();
      expect(PROVIDER_ADAPTER_REGISTRY.get(definition.id)!.family).toBe(expectedByAdapterId[definition.runtimeAdapterId]);
    }
  });

  it("oauth-device провайдеры используют bearer-схему", () => {
    for (const providerId of ["chatgpt", "githubcopilot", "supergrok"]) {
      expect(PROVIDER_ADAPTER_REGISTRY.get(providerId)!.auth).toEqual({ kind: "bearer" });
    }
  });

  it("провайдеры без endpoint-поля имеют дефолтный базовый URL", () => {
    for (const providerId of ["openai", "ai21", "antgroup", "spark", "v0", "ai360", "akashchat", "ollamacloud", "ppio", "vercelaigateway", "lobehub"]) {
      const reference = PROVIDER_ADAPTER_REGISTRY.get(providerId)!;
      expect(reference.requiresEndpointConfig).toBe(false);
      expect(reference.defaultBaseUrl, providerId).toBeDefined();
      expect(reference.defaultBaseUrl!.startsWith("https://")).toBe(true);
    }
  });

  it("неизвестный провайдер fail-closed", () => {
    expect(PROVIDER_ADAPTER_REGISTRY.get("not-a-provider")).toBeUndefined();
    expect(() => PROVIDER_ADAPTER_REGISTRY.createAdapter("not-a-provider")).toThrow();
  });
});

describe("adapters: позитивные wire-фикстуры протоколов", () => {
  const fixture = (
    adapter: ProviderChatAdapter,
    endpoint: string,
    body: unknown,
  ): { url: string; body: unknown; adapter: ProviderChatAdapter } => {
    const prepared = adapter.buildRequest({ ...requestInput("model-x"), endpoint });
    const response = adapter.parseCompletion(body);
    return { url: prepared.url, body: response, adapter };
  };

  it("openai-compatible: openai", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("openai");
    const { url, body } = fixture(adapter, "https://api.openai.com/v1", {
      id: "id1",
      model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(body).toMatchObject({ content: "ok", finishReason: "stop" });
  });

  it("openai-router: newapi и aihubmix", () => {
    for (const providerId of ["newapi", "aihubmix", "zenmux"]) {
      const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter(providerId);
      expect(adapter.protocolFamily).toBe("openai-compatible");
      const prepared = adapter.buildRequest({ ...requestInput("m"), endpoint: "https://api.example.com/v1" });
      expect(prepared.url).toBe("https://api.example.com/v1/chat/completions");
    }
  });

  it("anthropic-compatible: anthropic", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("anthropic");
    const prepared = adapter.buildRequest({ ...requestInput("claude-3-5-sonnet"), endpoint: "https://api.anthropic.com" });
    expect(prepared.url).toBe("https://api.anthropic.com/v1/messages");
    expect(prepared.headers["anthropic-version"]).toBe("2023-06-01");
    const response = adapter.parseCompletion({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(response.content).toBe("ok");
  });

  it("anthropic-compatible: kimicodingplan", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("kimicodingplan");
    expect(adapter.protocolFamily).toBe("anthropic-compatible");
  });

  it("ollama-native: ollama", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("ollama");
    expect(adapter.auth).toEqual({ kind: "none" });
    const prepared = adapter.buildRequest({ ...requestInput("llama3"), endpoint: "http://127.0.0.1:11434" });
    expect(prepared.url).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("google-generative: google", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("google");
    const prepared = adapter.buildRequest({ ...requestInput("gemini-2.0-flash"), endpoint: "https://generativelanguage.googleapis.com" });
    expect(prepared.url).toContain(":generateContent");
  });

  it("azure-openai: azure (host из resourceName, api-version)", () => {
    const reference = PROVIDER_ADAPTER_REGISTRY.get("azure")!;
    expect(reference.resolveEndpoint).toBeDefined();
    const resolved = reference.resolveEndpoint!({ resourceName: "res1", deploymentName: "gpt-4o", apiVersion: "2024-06-01" });
    expect(resolved.baseUrl).toBe("https://res1.openai.azure.com/openai/deployments/gpt-4o");
    const query = reference.endpointQuery!({ apiVersion: "2024-06-01" });
    expect(query["api-version"]).toBe("2024-06-01");
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("azure");
    const prepared = adapter.buildRequest({ ...requestInput("gpt-4o"), endpoint: resolved.baseUrl, endpointQuery: query });
    expect(prepared.url).toBe(
      "https://res1.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-06-01",
    );
  });

  it("azure-openai: azure без resource/deployment — типизированная ошибка", () => {
    const reference = PROVIDER_ADAPTER_REGISTRY.get("azure")!;
    expect(() => reference.resolveEndpoint!({})).toThrow(ProviderRuntimeError);
  });

  it("azure-ai-inference: azureai", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("azureai");
    const prepared = adapter.buildRequest({ ...requestInput("m"), endpoint: "https://model.example.ai" });
    expect(prepared.url).toBe("https://model.example.ai/models/chat/completions");
  });

  it("cloudflare-workers-ai: cloudflare (accountId)", () => {
    const reference = PROVIDER_ADAPTER_REGISTRY.get("cloudflare")!;
    const resolved = reference.resolveEndpoint!({ accountId: "acct-1" });
    expect(resolved.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1");
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("cloudflare");
    const prepared = adapter.buildRequest({ ...requestInput("m"), endpoint: resolved.baseUrl });
    expect(prepared.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1/chat/completions");
  });

  it("huggingface-inference: huggingface", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("huggingface");
    const prepared = adapter.buildRequest({ ...requestInput("m"), endpoint: "https://api-inference.huggingface.co/v1" });
    expect(prepared.url).toBe("https://api-inference.huggingface.co/v1/chat/completions");
  });

  it("gateway: vercelaigateway", () => {
    const reference = PROVIDER_ADAPTER_REGISTRY.get("vercelaigateway")!;
    expect(reference.defaultBaseUrl).toBe("https://ai-gateway.vercel.sh/v1");
    expect(reference.family).toBe("gateway");
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("vercelaigateway");
    const prepared = adapter.buildRequest({ ...requestInput("m"), endpoint: reference.defaultBaseUrl! });
    expect(prepared.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
  });

  it("platform-cloud: lobehub (subscription-token)", () => {
    const reference = PROVIDER_ADAPTER_REGISTRY.get("lobehub")!;
    expect(reference.auth).toEqual({ kind: "bearer" });
    expect(reference.family).toBe("platform-cloud");
  });

  it("oauth-device: chatgpt/githubcopilot/supergrok разрешаются", () => {
    for (const providerId of ["chatgpt", "githubcopilot", "supergrok"]) {
      const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter(providerId);
      const prepared = adapter.buildRequest({
        ...requestInput("m"),
        endpoint: "https://api.example.com/v1",
      });
      expect(prepared.auth).toEqual({ kind: "bearer" });
    }
  });
});

describe("adapters: негативные фикстуры", () => {
  it("image-провайдеры отклоняют чат-запрос с точной причиной", () => {
    for (const providerId of ["bfl", "fal", "replicate", "comfyui"]) {
      const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter(providerId);
      expect(() => adapter.buildRequest({ ...requestInput("m"), endpoint: "https://example.com" }))
        .toThrow(/REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED/);
    }
  });

  it("cloud-identity провайдеры отклоняют до настройки identity", () => {
    for (const providerId of ["bedrock", "vertexai"]) {
      const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter(providerId);
      expect(() => adapter.buildRequest({ ...requestInput("m"), endpoint: "https://example.com" }))
        .toThrow(/PROVIDER_CLOUD_IDENTITY_CREDENTIALS_UNAVAILABLE/);
    }
  });

  it("невалидный JSON-ответ бросает ProviderRuntimeError", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("deepseek");
    expect(() => adapter.parseCompletion({})).toThrow(ProviderRuntimeError);
    expect(() => adapter.parseCompletion("not-json")).toThrow(ProviderRuntimeError);
  });

  it("usage.cost всегда null, если источник не сообщил стоимость", () => {
    const adapter = PROVIDER_ADAPTER_REGISTRY.createAdapter("groq");
    const response = adapter.parseCompletion({
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(response.usage.cost).toBeNull();
  });
});

describe("adapters: регистр как DI-модуль", () => {
  it("можно создать собственный реестр поверх подмножества", () => {
    const registry = new ProviderAdapterRegistry([{ id: "openai" }, { id: "anthropic" }]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("openai")).toBeDefined();
    expect(registry.get("deepseek")).toBeUndefined();
  });
});
