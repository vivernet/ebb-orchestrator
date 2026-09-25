import argon2 from "argon2";
import type { PasswordHasher, RawSecretBytes } from "./auth-ports.js";

/**
 * Неподменяемые параметры Argon2id v=19 для локального password hash.
 * Одна операция расходует до 64 MiB и CPU при `parallelism=4`; это намеренный resource side effect.
 * PHC string сохраняет algorithm, version, parameters, salt и digest целиком, но не raw secret/derived bytes.
 */
export const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  version: 0x13,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  saltLength: 16,
} as const;

const LOCKED_PHC_PATTERN = /^\$argon2id\$v=19\$m=65536,p=4,t=3\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function hasDecodedPhcLength(value: string, expectedLength: number): boolean {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === expectedLength && decoded.toString("base64").replace(/=+$/, "") === value;
}

function isLockedPhc(encoded: string): boolean {
  const match = LOCKED_PHC_PATTERN.exec(encoded);
  const salt = match?.[1];
  const digest = match?.[2];
  return salt !== undefined
    && digest !== undefined
    && hasDecodedPhcLength(salt, ARGON2ID_OPTIONS.saltLength)
    && hasDecodedPhcLength(digest, ARGON2ID_OPTIONS.hashLength);
}

/**
 * Создаёт единственный production PasswordHasher на pinned native Argon2id.
 * Доверенная server boundary передаёт Readonly view временного raw secret и обнуляет owner buffer после вызова;
 * native addon его не сохраняет. Операционные ошибки `hash` и `verify` пробрасываются для преобразования вызывающим слоем в `UNAVAILABLE`; `verify` возвращает `false` только для некорректного/неподдерживаемого PHC и действительного несовпадения.
 */
export function createArgon2PasswordHasher(): PasswordHasher {
  return {
    async hash(password: Readonly<RawSecretBytes>): Promise<string> {
      return argon2.hash(Buffer.from(password), ARGON2ID_OPTIONS);
    },
    async verify(encoded: string, password: Readonly<RawSecretBytes>): Promise<boolean> {
      if (!isLockedPhc(encoded)) return false;
      return argon2.verify(encoded, Buffer.from(password));
    },
  };
}
