import { createHash, randomBytes } from "node:crypto";
import { AUTH_TOKEN_BYTES } from "@ebb-orchestrator/contracts";

/** Версия server-owned auth port seam; изменение требует согласованного обновления downstream consumers. */
export const AUTH_PORT_CONTRACT_VERSION = 2 as const;
/** RFC3339 UTC timestamp, который создаёт доверенный server clock; client input не является authority. */
export type UtcTimestamp = string;
/** Mutable bytes boundary: вызывающий код владеет буфером и обнуляет его в `finally`; port его не сохраняет. */
export type RawSecretBytes = Uint8Array;

/** Доверенный источник времени для auth service и transaction rules; ошибка не маскируется fallback-значением. */
export interface AuthClock {
  now(): UtcTimestamp;
}
/** CSPRNG boundary: получает ресурс ОС, возвращает временный raw token и пробрасывает ошибку без fallback. */
export interface RandomTokenPort {
  randomBytes(length: typeof AUTH_TOKEN_BYTES): RawSecretBytes;
}
/** SHA-256 boundary для token hashes: расходует CPU, не сохраняет raw bytes и пробрасывает ошибку. */
export interface DigestPort {
  sha256Hex(raw: Readonly<RawSecretBytes>): string;
}
/** Argon2id boundary: расходует ограниченные CPU/память, читает secret только во время вызова и не возвращает derived bytes. */
export interface PasswordHasher {
  hash(password: Readonly<RawSecretBytes>): Promise<string>;
  verify(encoded: string, password: Readonly<RawSecretBytes>): Promise<boolean>;
}

/** Ошибки auth service, которые route layer преобразует в versioned HTTP codes; raw secrets и storage details не включаются. */
export type AuthPortErrorCode =
  | "INVALID_CREDENTIALS"
  | "SESSION_INVALID"
  | "CSRF_INVALID"
  | "UNAVAILABLE";

/** Создаёт production CSPRNG adapter; системный entropy/CPU расходуется синхронно, ошибка уходит вызывающему коду. */
export function createNodeRandomTokenPort(): RandomTokenPort {
  return {
    randomBytes(length: typeof AUTH_TOKEN_BYTES): RawSecretBytes {
      return randomBytes(length);
    },
  };
}

/** Создаёт production SHA-256 adapter с lowercase hex; raw bytes читаются один раз, не удерживаются, ошибки пробрасываются. */
export function createNodeDigestPort(): DigestPort {
  return {
    sha256Hex(raw: Readonly<RawSecretBytes>): string {
      return createHash("sha256").update(Buffer.from(raw)).digest("hex");
    },
  };
}
