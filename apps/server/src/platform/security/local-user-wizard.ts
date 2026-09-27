import { timingSafeEqual } from "node:crypto";
import type { AuthRepository } from "./auth-repository.js";
import type { RawSecretBytes } from "./auth-ports.js";

const MINIMUM_PASSWORD_LENGTH = 12;
const DEFAULT_NOW = (): string => new Date().toISOString();

type WizardInput = NodeJS.ReadStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => NodeJS.ReadStream;
};
type WizardOutput = NodeJS.WriteStream & { isTTY?: boolean };
type SecretChunk = Uint8Array;

/** Результат TTY wizard; секреты и сведения о хранилище не пересекают эту границу. */
export type LocalUserWizardResult = "CREATED" | "FAILED";

/** Параметры первого запуска; `mode` выбирает только явно разрешённый stdin protocol, `now` нужен тестам. */
export interface LocalUserWizardOptions {
  mode?: "tty" | "stdin";
  inputTimeoutMs?: number;
  now?: () => string;
}

/**
 * Проверяет наличие единственной локальной учётной записи и запускает настройку
 * только при её отсутствии. Существующая учётная запись не требует TTY и не
 * вызывает интерактивный ввод. Режим `stdin` предназначен только для явно
 * выбранного автоматизированного запуска; секреты поступают через pipe, а не
 * аргументы, окружение или файлы. Ошибки чтения и проверки прекращают запуск.
 */
export async function ensureLocalUser(
  authRepository: AuthRepository,
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  options: LocalUserWizardOptions = {},
): Promise<"EXISTING" | "CREATED"> {
  if (await authRepository.hasLocalUser()) return "EXISTING";
  const result = options.mode === "stdin"
    ? await runLocalUserStdinWizard(input, output, authRepository, options)
    : await runLocalUserWizard(input, output, authRepository, options);
  if (result !== "CREATED") {
    throw new Error("Local user setup failed; rerun the server from an interactive TTY.");
  }
  return "CREATED";
}

/**
 * Создаёт единственного локального пользователя через stdin/stdout TTY.
 *
 * Пароль читается только в raw mode, режим и echo восстанавливаются при любом
 * исходе, а все принадлежащие wizard буферы обнуляются до выхода. Не-TTY,
 * несовпадение, слабый ввод, EOF и ошибки ввода завершают запуск отказом;
 * пароль, хэш и диагностические сведения не выводятся.
 */
export async function runLocalUserWizard(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  authRepository: AuthRepository,
  options: LocalUserWizardOptions = {},
): Promise<LocalUserWizardResult> {
  const ttyInput = input as WizardInput;
  const ttyOutput = output as WizardOutput;
  if (ttyInput.isTTY !== true || ttyOutput.isTTY !== true || typeof ttyInput.setRawMode !== "function") {
    throw new Error("First-run local user setup requires an interactive TTY on stdin and stdout; rerun with a terminal.");
  }

  const password = await readSecret(ttyInput, ttyOutput, "Создайте локальный пароль: ");
  let confirmation: RawSecretBytes | undefined;
  try {
    confirmation = await readSecret(ttyInput, ttyOutput, "Повторите локальный пароль: ");
    if (!secretsEqual(password, confirmation)) {
      await writeOutput(ttyOutput, "Пароли не совпадают. Сервер остановлен; повторите запуск интерактивно.\n");
      return "FAILED";
    }

    if (!isStrongSecret(password)) {
      await writeOutput(ttyOutput, `Пароль слишком слабый: используйте не менее ${MINIMUM_PASSWORD_LENGTH} байт.\n`);
      return "FAILED";
    }

    await authRepository.createLocalUser(password, (options.now ?? DEFAULT_NOW)());
    await writeOutput(ttyOutput, "Локальный пользователь создан.\n");
    return "CREATED";
  } finally {
    password.fill(0);
    confirmation?.fill(0);
  }
}

/**
 * Читает две завершённые LF/CRLF записи из pipe с ограничением размера и времени.
 * Deadline охватывает только ввод; валидация и Argon2id выполняются после EOF.
 */
