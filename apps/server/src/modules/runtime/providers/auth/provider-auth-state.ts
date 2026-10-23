/**
 * Состояние и хранилище OAuth/device-потоков авторизации провайдеров
 * (plan-24, Task 4).
 *
 * Модель потока фиксирует: идентичность (flowId, providerId, methodId),
 * привязку к аутентифицированной сессии Ebb (`sessionBinding`), жизненный
 * цикл (`status`), срок действия (`expiresAt`) и интервал опроса.
 *
 * Безопасность и инварианты:
 *  - несекретное состояние (`ProviderAuthFlowRecord`) хранится отдельно от
 *    секретных артефактов потока (device_code, PKCE verifier/state, nonce);
 *    они живут в `AuthFlowSecretVault` и обнуляются после завершения/отмены/
 *    истечения потока;
 *  - публичные проекции (`toSafeFlowProjection`) никогда не содержат токенов,
 *    verifier/state, device_code и nonce — только статус и безопасные поля;
 *  - все операции привязаны к `sessionBinding`: использование чужого потока
 *    запрещено (проверяется в `ProviderAuthFlowService`);
 *  - истечение срока действия проверяется на каждый доступ (expiry
 *    enforcement) и переводит поток в `EXPIRED`.
 *
 * Персистентность: лёгкое состояние потоков живёт в памяти процесса
 * (`InMemoryAuthFlowStore`). Durable-метаданные потока (несекретные) поверх
 * SQLite требуют отдельной миграции и закреплены за более поздними задачами
 * плана; интерфейс `AuthFlowStore` оставляет seam для durable-адаптера.
 */

import { randomUUID } from "node:crypto";
import type { ProviderAuthMethod } from "../provider-types.js";

/** Статус потока авторизации. */
export type ProviderAuthFlowStatus =
  | "PENDING"
  | "COMPLETE"
  | "EXPIRED"
  | "DENIED"
  | "FAILED"
  | "CANCELLED";

/** Причина недоступности/сбоя для безопасного отображения (без секретов). */
export type ProviderAuthFailureKind =
  | "expired"
  | "denied"
  | "gateway"
  | "token-exchange"
  | "invalid-grant"
  | "callback-origin"
  | "state-mismatch"
  | "cancelled"
  | "unknown";

/** Запись несекретного состояния потока авторизации. */
export interface ProviderAuthFlowRecord {
  readonly flowId: string;
  readonly providerId: string;
  readonly methodId: ProviderAuthMethod;
  /** Привязка к аутентифицированной сессии Ebb. */
  readonly sessionBinding: string;
  readonly status: ProviderAuthFlowStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
  readonly failureKind?: ProviderAuthFailureKind;
}

/** Безопасная публичная проекция потока для Web/API. */
export interface ProviderAuthFlowProjection {
  readonly flowId: string;
  readonly providerId: string;
  readonly methodId: string;
  readonly status: ProviderAuthFlowStatus;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly failureKind?: ProviderAuthFailureKind;
}

/** Возвращает безопасную проекцию потока без секретных полей. */
export function toSafeFlowProjection(
  record: ProviderAuthFlowRecord,
  publicHints: { verificationUrl?: string; userCode?: string } = {},
): ProviderAuthFlowProjection {
  return {
    flowId: record.flowId,
    providerId: record.providerId,
    methodId: record.methodId,
    status: record.status,
    expiresAt: record.expiresAt,
    pollIntervalSeconds: record.pollIntervalSeconds,
    ...(publicHints.verificationUrl ? { verificationUrl: publicHints.verificationUrl } : {}),
    ...(publicHints.userCode ? { userCode: publicHints.userCode } : {}),
    ...(record.failureKind ? { failureKind: record.failureKind } : {}),
  };
}

/** Входные данные создания записи потока. */
export interface CreateAuthFlowInput {
  readonly providerId: string;
  readonly methodId: ProviderAuthMethod;
  readonly sessionBinding: string;
  readonly expiresAt: string;
  readonly pollIntervalSeconds: number;
  readonly now: string;
}

/** Контракт хранилища записей потоков (несекретное состояние). */
export interface AuthFlowStore {
  create(input: CreateAuthFlowInput): ProviderAuthFlowRecord;
  get(flowId: string): ProviderAuthFlowRecord | undefined;
  update(flowId: string, patch: Partial<Pick<ProviderAuthFlowRecord, "status" | "expiresAt" | "pollIntervalSeconds" | "failureKind">>): ProviderAuthFlowRecord | undefined;
  listBySession(sessionBinding: string): ProviderAuthFlowRecord[];
  delete(flowId: string): boolean;
}

