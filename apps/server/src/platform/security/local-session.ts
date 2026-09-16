/**
 * Local session authentication for the orchestrator server.
 *
 * Generates a random bearer token at startup. Every mutating / protected
 * API request must include `Authorization: Bearer <token>`. The health
 * endpoint is exempt from authentication.
 *
 * Also enforces origin validation on mutating (POST/PUT/PATCH/DELETE)
 * requests to prevent CSRF-style attacks. When an `Origin` header is
 * present and does not match the server's own address the request is
 * rejected with 403 Forbidden.
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
}

/**
 * Create a one-shot local session with a cryptographically random token.
 */
export function createLocalSession(config: LocalSessionConfig): LocalSession {
  const token = crypto.randomBytes(32).toString("hex");
  const allowedOrigin = `http://${config.host}:${config.port}`;
  return { token, allowedOrigin };
}