async function runLocalUserStdinWizard(
  input: NodeJS.ReadStream,
  _output: NodeJS.WriteStream,
  authRepository: AuthRepository,
  options: LocalUserWizardOptions,
): Promise<LocalUserWizardResult> {
  const records: Uint8Array[] = [];
  let current: number[] = [];
  let sawCR = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const timeoutMs = options.inputTimeoutMs ?? 60_000;
  const clearDeadline = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const pair = await new Promise<Uint8Array[]>((resolve, reject) => {
    const cleanup = (pause: boolean): void => {
      clearDeadline();
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      if (pause) input.pause();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup(true);
      for (const record of records) record.fill(0);
      current.fill(0);
      reject(error);
    };
    const onData = (chunk: SecretChunk): void => {
      if (!(chunk instanceof Uint8Array)) {
        fail(new Error("Password input must use binary chunks."));
        return;
      }
      for (const byte of chunk) {
        if (records.length === 2) {
          fail(new Error("Unexpected bytes after the second password record."));
          return;
        }
        if (sawCR) {
          if (byte !== 0x0a) {
            fail(new Error("Malformed password record framing."));
            return;
          }
          sawCR = false;
          records.push(Uint8Array.from(current));
          current.fill(0);
          current = [];
          continue;
        }
        if (byte === 0x0d) {
          sawCR = true;
          continue;
        }
        if (byte === 0x0a) {
          records.push(Uint8Array.from(current));
          current.fill(0);
          current = [];
          continue;
        }
        current.push(byte);
        if (current.length > 4096) {
          fail(new Error("Password record exceeds the 4096-byte limit."));
          return;
        }
      }
    };
    const onEnd = (): void => {
      clearDeadline();
      if (sawCR || current.length !== 0 || records.length !== 2) {
        fail(new Error("Password input must contain exactly two newline-terminated records."));
        return;
      }
      settled = true;
      cleanup(false);
      resolve(records);
    };
    const onError = (): void => fail(new Error("Password input failed."));
    timer = setTimeout(() => fail(new Error("Password input timed out.")), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    try {
      input.resume();
    } catch {
      fail(new Error("Password input failed."));
    }
  });

  const [password, confirmation] = pair;
  try {
    if (!secretsEqual(password!, confirmation!)) return "FAILED";
    if (!isStrongSecret(password!)) return "FAILED";
    await authRepository.createLocalUser(password!, (options.now ?? DEFAULT_NOW)());
    return "CREATED";
  } finally {
    password!.fill(0);
    confirmation!.fill(0);
  }
}

/** Читает секрет побайтно и гарантирует снятие обработчиков и raw mode. */
async function readSecret(input: WizardInput, output: WizardOutput, prompt: string): Promise<RawSecretBytes> {
  let buffer = new Uint8Array(64);
  let primaryError: unknown;
  let hasPrimaryError = false;
  let cleanupError: unknown;
  let result: RawSecretBytes | undefined;
  let rawModeEnabled = false;
  try {
    input.setRawMode!(true);
    rawModeEnabled = true;
    await writeOutput(output, prompt);

    result = await new Promise<RawSecretBytes>((resolve, reject) => {
      let length = 0;
      let settled = false;

      const cleanup = (): void => {
        input.pause();
        input.off("data", onData);
        input.off("error", onError);
        input.off("end", onEnd);
      };
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error !== undefined) {
          buffer.fill(0);
          reject(error);
          return;
        }
        const result = new Uint8Array(buffer.subarray(0, length));
        buffer.fill(0);
        resolve(result);
      };
      const onError = (error: unknown): void => settle(error);
      const onEnd = (): void => settle(new Error("Password input closed unexpectedly (EOF)."));
      const onData = (chunk: SecretChunk): void => {
        try {
          if (!(chunk instanceof Uint8Array)) {
            settle(new Error("Password input must use binary chunks."));
            return;
          }
          for (const byte of chunk) {
            if (byte === 3) {
              settle(new Error("Password input interrupted."));
              return;
            }
            if (byte === 4) {
              settle(new Error("Password input closed."));
              return;
            }
            if (byte === 8 || byte === 127) {
              if (length > 0) {
                length -= 1;
                buffer[length] = 0;
              }
              continue;
            }
            if (byte === 10 || byte === 13) {
              settle();
              return;
            }
            if (length === buffer.length) {
              const next = new Uint8Array(buffer.length * 2);
              next.set(buffer);
              buffer.fill(0);
              buffer = next;
            }
            buffer[length] = byte;
            length += 1;
          }
        } catch (error) {
          settle(error);
        }
      };

      input.on("data", onData);
      input.once("error", onError);
      input.once("end", onEnd);
      try {
        input.resume();
      } catch (error) {
        settle(error);
      }
    });
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    buffer.fill(0);
    if (rawModeEnabled) {
      try {
        input.setRawMode!(false);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await writeOutput(output, "\n");
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  if (result === undefined) throw new Error("Password input completed without a value.");
  return result;
}

/** Проверяет минимальный размер и наличие значимого байта без создания строки пароля. */
function isStrongSecret(secret: Readonly<RawSecretBytes>): boolean {
  if (secret.length < MINIMUM_PASSWORD_LENGTH) return false;
  return secret.some((byte) => !isAsciiWhitespace(byte));
}

/** Сравнивает два сырых секрета без преобразования в строки. */
function secretsEqual(left: Readonly<RawSecretBytes>, right: Readonly<RawSecretBytes>): boolean {
  return left.length === right.length && timingSafeEqual(left as Uint8Array, right as Uint8Array);
}

/** Записывает сообщение и превращает ошибки Writable в обычный отказ wizard. */
function writeOutput(output: WizardOutput, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      output.off("error", onError);
    };
    const settle = (error?: unknown, deferCleanup = false): void => {
      if (settled) {
        if (!deferCleanup) cleanup();
        return;
      }
      settled = true;
      if (deferCleanup) {
        setImmediate(cleanup);
      } else {
        cleanup();
      }
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    };
    const onError = (error: unknown): void => settle(error);
    output.once("error", onError);
    try {
      output.write(text, (error?: Error | null) => {
        settle(error ?? undefined, error !== null && error !== undefined);
      });
    } catch (error) {
      settle(error);
    }
  });
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d || byte === 0x20;
}