/** Хранилище записей потоков в памяти процесса. */
export class InMemoryAuthFlowStore implements AuthFlowStore {
  private readonly records = new Map<string, ProviderAuthFlowRecord>();

  public create(input: CreateAuthFlowInput): ProviderAuthFlowRecord {
    const record: ProviderAuthFlowRecord = {
      flowId: randomUUID(),
      providerId: input.providerId,
      methodId: input.methodId,
      sessionBinding: input.sessionBinding,
      status: "PENDING",
      createdAt: input.now,
      expiresAt: input.expiresAt,
      pollIntervalSeconds: input.pollIntervalSeconds,
    };
    this.records.set(record.flowId, record);
    return record;
  }

  public get(flowId: string): ProviderAuthFlowRecord | undefined {
    return this.records.get(flowId);
  }

  public update(flowId: string, patch: Partial<Pick<ProviderAuthFlowRecord, "status" | "expiresAt" | "pollIntervalSeconds" | "failureKind">>): ProviderAuthFlowRecord | undefined {
    const current = this.records.get(flowId);
    if (!current) return undefined;
    const updated: ProviderAuthFlowRecord = {
      ...current,
      status: patch.status ?? current.status,
      expiresAt: patch.expiresAt ?? current.expiresAt,
      pollIntervalSeconds: patch.pollIntervalSeconds ?? current.pollIntervalSeconds,
      ...(patch.failureKind !== undefined ? { failureKind: patch.failureKind } : {}),
    };
    this.records.set(flowId, updated);
    return updated;
  }

  public listBySession(sessionBinding: string): ProviderAuthFlowRecord[] {
    return [...this.records.values()].filter((record) => record.sessionBinding === sessionBinding);
  }

  public delete(flowId: string): boolean {
    return this.records.delete(flowId);
  }
}

/** Секретные артефакты потока, хранимые отдельно от несекретного состояния. */
export interface AuthFlowSecrets {
  /** device_code OAuth Device Flow (не bearer-токен, но grant-артефакт). */
  readonly deviceCode?: string;
  /** PKCE verifier. */
  readonly verifier?: string;
  /** PKCE challenge (need для верификации на этапе обмена). */
  readonly challenge?: string;
  /** OAuth state / nonce (one-use). */
  readonly state?: string;
}

/**
 * Хранилище секретных артефактов потоков.
 * Записи ограничены по составу, обнуляются после использования и никогда не
 * попадают в публичные проекции.
 */
export class AuthFlowSecretVault {
  private readonly secrets = new Map<string, AuthFlowSecrets>();

  public set(flowId: string, secrets: AuthFlowSecrets): void {
    this.secrets.set(flowId, { ...secrets });
  }

  public get(flowId: string): AuthFlowSecrets | undefined {
    return this.secrets.get(flowId);
  }

  /** Извлекает запись (one-use): возвращает копию, затем обнуляет и удаляет оригинал. */
  public take(flowId: string): AuthFlowSecrets | undefined {
    const entry = this.secrets.get(flowId);
    if (!entry) return undefined;
    const copy: AuthFlowSecrets = { ...entry };
    this.zero(entry);
    this.secrets.delete(flowId);
    return copy;
  }

  /** Обнуляет секретные значения записи без удаления самой записи. */
  public zero(entry: AuthFlowSecrets): void {
    for (const key of ["deviceCode", "verifier", "challenge", "state"] as const) {
      const value = entry[key];
      if (typeof value === "string" && value.length > 0) {
        (entry as Record<string, string>)[key] = "";
      }
    }
  }

  /** Обнуляет секреты конкретного потока (без удаления записи состояния). */
  public zeroFor(flowId: string): void {
    const entry = this.secrets.get(flowId);
    if (entry) this.zero(entry);
  }

  public delete(flowId: string): boolean {
    const entry = this.secrets.get(flowId);
    if (entry) this.zero(entry);
    return this.secrets.delete(flowId);
  }
}

/** True, если срок действия потока истёк на момент `now`. */
export function isFlowExpired(record: ProviderAuthFlowRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}

/** True, если поток находится в терминальном статусе. */
export function isTerminalFlowStatus(status: ProviderAuthFlowStatus): boolean {
  return status === "COMPLETE" || status === "EXPIRED" || status === "DENIED" || status === "FAILED" || status === "CANCELLED";
}
