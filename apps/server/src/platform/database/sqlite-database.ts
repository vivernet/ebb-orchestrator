/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

import { DatabaseSync } from "node:sqlite";
import type { Database, DatabaseTx, StatementParams } from "./database.js";

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
function toBindParams(params?: StatementParams): StatementParams | undefined {
  if (params === undefined) return undefined;
  const out = {} as Record<string, import("node:sqlite").SQLInputValue>;
  for (const [k, v] of Object.entries(params)) {
    out[k.startsWith("$") ? k : `$${k}`] = v;
  }
  return out;
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
function createTx(db: DatabaseSync): DatabaseTx {
  return {
    run(sql: string, params?: StatementParams): void {
      const bound = toBindParams(params);
      if (bound !== undefined) {
        db.prepare(sql).run(bound);
      } else {
        db.prepare(sql).run();
      }
    },

    get<T = Record<string, unknown>>(sql: string, params?: StatementParams): T | undefined {
      const bound = toBindParams(params);
      const row =
        bound !== undefined
          ? db.prepare(sql).get(bound)
          : db.prepare(sql).get();
      return row as T | undefined;
    },

    all<T = Record<string, unknown>>(sql: string, params?: StatementParams): T[] {
      const bound = toBindParams(params);
      const rows =
        bound !== undefined
          ? db.prepare(sql).all(bound)
          : db.prepare(sql).all();
      return rows as T[];
    },

    exec(sql: string): void {
      db.exec(sql);
    },
  };
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
export function createSqliteDatabase(path: string): Database {
  const db = new DatabaseSync(path);

  // Выполняет соответствующую проверку или действие согласно контракту.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  const defaultTx = createTx(db);

  return {
    run: defaultTx.run,
    get: defaultTx.get,
    all: defaultTx.all,
    exec: defaultTx.exec,

    transaction<T>(fn: (tx: DatabaseTx) => T): T {
      db.exec("BEGIN IMMEDIATE");
      const tx = createTx(db);
      try {
        const result = fn(tx);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    close() {
      db.close();
    },
  };
}
