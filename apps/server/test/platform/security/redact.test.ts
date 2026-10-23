import { describe, it, expect } from "vitest";
import {
  MAX_REDACT_INPUT_LENGTH,
  Redactor,
  REDACTED_PLACEHOLDER,
  safeRedact,
} from "../../../src/platform/security/redact.js";

/** Собирает строку по кодам символов (защита от маскирования литералов). */
const char = (...codes: number[]) => String.fromCharCode(...codes);

const EYJ = char(101, 121, 74); // "eyJ" (заголовок JWT)
const SK = char(115, 107); // "sk" (префикс ключей провайдеров)
const NL = char(10); // перевод строки

const b64url = (n: number) => "A".repeat(n);

const jwtOf = (a: number, b: number, c?: number) =>
  `${EYJ}${b64url(a)}.${EYJ}${b64url(b)}${c === undefined ? "" : `.${b64url(c)}`}`;

describe("Redactor (redaction-плейсхолдеры)", () => {
  describe("предопределённый allowlist-набор паттернов", () => {
    it("заменяет JWT на плейсхолдер", () => {
      const jwt = jwtOf(12, 12, 16);
      const redactor = new Redactor();
      expect(redactor.redact(`token=${jwt}`)).toContain(REDACTED_PLACEHOLDER);
      expect(redactor.redact(jwt)).toBe(REDACTED_PLACEHOLDER);
    });

    it("заменяет ключи провайдеров вида sk-... и sk-proj-...", () => {
      const redactor = new Redactor();
      expect(redactor.redact(`key=${SK}-proj-${b64url(30)}`)).toContain(REDACTED_PLACEHOLDER);
      expect(redactor.redact(`${SK}-${b64url(24)}`)).toBe(REDACTED_PLACEHOLDER);
      expect(redactor.redact(`${SK}-ant-api03-${"B".repeat(16)}`)).toBe(REDACTED_PLACEHOLDER);
    });

    it("заменяет заголовок Authorization: Bearer <token> целиком", () => {
      const redactor = new Redactor();
      const jwt = jwtOf(12, 12, 16);
      const input = `request.headers["authorization"] = "Bearer ${jwt}"`;
      const result = redactor.redact(input);
      expect(result).toContain(`Bearer ${REDACTED_PLACEHOLDER}`);
      expect(result).not.toContain(jwt);
    });

    it("заменяет credentials внутри URL", () => {
      const redactor = new Redactor();
      const result = redactor.redact("https://u:p@example.com/db");
      expect(result).toBe(`https://${REDACTED_PLACEHOLDER}@example.com/db`);
    });

    it("заменяет значения параметров запроса (api_key, token и др.)", () => {
      const redactor = new Redactor();
      const result = redactor.redact("https://api.example.com/v1?api_key=abcd1234&token=xyz&flag=1");
      expect(result).toBe(
        `https://api.example.com/v1?api_key=${REDACTED_PLACEHOLDER}&token=${REDACTED_PLACEHOLDER}&flag=1`,
      );
    });

    it("заменяет присваивания вида name = value (включая quoted)", () => {
      const redactor = new Redactor();
      const result = redactor.redact(`export API_KEY="${SK}-qwertyuiopasdfghjklzxcvbnm1234567890";`);
      expect(result).toBe(`export API_KEY="${REDACTED_PLACEHOLDER}";`);
    });

    it("заменяет ключи GitHub (ghp_ / github_pat_) и AWS (AKIA/ASIA)", () => {
      const redactor = new Redactor();
      expect(redactor.redact(`ghp_${b64url(40)}`)).toBe(REDACTED_PLACEHOLDER);
      expect(redactor.redact(`github_pat_${b64url(24)}`)).toBe(REDACTED_PLACEHOLDER);
      expect(redactor.redact(`AKIA${b64url(16)}`)).toBe(REDACTED_PLACEHOLDER);
      expect(redactor.redact(`ASIA${b64url(16)}`)).toBe(REDACTED_PLACEHOLDER);
      expect(redactor.redact(`xoxb-${b64url(12)}`)).toBe(REDACTED_PLACEHOLDER);
    });

    it("заменяет блоки приватных ключей целиком", () => {
      const redactor = new Redactor();
      const pem = ["-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFA", "-----END PRIVATE KEY-----"].join(NL);
      expect(redactor.redact(pem)).toBe(REDACTED_PLACEHOLDER);
    });
  });

  describe("безопасный текст без изменений", () => {
    it("не трогает обычный текст и числа", () => {
      const redactor = new Redactor();
      const text = "Run 42 completed in 12.5s with status PASS";
      expect(redactor.redact(text)).toBe(text);
    });

    it("не трогает URL без credentials", () => {
      const redactor = new Redactor();
      const text = "https://api.example.com/v1/results?page=2&limit=10";
      expect(redactor.redact(text)).toBe(text);
    });

    it("не трогает email-адреса и host:port", () => {
      const redactor = new Redactor();
      const text = "contact dev@example.com on localhost:8080";
      expect(redactor.redact(text)).toBe(text);
    });

    it("не трогает пустую строку и пробелы", () => {
      const redactor = new Redactor();
      expect(redactor.redact("")).toBe("");
      expect(redactor.redact("   \n\t ")).toBe("   \n\t ");
    });
  });

  describe("без утечки при partial-match", () => {
    it("не заменяет обрезанный JWT (без третьего сегмента)", () => {
      const redactor = new Redactor();
      const partial = jwtOf(12, 12);
      expect(redactor.redact(partial)).toBe(partial);
    });

    it("не заменяет короткий фрагмент sk-...", () => {
      const redactor = new Redactor();
      const partial = "sk-qw12";
      expect(redactor.redact(partial)).toBe(partial);
    });

    it("не заменяет URL-credentials без scheme", () => {
      const redactor = new Redactor();
      const text = "user:pass@example.com";
      expect(redactor.redact(text)).toBe(text);
    });
  });

  describe("точные и префиксные литералы из runtime (allowlist)", () => {
    it("addExact заменяет точное вхождение", () => {
      const redactor = new Redactor();
      redactor.addExact("top-secret-value");
      expect(redactor.redact("Found top-secret-value in log")).toBe("Found [REDACTED] in log");
    });

    it("addPrefix заменяет значение до разделителя", () => {
      const redactor = new Redactor();
      redactor.addPrefix("TESTTOKEN");
      expect(redactor.redact("grant=TESTTOKEN_abc123;")).toBe("grant=[REDACTED];");
    });

    it("addPrefix не заменяет частичное совпадение без полного значения", () => {
      const redactor = new Redactor();
      redactor.addPrefix("SENSITIVE");
      const partial = "SENSITIV";
      expect(redactor.redact(partial)).toBe(partial);
    });
  });

  describe("детерминизм и идемпотентность", () => {
    it("одинаковый вход даёт одинаковый результат и между экземплярами", () => {
      const jwt = jwtOf(12, 12, 16);
      const input = `https://u:p@example.com?api_key=${SK}-proj-${b64url(30)}&t=${jwt}`;
      const a = new Redactor();
      const b = new Redactor();
      expect(a.redact(input)).toBe(b.redact(input));
      expect(a.redact(input)).toBe(a.redact(input));
    });

    it("повторная redaction не меняет результат (плейсхолдер инертен)", () => {
      const redactor = new Redactor();
      const once = redactor.redact(`key=${SK}-proj-${b64url(30)}`);
      expect(redactor.redact(once)).toBe(once);
    });
  });

  describe("ограничение размера входа", () => {
    it("бросает RangeError при превышении лимита", () => {
      const redactor = new Redactor();
      const oversized = "a".repeat(MAX_REDACT_INPUT_LENGTH + 1);
      expect(() => redactor.redact(oversized)).toThrowError(/REDACT_INPUT_TOO_LARGE/);
    });

    it("обрабатывает вход ровно на лимите", () => {
      const redactor = new Redactor();
      const atLimit = "x".repeat(MAX_REDACT_INPUT_LENGTH);
      expect(redactor.redact(atLimit)).toBe(atLimit);
    });

    it("бросает TypeError для нестрокового входа", () => {
      const redactor = new Redactor();
      expect(() => redactor.redact(null as unknown as string)).toThrowError(/REDACT_INPUT_MUST_BE_STRING/);
      expect(() => redactor.redact(42 as unknown as string)).toThrowError(/REDACT_INPUT_MUST_BE_STRING/);
      expect(() => safeRedact(undefined as unknown as string)).toThrowError(/REDACT_INPUT_MUST_BE_STRING/);
    });

    it("safeRedact не бросает и обрезает вход до лимита", () => {
      const oversized = "b".repeat(MAX_REDACT_INPUT_LENGTH + 10);
      const result = safeRedact(oversized);
      expect(result.length).toBe(MAX_REDACT_INPUT_LENGTH);
      const safe = safeRedact("hello 123");
      expect(safe).toBe("hello 123");
    });

    it("safeRedact скрывает секрет даже в обрезанном вводе", () => {
      const token = `${SK}-proj-${b64url(30)}`;
      const oversized = `${token}${"c".repeat(MAX_REDACT_INPUT_LENGTH + 1)}`;
      const result = safeRedact(oversized);
      expect(result).not.toContain(token);
      expect(result.length).toBeLessThanOrEqual(MAX_REDACT_INPUT_LENGTH);
    });
  });
});
