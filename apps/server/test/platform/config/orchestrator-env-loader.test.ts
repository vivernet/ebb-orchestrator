import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOrchestratorEnv } from "../../../src/platform/config/orchestrator-env-loader.js";

/** Ключи, которые могут лежать в реальном окружении запуска тестов. */
const AMBIENT_KEYS = ["OPENAI_API_KEY", "OTHER", "KEY1", "KEY2", "KEY3"] as const;

/** Временные домашние каталоги оркестратора, созданные тестами. */
const HOME_DIRS: string[] = [];

/** Резервная копия ambient-переменных для восстановления после теста. */
let savedAmbient: Record<string, string | undefined>;

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ebb-env-loader-"));
  HOME_DIRS.push(dir);
  return dir;
}

function writeEnvFile(content: string): void {
  const home = process.env.EBB_ORCHESTRATOR_HOME;
  if (!home) {
    throw new Error("EBB_ORCHESTRATOR_HOME не задана в beforeEach");
  }
  writeFileSync(join(home, ".env"), content, "utf8");
}

describe("loadOrchestratorEnv", () => {
  beforeEach(() => {
    // Изолируемся от реального окружения: подменяем EBB_ORCHESTRATOR_HOME
    // на временную директорию и убираем ambient-ключи из process.env.
    savedAmbient = {};
    for (const key of AMBIENT_KEYS) {
      savedAmbient[key] = process.env[key];
      delete process.env[key];
    }
    vi.stubEnv("EBB_ORCHESTRATOR_HOME", makeTempHome());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of AMBIENT_KEYS) {
      if (savedAmbient[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedAmbient[key];
      }
    }
    for (const dir of HOME_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("возвращает только allowlist-ключи из .env, игнорируя неизвестные", () => {
    writeEnvFile("OPENAI_API_KEY=secret\nOTHER=ignored\n");

    const result = loadOrchestratorEnv(["OPENAI_API_KEY"]);

    expect(result).toEqual({ OPENAI_API_KEY: "secret" });
  });

  it("отдаёт приоритет process.env над значением из .env", () => {
    writeEnvFile("OPENAI_API_KEY=from-env-file\n");
    vi.stubEnv("OPENAI_API_KEY", "from-process-env");

    const result = loadOrchestratorEnv(["OPENAI_API_KEY"]);

    expect(result).toEqual({ OPENAI_API_KEY: "from-process-env" });
  });

  it("возвращает {} при отсутствующем файле .env", () => {
    const result = loadOrchestratorEnv(["OPENAI_API_KEY", "MISSING"]);

    expect(result).toEqual({});
  });

  it("бросает ORCHESTRATOR_ENV_PARSE_FAILED на битой строке без '='", () => {
    writeEnvFile("OPENAI_API_KEY=secret\nTHIS_IS_BROKEN\n");

    expect(() => loadOrchestratorEnv(["OPENAI_API_KEY"])).toThrow(
      "ORCHESTRATOR_ENV_PARSE_FAILED",
    );
  });

  it("минимально парсит значения: убирает пробелы вокруг '=' и обрамляющие кавычки", () => {
    writeEnvFile(' KEY1 = "value one"\nKEY2=\'single\'\nKEY3= plain \n');

    const result = loadOrchestratorEnv(["KEY1", "KEY2", "KEY3"]);

    expect(result).toEqual({
      KEY1: "value one",
      KEY2: "single",
      KEY3: "plain",
    });
  });

  it("игнорирует пустые строки и комментарии, не возвращает ключи вне allowlist", () => {
    writeEnvFile("\n# комментарий\nOPENAI_API_KEY=secret\nANOTHER=ignored\n");

    const result = loadOrchestratorEnv(["OPENAI_API_KEY"]);

    expect(result).toEqual({ OPENAI_API_KEY: "secret" });
  });
});
