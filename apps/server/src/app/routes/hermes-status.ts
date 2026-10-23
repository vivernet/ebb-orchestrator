import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import type { HermesStatusProjection } from "@ebb-orchestrator/contracts";
import { listSupportedModels } from "../../modules/runtime/hermes/hermes-provider-registry.js";
import { loadOrchestratorEnv } from "../../platform/config/orchestrator-env-loader.js";
import {
  resolveHermesExecutable,
  type HermesExecutableResolution,
} from "../../modules/runtime/hermes/hermes-executable-resolver.js";
import { ProcessExecutor } from "../../platform/process/process-executor.js";

export interface HermesStatusRouteDeps {
  /** Test seam резолва установленного Hermes; production — `resolveHermesExecutable`. */
  resolveHermesExecutable?: typeof resolveHermesExecutable;
  /** Test seam пробы версии; production — безопасный запуск `hermes --version`. */
  probeHermesVersion?: (resolution: HermesExecutableResolution) => Promise<string | null>;
}

/** Дефолтный провайдер legacy-пути (без явного выбора модели). */
const DEFAULT_PROVIDER = "hermes-managed";
/** Дефолтная модель: `default` означает «без явного выбора» (legacy). */
const DEFAULT_MODEL = "default";
/** Таймаут пробы версии Hermes; CLI — локальный, но должен быть ограничен. */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

/**
 * Регистрирует read-only роут статуса Hermes: версия установленного CLI,
 * дефолтный провайдер/модель и список моделей реестра с признаком настроенного
 * ключа. Значения ключей и endpoint URL провайдеров никогда не возвращаются;
 * при недоступности CLI `hermesVersion` равен `null`, остальное строится из
 * статического реестра.
 */
export async function hermesStatusRoutes(app: FastifyInstance, deps: HermesStatusRouteDeps = {}): Promise<void> {
  const resolveExecutable = deps.resolveHermesExecutable ?? resolveHermesExecutable;
  const probeVersion = deps.probeHermesVersion ?? probeInstalledHermesVersion;

  app.get("/api/v1/hermes/status", async (): Promise<HermesStatusProjection> => {
    let hermesVersion: string | null = null;
    try {
      const resolution = await resolveExecutable();
      hermesVersion = await probeVersion(resolution);
    } catch {
      // Резолв/проба недоступны — версия остаётся null; статус не падает.
      hermesVersion = null;
    }

    const modelSelection = listSupportedModels().map((entry) => ({
      model: entry.model,
      provider: entry.provider,
      keyConfigured: Boolean(loadOrchestratorEnv([entry.envKey])[entry.envKey]),
    }));

    return {
      hermesVersion,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
      keyConfigured: modelSelection.some((entry) => entry.keyConfigured),
      modelSelection,
    };
  });
}

/**
 * Безопасно получает версию установленного Hermes через `hermes --version`.
 * На Windows launcher `hermes.cmd` не запускается напрямую (EINVAL), поэтому
 * предпочитается соседний `hermes.exe` (порядок разрешения CreateProcess по
 * PATHEXT). Любая ошибка запуска/ненулевой exit-код трактуется как null.
 */
async function probeInstalledHermesVersion(resolution: HermesExecutableResolution): Promise<string | null> {
  let executable = resolution.executablePath;
  if (process.platform === "win32" && path.win32.extname(executable).toLowerCase() === ".cmd") {
    const exe = path.win32.join(path.win32.dirname(executable), "hermes.exe");
    if (existsSync(exe)) executable = exe;
  }

  try {
    const result = await new ProcessExecutor().exec(executable, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: 8_192,
    });
    const version = result.stdout.trim();
    return version ? version : null;
  } catch {
    return null;
  }
}
