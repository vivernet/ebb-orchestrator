/**
 * Abstract database adapter interface.
 */

import type { SQLInputValue } from "node:sqlite";

export type StatementParams = Record<string, SQLInputValue>;

export interface DatabaseTx {
  run(sql: string, params?: StatementParams): void;
  get<T = Record<string, unknown>>(sql: string, params?: StatementParams): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: StatementParams): T[];
  exec(sql: string): void;
}

export interface Database extends DatabaseTx {
  transaction<T>(fn: (tx: DatabaseTx) => T): T;
  close(): void;
}
