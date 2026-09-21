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
  /** Loopback host, к которому привязывается сервер; по умолчанию 127.0.0.1. */
  host: string;
  /** Порт, на котором сервер принимает соединения. */
  port: number;
}

export interface LocalSession {
  /** Bearer-токен, который должны передавать клиенты. */
  token: string;
  /** Полный origin для валидации, например "http://127.0.0.1:3000". */
  allowedOrigin: string;
  /** Отдельный synchronizer token, обязательный для каждого запроса, меняющего состояние. */
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
