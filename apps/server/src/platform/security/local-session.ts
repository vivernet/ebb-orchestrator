/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

import crypto from "node:crypto";

export interface LocalSessionConfig {
  /** The loopback host the server binds to (default 127.0.0.1). */
  host: string;
  /** The port the server listens on. */
  port: number;
}

export interface LocalSession {
  /** The bearer token clients must send. */
  token: string;
  /** Fully-qualified origin used for validation, e.g. "http://127.0.0.1:3000". */
  allowedOrigin: string;
  /** Separate synchronizer token required on every state-changing request. */
  csrfToken: string;
  /** Одноразовый launch capability для первичной выдачи browser session. */
  bootstrapToken: string | null;
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
export function createLocalSession(config: LocalSessionConfig): LocalSession {
  const token = crypto.randomBytes(32).toString("hex");
  const allowedOrigin = `http://${config.host}:${config.port}`;
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const bootstrapToken = crypto.randomBytes(32).toString("hex");
  return { token, allowedOrigin, csrfToken, bootstrapToken };
}
