/**
 * Тесты парсинга ответов и SSE-стримов (plan-24, Task 3).
 */

import { describe, expect, it } from "vitest";
import { ProviderRuntimeError } from "../../../../src/modules/runtime/providers/provider-error-mapper.js";
import {
  createAnthropicSSEParser,
  createOpenAISSEParser,
  createStructuredResultValidator,
  extractAnthropicUsage,
  extractOpenAIUsage,
  parseAnthropicCompletionBody,
  parseGoogleGenerativeCompletionBody,
  parseOllamaCompletionBody,
  parseOpenAICompletionBody,
} from "../../../../src/modules/runtime/providers/provider-response.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("provider-response: OpenAI JSON", () => {
  it("разбирает текст и usage (включая cached)", () => {
    const response = parseOpenAICompletionBody({
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [
        {
          message: { role: "assistant", content: "Привет!" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    });
    expect(response.content).toBe("Привет!");
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toEqual({ inputTokens: 12, cachedInputTokens: 5, outputTokens: 3, cost: null });
  });

  it("разбирает tool_calls", () => {
    const response = parseOpenAICompletionBody({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "git.head", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]).toMatchObject({ id: "call_1", function: { name: "git.head" } });
    expect(response.finishReason).toBe("tool_calls");
  });

  it("бросает классифицированную ошибку на битый JSON", () => {
    expect(() => parseOpenAICompletionBody({})).toThrow(ProviderRuntimeError);
    expect(() => parseOpenAICompletionBody({ choices: [] })).toThrow(ProviderRuntimeError);
  });
});

describe("provider-response: Anthropic JSON", () => {
  it("разбирает text/tool_use/usage", () => {
    const response = parseAnthropicCompletionBody({
      id: "msg_1",
      model: "claude-3-5-sonnet",
      content: [
        { type: "text", text: "скажу" },
        { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 0 },
    });
    expect(response.content).toBe("скажу");
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.function.arguments).toBe('{"q":"x"}');
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage).toEqual({ inputTokens: 10, cachedInputTokens: 6, outputTokens: 4, cost: null });
  });
});

describe("provider-response: Ollama JSON", () => {
  it("разбирает done/tool_calls/usage", () => {
    const response = parseOllamaCompletionBody({
      model: "llama3",
      done: true,
      done_reason: "stop",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "git.status", arguments: { unused: false } } }],
      },
      prompt_eval_count: 8,
      eval_count: 2,
    });
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls[0]!.function.arguments).toBe('{"unused":false}');
    expect(response.usage.inputTokens).toBe(8);
    expect(response.usage.outputTokens).toBe(2);
  });
});

describe("provider-response: Google JSON", () => {
  it("разбирает candidates/functionCall/usageMetadata", () => {
    const response = parseGoogleGenerativeCompletionBody({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "workspace.read", args: { path: "a.txt" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, cachedContentTokenCount: 2 },
    });
    expect(response.toolCalls[0]!.function.name).toBe("workspace.read");
    expect(response.usage).toEqual({ inputTokens: 5, cachedInputTokens: 2, outputTokens: 1, cost: null });
  });
});

describe("provider-response: usage-экстракция", () => {
  it("extractOpenAIUsage", () => {
    expect(extractOpenAIUsage(null)).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: null });
    expect(extractOpenAIUsage({ prompt_tokens: 1, completion_tokens: 2 })).toEqual({
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 2,
      cost: null,
    });
  });

  it("extractAnthropicUsage", () => {
    expect(extractAnthropicUsage({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1 })).toEqual({
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 4,
      cost: null,
    });
  });
});

describe("provider-response: OpenAI SSE", () => {
  const sse = (obj: unknown): Uint8Array => text(`data: ${JSON.stringify(obj)}\n\n`);

  it("собирает текст, tool_calls и usage", () => {
    const parser = createOpenAISSEParser();
    const chunks1 = parser.push(sse({ choices: [{ delta: { content: "При" } }] }));
    expect(chunks1).toEqual([{ kind: "content", text: "При" }]);

    const chunks2 = parser.push(sse({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: "call_1", function: { name: "git.head", arguments: "{}" } }],
        },
      }],
    }));
    expect(chunks2[0]).toMatchObject({ kind: "tool-call-start", index: 0, id: "call_1", name: "git.head" });

    const chunks3 = parser.push(sse({
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
        finish_reason: "tool_calls",
      }],
    }));
    expect(chunks3).toContainEqual({ kind: "tool-call-arguments", index: 0, argumentsDelta: "}" });
    expect(chunks3).toContainEqual({ kind: "finish", finishReason: "tool_calls" });

    const chunks4 = parser.push(sse({ usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    expect(chunks4[0]).toMatchObject({ kind: "usage" });

    parser.push(text("data: [DONE]\n\n"));
    expect(() => parser.finish()).not.toThrow();
  });

  it("бросает ошибку при незавершённом потоке", () => {
    const parser = createOpenAISSEParser();
    parser.push(sse({ choices: [{ delta: { content: "x" } }] }));
    expect(() => parser.finish()).toThrow(ProviderRuntimeError);
  });
});

describe("provider-response: Anthropic SSE", () => {
  const sse = (event: string, obj: unknown): Uint8Array => text(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);

  it("собирает tool_use из content_block_*", () => {
    const parser = createAnthropicSSEParser();
    parser.push(sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "search" },
    }));
    parser.push(sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" },
    }));
    const chunks = parser.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
    expect(chunks).toContainEqual({ kind: "tool-call-end", index: 0 });
    parser.push(sse("message_stop", { type: "message_stop" }));
    expect(() => parser.finish()).not.toThrow();
  });
});

describe("provider-response: structured-result хук", () => {
  it("валидирует ролевой контракт", () => {
    const validate = createStructuredResultValidator("developer");
    const result = validate({
      version: "1.0.0",
      outcome: "COMPLETED",
      commitSha: "a".repeat(40),
    });
    expect(result.valid).toBe(true);
  });
});
