import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHermesExecutable } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";

/**
 * СПАЙК-КОНТРАКТ CLI УСТАНОВЛЕННОГО HERMES (Task 1 плана 23, IN-005).
 *
 * Тест read-only, маркер-гейтед: запускается только при
 * `EBB_RUN_PROVIDER_SPIKE_ACCEPTANCE='I_UNDERSTAND_THIS_IS_A_READ_ONLY_PROBE'`.
 * Без маркера набор пропускается (describe.skipIf). Никаких запросов к
 * провайдеру, чтения/вывода секретов и изменений production-кода не происходит.
 */

const ACCEPTANCE_MARKER = "I_UNDERSTAND_THIS_IS_A_READ_ONLY_PROBE";
const enabled = process.env.EBB_RUN_PROVIDER_SPIKE_ACCEPTANCE === ACCEPTANCE_MARKER;

/**
 * КОНТРАКТ НАЗВАНИЙ ENV-ПЕРЕМЕННЫХ BUILT-IN ПРОВАЙДЕРОВ.
 * Стандартное имя для built-in провайдера Hermes — `<ИМЯ>_API_KEY`.
 * Этот список фиксируется здесь как контракт Task 1 и будет использован
 * реестром `hermes-provider-registry.ts` (Task 2) без чтения файлов пользователя:
 *  - openai-api  -> OPENAI_API_KEY      (OpenAI)
 *  - anthropic   -> ANTHROPIC_API_KEY   (Anthropic)
 * Значения ключей в этом контракте никогда не появляются; чтение
 * `~/.hermes/.env`, `auth.json` и `config.yaml` запрещено.
 */

/**
 * ПОЛИТИКА АНТИ-ЗАТЕНЕНИЯ (зафиксирована документально).
 *
 * 1. Ebb НЕ читает пользовательский `~/.hermes/.env`, `auth.json` и
 *    `config.yaml`. Ключи провайдеров передаются только через child-окружение
 *    процесса Hermes (строго по allowlist имён из реестра, Task 3/5).
 * 2. Hermes с флагом `--ignore-user-config` игнорирует пользовательский
 *    `config.yaml` и возвращается к built-in дефолтам; по справке CLI
 *    credentials из `.env` при этом продолжают загружаться.
 * 3. Приоритет источника ключа (документированная политика):
 *    переданный Ebb в окружение процесса ключ (явный env) должен иметь
 *    приоритет над любым `.env`, который мог бы загрузить сам Hermes.
 *    Коллизия устраняется уникальностью имён из реестра (обычно `OPENAI_API_KEY`),
 *    поэтому пользовательский `.env` не может перекрыть переданный env.
 * 4. Поведенческая проверка в этом спайке ограничена безопасными операциями:
 *    `--help` и `config get --json` без provider-запроса и без чтения файлов
 *    пользователя. Реальный выбор источника ключа невозможен без provider-запроса,
 *    поэтому здесь фиксируется только сам контракт и доступность флагов.
 */

/** Типичные паттерны секретов для проверки отсутствия утечки в выводе. */
function hasSecretPattern(text: string): boolean {
  return [
    /\b(?:sk|rk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/iu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/iu,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?[^\s"',}]+/iu,
  ].some((pattern) => pattern.test(text));
}

/**
 * Запускает установленный Hermes CLI неинтерактивно.
 * Механизм резолва — `resolveHermesExecutable` из production-кода
 * (преимущественно `<HERMES_HOME>/bin`); на Windows spawn `.cmd` напрямую
 * невозможен (EINVAL), поэтому предпочитается соседний `hermes.exe` — это
 * соответствует порядку разрешения CreateProcess по PATHEXT (.EXE раньше .CMD).
 */
async function runHermesCli(args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const resolution = await resolveHermesExecutable();
  let executable = resolution.executablePath;
  if (path.win32.extname(executable).toLowerCase() === ".cmd") {
    const exe = path.win32.join(path.win32.dirname(executable), "hermes.exe");
    if (existsSync(exe)) executable = exe;
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); }, 120_000);
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`SPAWN_FAILED:${error.message}`));
    });
    child.once("close", (code: number | null) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

describe.skipIf(!enabled || !["win32", "linux"].includes(process.platform))(
  "Plan23 Task1 — Hermes CLI provider-selection spike (read-only)",
  () => {
    it("(а) `hermes chat --help` содержит флаги выбора провайдера/модели и stream-json", async () => {
      const result = await runHermesCli(["chat", "--help"]);
      expect(result.exitCode, `help должен завершиться успешно; stderr: ${result.stderr.slice(-500)}`).toBe(0);
      expect(result.stdout).toContain("--provider");
      expect(result.stdout).toContain("-m");
      expect(result.stdout).toContain("--model");
      expect(result.stdout).toContain("--oneshot");
      expect(result.stdout).toContain("--ignore-user-config");
      expect(result.stdout).toContain("--format");
      expect(result.stdout).toContain("stream-json");
      expect(hasSecretPattern(result.stdout)).toBe(false);
    }, 180_000);

    it("(б) `hermes config get model.provider/model.default --json` успешен и несекретен", async () => {
      for (const key of ["model.provider", "model.default"]) {
        const result = await runHermesCli(["config", "get", key, "--json"]);
        expect(result.exitCode, `config get ${key} должен завершиться успешно; stderr: ${result.stderr.slice(-500)}`).toBe(0);
        const parsed: unknown = JSON.parse(result.stdout.trim());
        expect(typeof parsed, `${key} должен быть валидным JSON со строковым значением`).toBe("string");
        expect(hasSecretPattern(result.stdout), `stdout ${key} не должен содержать секретов`).toBe(false);
        expect(hasSecretPattern(result.stderr), `stderr ${key} не должен содержать секретов`).toBe(false);
      }
    }, 180_000);

    it("(г) анти-затенение: `--ignore-user-config` доступен и не ломает `--help`", async () => {
      const result = await runHermesCli(["chat", "--help", "--ignore-user-config"]);
      expect(result.exitCode, `help c --ignore-user-config должен завершиться успешно; stderr: ${result.stderr.slice(-500)}`).toBe(0);
      expect(result.stdout).toContain("--ignore-user-config");
      expect(result.stdout).toContain("--provider");
      expect(result.stdout).toContain("--model");
      expect(result.stdout).toContain("--oneshot");
      expect(result.stdout).toContain("stream-json");
      expect(hasSecretPattern(result.stdout)).toBe(false);
    }, 180_000);
  },
);
