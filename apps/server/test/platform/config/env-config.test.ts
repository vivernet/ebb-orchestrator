/**
 * Тесты типизированной валидации env-конфигурации сервера.
 *
 * Покрывают контракт E4: fail-fast на границе чтения окружения,
 * допустимые значения, неизвестные переменные и отсутствие утечки значений в ошибках.
 */

import { describe, expect, it } from "vitest";
import {
  EnvValidationError,
  parseEnvConfig,
  type ServerEnv,
} from "../../../src/platform/config/env-config.js";

describe("parseEnvConfig", () => {
  it("разбирает валидный env: порт преобразуется в число, версия по умолчанию", () => {
    const result = parseEnvConfig({
      PORT: "8080",
      EBB_ORCHESTRATOR_HOME: "C:/Users/example/.ebb-orchestrator",
      EBB_ORCHESTRATOR_VERSION: "1.2.3",
    });

    expect(result).toEqual({
      PORT: 8080,
      EBB_ORCHESTRATOR_HOME: "C:/Users/example/.ebb-orchestrator",
      EBB_ORCHESTRATOR_VERSION: "1.2.3",
      HOME: undefined,
      USERPROFILE: undefined,
    } satisfies ServerEnv);
  });

  it("применяет умолчания: пустой порт 3000 и версия development", () => {
    const result = parseEnvConfig({ PORT: "" });

    expect(result.PORT).toBe(3000);
    expect(result.EBB_ORCHESTRATOR_VERSION).toBe("development");
    expect(result.EBB_ORCHESTRATOR_HOME).toBeUndefined();
  });

  it("отклоняет отсутствие обязательной переменной PORT", () => {
    expect(() => parseEnvConfig({})).toThrow(EnvValidationError);
    expect(() => parseEnvConfig({ EBB_ORCHESTRATOR_HOME: "/tmp/home" })).toThrow(EnvValidationError);
  });

  it.each([
    ["abc", "нечисловое значение"],
    ["0", "ноль"],
    ["-1", "отрицательное значение"],
    ["70000", "значение больше 65535"],
    ["3000.5", "нецелое значение"],
  ])("отклоняет невалидный порт %s (%s)", (port) => {
    expect(() => parseEnvConfig({ PORT: port })).toThrow(EnvValidationError);
  });

  it("трактует пустой PORT как отсутствующий и применяет умолчание", () => {
    expect(parseEnvConfig({ PORT: "" }).PORT).toBe(3000);
  });

  it("трактует пустые EBB_ORCHESTRATOR_HOME/HOME/USERPROFILE как отсутствующие", () => {
    const result = parseEnvConfig({
      PORT: "3000",
      EBB_ORCHESTRATOR_HOME: "   ",
      HOME: "",
      USERPROFILE: "  ",
    });

    expect(result.EBB_ORCHESTRATOR_HOME).toBeUndefined();
    expect(result.HOME).toBeUndefined();
    expect(result.USERPROFILE).toBeUndefined();
  });

  it("не отклоняет лишние неизвестные переменные и не включает их в результат", () => {
    const result = parseEnvConfig({
      PORT: "3000",
      UNKNOWN_EXTRA_VAR: "value",
      ANOTHER_UNKNOWN: "1",
    });

    expect(result).toEqual({
      PORT: 3000,
      EBB_ORCHESTRATOR_VERSION: "development",
      EBB_ORCHESTRATOR_HOME: undefined,
      HOME: undefined,
      USERPROFILE: undefined,
    });
  });

  it("не утекает значения в тексте ошибки", () => {
    const secretPort = "s3cret-port-value";
    let caught: EnvValidationError | undefined;
    try {
      parseEnvConfig({ PORT: secretPort });
    } catch (error) {
      if (error instanceof EnvValidationError) caught = error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(secretPort);
    expect(caught!.message).toContain("PORT");
    expect(caught!.issues.some((issue) => issue.path.join(".") === "PORT")).toBe(true);
    expect(JSON.stringify(caught!.issues)).not.toContain(secretPort);
  });

  it("отклоняет пустую версию при явном задании", () => {
    expect(() => parseEnvConfig({ EBB_ORCHESTRATOR_VERSION: "" })).toThrow(EnvValidationError);
  });
});
