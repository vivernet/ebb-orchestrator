import { describe, expect, it } from "vitest";
import {
  addTokenBuckets,
  countContextTokens,
  countMessageTokens,
  countTokens,
  type InputTokenBuckets,
  type MessageTokenBreakdown,
} from "../../../../src/modules/runtime/context/token-accounting.js";
import type { Message } from "../../../../src/modules/context/context-types.js";

// ---------------------------------------------------------------------------
// Учёт токенов по бакетам: точный токенизатор, аддитивность бакетов и
// per-message разбивка. Никаких byte-estimate эвристик.
// ---------------------------------------------------------------------------

describe("tokenAccounting - countTokens", () => {
  it("считает слова как один токен каждый", () => {
    expect(countTokens("привет мир")).toBe(2);
    expect(countTokens("hello world")).toBe(2);
  });

  it("считает каждый символ пунктуации отдельным токеном", () => {
    expect(countTokens("привет, мир!")).toBe(4);
    expect(countTokens("a.b,c")).toBe(5);
  });

  it("не считает пробелы и переводы строк", () => {
    expect(countTokens("  \n\t ")).toBe(0);
    expect(countTokens("line1\nline2")).toBe(2);
  });

  it("считает каждую CJK-букву отдельным токеном", () => {
    expect(countTokens("東京")).toBe(2);
  });

  it("считает суррогатную пару одним токеном", () => {
    expect(countTokens("👋")).toBe(1);
  });

  it("считает комбинируемые метки частью слова", () => {
    expect(countTokens("e\u0301")).toBe(1);
  });

  it("возвращает 0 для пустой строки", () => {
    expect(countTokens("")).toBe(0);
  });

  it("не является byte-estimate: токены не равны ceil(байты/4)", () => {
    const text = "привет мир"; // 13 байт UTF-8, 2 токена
    expect(countTokens(text)).toBe(2);
    expect(countTokens(text)).not.toBe(Math.ceil(new TextEncoder().encode(text).length / 4));
  });

  it("детерминирован для одинакового входа", () => {
    const text = "Повторяющийся текст с ! знаками.";
    expect(countTokens(text)).toBe(countTokens(text));
  });
});

describe("tokenAccounting - countContextTokens", () => {
  it("возвращает сумму всех бакетов", () => {
    const buckets: InputTokenBuckets = {
      content: 10,
      fileContext: 20,
      toolCalls: 30,
      thoughtSignature: 40,
      reasoning: 50,
      toolDefinition: 60,
    };
    expect(countContextTokens(buckets)).toBe(210);
  });

  it("возвращает 0 для пустых бакетов", () => {
    const empty: InputTokenBuckets = {
      content: 0,
      fileContext: 0,
      toolCalls: 0,
      thoughtSignature: 0,
      reasoning: 0,
      toolDefinition: 0,
    };
    expect(countContextTokens(empty)).toBe(0);
  });
});

describe("tokenAccounting - сумма бакетов совпадает с подсчётом по токенизатору", () => {
  it("для конкатенации частей на границах токенов", () => {
    const parts: Record<keyof InputTokenBuckets, string> = {
      content: "Инструкция по задаче.\n",
      fileContext: "Файл: src/index.ts\n",
      toolCalls: "tool read_file(path=\"a.ts\")\n",
      thoughtSignature: "Обдумываю план\n",
      reasoning: "Причина: надёжность.\n",
      toolDefinition: "read_file: читает файл.",
    };

    const buckets: InputTokenBuckets = {
      content: countTokens(parts.content),
      fileContext: countTokens(parts.fileContext),
      toolCalls: countTokens(parts.toolCalls),
      thoughtSignature: countTokens(parts.thoughtSignature),
      reasoning: countTokens(parts.reasoning),
      toolDefinition: countTokens(parts.toolDefinition),
    };

    const joined = parts.content + parts.fileContext + parts.toolCalls
      + parts.thoughtSignature + parts.reasoning + parts.toolDefinition;

    expect(countContextTokens(buckets)).toBe(countTokens(joined));
  });

  it("разбиение внутри слова меняет счёт — учёт точен только на границах токенов", () => {
    const first = "инструкция"; // 1 токен
    const second = "по задаче"; // 2 токена
    expect(countTokens(first)).toBe(1);
    expect(countTokens(second)).toBe(2);
    // Разрез внутри слова склеивает токены, поэтому сумма частей НЕ равна
    // счёту полного склеенного текста; это свойство токенизатора, а не баг.
    expect(countTokens(first + second)).toBe(2);
    expect(countTokens(first) + countTokens(second)).toBe(3);
  });
});

describe("tokenAccounting - addTokenBuckets", () => {
  it("суммирует бакеты поэлементно", () => {
    const a: InputTokenBuckets = {
      content: 1,
      fileContext: 2,
      toolCalls: 3,
      thoughtSignature: 4,
      reasoning: 5,
      toolDefinition: 6,
    };
    const b: InputTokenBuckets = {
      content: 10,
      fileContext: 20,
      toolCalls: 30,
      thoughtSignature: 40,
      reasoning: 50,
      toolDefinition: 60,
    };
    const result = addTokenBuckets(a, b);
    expect(result).toEqual({
      content: 11,
      fileContext: 22,
      toolCalls: 33,
      thoughtSignature: 44,
      reasoning: 55,
      toolDefinition: 66,
    });
  });

  it("возвращает нулевые бакеты без аргументов", () => {
    expect(addTokenBuckets()).toEqual({
      content: 0,
      fileContext: 0,
      toolCalls: 0,
      thoughtSignature: 0,
      reasoning: 0,
      toolDefinition: 0,
    });
  });

  it("аддитивен для произвольного числа слагаемых", () => {
    const one: InputTokenBuckets = {
      content: 7,
      fileContext: 0,
      toolCalls: 1,
      thoughtSignature: 0,
      reasoning: 2,
      toolDefinition: 0,
    };
    expect(countContextTokens(addTokenBuckets(one, one, one))).toBe(30);
  });
});

describe("tokenAccounting - countMessageTokens", () => {
  it("возвращает разбивку сообщения по источникам", () => {
    const message: Message = { role: "assistant", content: "Обдумываю и вызываю tool." };
    const breakdown: MessageTokenBreakdown = countMessageTokens(message);
    expect(breakdown.messageIndex).toBe(0);
    expect(breakdown.buckets.content).toBe(countTokens(message.content));
    expect(breakdown.buckets.fileContext).toBe(0);
    expect(breakdown.buckets.toolCalls).toBe(0);
    expect(breakdown.buckets.thoughtSignature).toBe(0);
    expect(breakdown.buckets.reasoning).toBe(0);
    expect(breakdown.buckets.toolDefinition).toBe(0);
    expect(countContextTokens(breakdown.buckets)).toBe(countTokens(message.content));
  });

  it("пустое сообщение даёт нулевые бакеты", () => {
    const breakdown = countMessageTokens({ role: "user", content: "" });
    expect(countContextTokens(breakdown.buckets)).toBe(0);
  });
});
