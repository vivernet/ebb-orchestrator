import { timingSafeEqual } from "node:crypto";
import { AUTH_ABSOLUTE_TTL_SECONDS, AUTH_IDLE_TTL_SECONDS, AUTH_TOKEN_BYTES } from "@ebb-orchestrator/contracts";
import type { Database } from "../database/database.js";
import type {
  DigestPort,
  PasswordHasher,
  RandomTokenPort,
  RawSecretBytes,
  UtcTimestamp,
} from "./auth-ports.js";
/** Единственная локальная учётная запись сервера; сохраняются только PHC-хэш и закреплённые параметры. */
export interface LocalUserRecord {
  id: 1;
  passwordHash: string;
  hashAlgorithm: "argon2id";
  hashParametersJson: string;
}
/** Проекция серверной сессии с неактивным и абсолютным сроками истечения. */
export interface AuthSessionRecord {
  id: string;
  absoluteExpiresAt: UtcTimestamp;
  idleExpiresAt: UtcTimestamp;
}
/** Сырые значения, которые репозиторий возвращает только после выпуска или ротации. */
export interface IssuedSession {
  session: AuthSessionRecord;
  rawSessionToken: RawSecretBytes;
  rawCsrfToken: RawSecretBytes;
}
/** Новый сырой CSRF-токен после проверенной в транзакции ротации. */
export interface RotatedCsrf {
  session: AuthSessionRecord;
  rawCsrfToken: RawSecretBytes;
}
/** Результат условного отзыва активной сессии. */
export type RevokeResult = "REVOKED" | "ALREADY_REVOKED";
/** Набор наблюдаемых результатов выхода; ошибки хранилища передаются как отклонённый промис. */
export type LogoutResult = "REVOKED" | "INVALID_SESSION" | "CSRF_INVALID";
/**
 * Серверный порт постоянного хранения данных аутентификации.
 * Все проверки и изменения состояния выполняются в одной транзакции, а сырые
 * секреты не удерживаются после завершения вызова.
 */
export interface AuthRepository {
  /** Проверяет наличие единственной локальной учётной записи без выдачи её секрета. */
  hasLocalUser(): Promise<boolean>;
  /** Хэширует пароль и атомарно сохраняет единственную локальную учётную запись. */
  createLocalUser(password: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<void>;
  /** Возвращает закреплённые параметры локальной учётной записи и её PHC-хэш. */
  findLocalUser(): Promise<LocalUserRecord | null>;
  /** Выпускает сессию и возвращает сырые токены только вызывающему коду. */
  issueSession(now: UtcTimestamp): Promise<IssuedSession>;
  /** Атомарно проверяет активную сессию и продлевает только её неактивный срок. */
  authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<AuthSessionRecord | null>;
  /** В одной `BEGIN IMMEDIATE` транзакции классифицирует сессию, проверяет текущий CSRF и условно продлевает idle TTL; сырые секреты не сохраняются. */
  authenticateCsrfAndTouch(rawSessionToken: Readonly<RawSecretBytes>, rawCsrfToken: Readonly<RawSecretBytes> | null, now: UtcTimestamp): Promise<AuthSessionRecord | "INVALID_SESSION" | "CSRF_INVALID">;
  /** Атомарно проверяет активную сессию и заменяет её CSRF-токен. */
  authenticateAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RotatedCsrf | null>;
  /** Условно отзывает сессию по токену и сообщает, была ли она отозвана ранее. */
  revokeByToken(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RevokeResult>;
  /** Сначала классифицирует сессию, затем проверяет CSRF и отзывает её без побочных изменений при отказе. */
  logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null, now: UtcTimestamp): Promise<LogoutResult>;

  /** Отзывает истёкшие сессии условным запросом, безопасным при повторном запуске. */
  revokeExpired(now: UtcTimestamp): Promise<number>;
}
/** Контракт конструктора конкретного адаптера SQLite. */
export type AuthRepositoryConstructor = new (
  database: Database,
  passwordHasher: PasswordHasher,
  randomTokenPort: RandomTokenPort,
  digestPort: DigestPort,
) => AuthRepository;
/** Контракт фабрики для корневой сборки приложения. */
export type CreateAuthRepository = (
  database: Database,
  passwordHasher: PasswordHasher,
  randomTokenPort: RandomTokenPort,
  digestPort: DigestPort,
) => AuthRepository;

const HASH_ALGORITHM = "argon2id" as const;
const HASH_PARAMETERS_JSON = JSON.stringify({
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  saltLength: 16,
});
const LOCKED_PHC = /^\$argon2id\$v=19\$m=65536,p=4,t=3\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

type UserRow = {
  id: number;
  password_hash: string;
  hash_algorithm: string;
  hash_parameters_json: string;
};

type SessionRow = {
  id: string;
  created_at: UtcTimestamp;
  last_seen_at: UtcTimestamp;
  idle_expires_at: UtcTimestamp;
  absolute_expires_at: UtcTimestamp;
  revoked_at: UtcTimestamp | null;
  csrf_token_hash?: string;
};

function addSeconds(timestamp: UtcTimestamp, seconds: number): UtcTimestamp {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error("Invalid UTC timestamp");
  return new Date(value + seconds * 1000).toISOString();
}

function isExactPhc(encoded: string): boolean {
  const match = LOCKED_PHC.exec(encoded);
  if (!match) return false;
  const salt = match[1];
  const digest = match[2];
  if (salt === undefined || digest === undefined) return false;
  const decodedLength = (value: string) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.toString("base64").replace(/=+$/, "") === value;
  };
  return decodedLength(salt) && Buffer.from(salt, "base64").length === 16
    && decodedLength(digest) && Buffer.from(digest, "base64").length === 32;
}

function equalSha256Hex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function toSession(row: SessionRow): AuthSessionRecord {
  return {
    id: row.id,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

function toLocalUser(row: UserRow): LocalUserRecord {
  if (row.id !== 1 || row.hash_algorithm !== HASH_ALGORITHM || row.hash_parameters_json !== HASH_PARAMETERS_JSON) {
    throw new Error("Invalid persisted local user hash metadata");
  }
  return {
    id: 1,
    passwordHash: row.password_hash,
    hashAlgorithm: HASH_ALGORITHM,
    hashParametersJson: row.hash_parameters_json,
  };
}

/**
 * Постоянный SQLite-репозиторий единственной локальной учётной записи и
 * непрозрачных сессий.
 *
 * Все проверки и изменения состояния выполняются в одной транзакции
 * `BEGIN IMMEDIATE`. Репозиторий получает только переданные сервером
 * криптографические порты, не сохраняет сырые секреты и не знает о внешнем
 * хранилище секретов.
 */
export class SqliteAuthRepository implements AuthRepository {
  /** Принимает только явно переданные порты; репозиторий не создаёт скрытые криптографические зависимости. */
  public constructor(
    private readonly database: Database,
    private readonly passwordHasher: PasswordHasher,
    private readonly randomTokenPort: RandomTokenPort,
    private readonly digestPort: DigestPort,
  ) {}

  /** Возвращает наличие единственной локальной учётной записи без выдачи её хэша. */
  async hasLocalUser(): Promise<boolean> {
    return this.database.get<{ id: number }>("SELECT id FROM local_users WHERE id = 1") !== undefined;
  }

  /** Хэширует пароль вне SQL-транзакции и атомарно создаёт единственную строку; повторная запись отклоняется ограничением схемы. */
  async createLocalUser(password: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<void> {
    const encoded = await this.passwordHasher.hash(password);
    if (!isExactPhc(encoded)) throw new Error("Password hasher returned unsupported PHC value");
    this.database.transaction((tx) => {
      tx.run(
        `INSERT INTO local_users (id, password_hash, hash_algorithm, hash_parameters_json, created_at, updated_at)
         VALUES ($id, $passwordHash, $hashAlgorithm, $hashParametersJson, $createdAt, $updatedAt)`,
        {
          id: 1,
          passwordHash: encoded,
          hashAlgorithm: HASH_ALGORITHM,
          hashParametersJson: HASH_PARAMETERS_JSON,
          createdAt: now,
          updatedAt: now,
        },
      );
    });
  }

  /** Читает только закреплённые параметры и PHC-хэш, не возвращая сырой пароль. */
  async findLocalUser(): Promise<LocalUserRecord | null> {
    const row = this.database.get<UserRow>(
      "SELECT id, password_hash, hash_algorithm, hash_parameters_json FROM local_users WHERE id = 1",
    );
    return row ? toLocalUser(row) : null;
  }

  /** Выпускает два временных сырых токена ровно по 32 байта и сохраняет только их дайджесты. */
  async issueSession(now: UtcTimestamp): Promise<IssuedSession> {
    let rawSessionToken: RawSecretBytes | undefined;
    let rawCsrfToken: RawSecretBytes | undefined;
    let transferred = false;
    try {
      rawSessionToken = this.randomTokenPort.randomBytes(AUTH_TOKEN_BYTES);
      rawCsrfToken = this.randomTokenPort.randomBytes(AUTH_TOKEN_BYTES);
      const tokenHash = this.digestPort.sha256Hex(rawSessionToken);
      const csrfTokenHash = this.digestPort.sha256Hex(rawCsrfToken);
      const idleExpiresAt = addSeconds(now, AUTH_IDLE_TTL_SECONDS);
      const absoluteExpiresAt = addSeconds(now, AUTH_ABSOLUTE_TTL_SECONDS);
      const row = this.database.transaction((tx) => tx.get<SessionRow>(
        `INSERT INTO auth_sessions
           (id, token_hash, csrf_token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at)
         VALUES ($id, $tokenHash, $csrfTokenHash, $now, $now, $idleExpiresAt, $absoluteExpiresAt, NULL)
         RETURNING id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at`,
        {
          id: tokenHash,
          tokenHash,
          csrfTokenHash,
          now,
          idleExpiresAt,
          absoluteExpiresAt,
        },
      ));
      if (!row) throw new Error("Session issuance returned no row");
      transferred = true;
      return { session: toSession(row), rawSessionToken, rawCsrfToken };
    } finally {
      if (!transferred) {
        rawSessionToken?.fill(0);
        rawCsrfToken?.fill(0);
      }
    }
  }

  /** Одним условным UPDATE проверяет срок и обновляет только ещё активную сессию. */
  async authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<AuthSessionRecord | null> {
    const tokenHash = this.digestPort.sha256Hex(rawSessionToken);
    const idleExpiresAt = addSeconds(now, AUTH_IDLE_TTL_SECONDS);
    const row = this.database.transaction((tx) => tx.get<SessionRow>(
      `UPDATE auth_sessions
          SET last_seen_at = $now, idle_expires_at = $idleExpiresAt
        WHERE token_hash = $tokenHash
          AND revoked_at IS NULL
          AND $now < idle_expires_at
          AND $now < absolute_expires_at
        RETURNING id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at`,
      { tokenHash, now, idleExpiresAt },
    ));
    return row ? toSession(row) : null;
  }

  /**
   * Атомарно авторизует mutation: сначала классифицирует сессию, затем только
   * для активной строки сверяет CSRF и выполняет единственный условный touch.
   * Неверный CSRF не меняет строку; после ротации старый CSRF не может touch-ить
   * новую строку, поскольку проверка и UPDATE принадлежат одной транзакции.
   */
  async authenticateCsrfAndTouch(
    rawSessionToken: Readonly<RawSecretBytes>,
    rawCsrfToken: Readonly<RawSecretBytes> | null,
    now: UtcTimestamp,
  ): Promise<AuthSessionRecord | "INVALID_SESSION" | "CSRF_INVALID"> {
    if (rawSessionToken.length !== AUTH_TOKEN_BYTES) return "INVALID_SESSION";
    const tokenHash = this.digestPort.sha256Hex(rawSessionToken);
    return this.database.transaction((tx) => {
      const current = tx.get<SessionRow>(
        `SELECT id, csrf_token_hash, idle_expires_at, absolute_expires_at, revoked_at
           FROM auth_sessions WHERE token_hash = $tokenHash`,
        { tokenHash },
      );
      if (!current || current.revoked_at !== null || now >= current.idle_expires_at || now >= current.absolute_expires_at) {
        return "INVALID_SESSION";
      }
      if (!rawCsrfToken || rawCsrfToken.length !== AUTH_TOKEN_BYTES) return "CSRF_INVALID";
      const csrfTokenHash = this.digestPort.sha256Hex(rawCsrfToken);
      if (current.csrf_token_hash === undefined || !equalSha256Hex(current.csrf_token_hash, csrfTokenHash)) return "CSRF_INVALID";
      const idleExpiresAt = addSeconds(now, AUTH_IDLE_TTL_SECONDS);
      const touched = tx.get<SessionRow>(
        `UPDATE auth_sessions
            SET last_seen_at = $now, idle_expires_at = $idleExpiresAt
          WHERE id = $id
            AND csrf_token_hash = $csrfTokenHash
            AND revoked_at IS NULL
            AND $now < idle_expires_at
            AND $now < absolute_expires_at
          RETURNING id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at`,
        { id: current.id, csrfTokenHash, now, idleExpiresAt },
      );
      return touched ? toSession(touched) : "INVALID_SESSION";
    });
  }

  /** Проверяет сессию и обновляет CSRF-дайджест в одной блокирующей транзакции; после фиксации старый дайджест недействителен. */
  async authenticateAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RotatedCsrf | null> {
    let rawCsrfToken: RawSecretBytes | undefined;
    let transferred = false;
    try {
      const tokenHash = this.digestPort.sha256Hex(rawSessionToken);
      const result = this.database.transaction((tx) => {
        const current = tx.get<SessionRow>(
          `SELECT id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
             FROM auth_sessions
            WHERE token_hash = $tokenHash
              AND revoked_at IS NULL
              AND $now < idle_expires_at
              AND $now < absolute_expires_at`,
          { tokenHash, now },
        );
        if (!current) return null;
        rawCsrfToken = this.randomTokenPort.randomBytes(AUTH_TOKEN_BYTES);
        const csrfTokenHash = this.digestPort.sha256Hex(rawCsrfToken);
        const idleExpiresAt = addSeconds(now, AUTH_IDLE_TTL_SECONDS);
        const updated = tx.get<SessionRow>(
          `UPDATE auth_sessions
              SET csrf_token_hash = $csrfTokenHash, last_seen_at = $now, idle_expires_at = $idleExpiresAt
            WHERE id = $id
              AND revoked_at IS NULL
              AND $now < idle_expires_at
              AND $now < absolute_expires_at
            RETURNING id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at`,
          { id: current.id, csrfTokenHash, now, idleExpiresAt },
        );
        return updated ? { session: toSession(updated), rawCsrfToken } : null;
      });
      if (result) transferred = true;
      return result;
    } finally {
      if (!transferred) rawCsrfToken?.fill(0);
    }
  }

  /** Условно отзывает токен; повторный отзыв возвращает `ALREADY_REVOKED` без изменения времени. */
  async revokeByToken(rawSessionToken: Readonly<RawSecretBytes>, now: UtcTimestamp): Promise<RevokeResult> {
    const tokenHash = this.digestPort.sha256Hex(rawSessionToken);
    return this.database.transaction((tx) => {
      const revoked = tx.get<{ id: string }>(
        `UPDATE auth_sessions SET revoked_at = $now
          WHERE token_hash = $tokenHash AND revoked_at IS NULL
          RETURNING id`,
        { tokenHash, now },
      );
      return revoked ? "REVOKED" : "ALREADY_REVOKED";
    });
  }

  /** Проверяет активную сессию и CSRF-дайджест, затем отзывает именно эту строку без изменений при отказе. */
  async logout(
    rawSessionToken: Readonly<RawSecretBytes> | null,
    rawCsrfToken: Readonly<RawSecretBytes> | null,
    now: UtcTimestamp,
  ): Promise<LogoutResult> {
    if (!rawSessionToken || rawSessionToken.length !== AUTH_TOKEN_BYTES) return "INVALID_SESSION";
    const tokenHash = this.digestPort.sha256Hex(rawSessionToken);
    return this.database.transaction((tx) => {
      const current = tx.get<SessionRow>(
        `SELECT id, csrf_token_hash, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
           FROM auth_sessions
          WHERE token_hash = $tokenHash`,
        { tokenHash },
      );
      if (!current || current.revoked_at !== null || now >= current.idle_expires_at || now >= current.absolute_expires_at) {
        return "INVALID_SESSION";
      }
      if (!rawCsrfToken || rawCsrfToken.length !== AUTH_TOKEN_BYTES) return "CSRF_INVALID";
      const csrfTokenHash = this.digestPort.sha256Hex(rawCsrfToken);
      if (current.csrf_token_hash === undefined || !equalSha256Hex(current.csrf_token_hash, csrfTokenHash)) return "CSRF_INVALID";
      const revoked = tx.get<{ id: string }>(
        `UPDATE auth_sessions SET revoked_at = $now
          WHERE id = $id AND revoked_at IS NULL
          RETURNING id`,
        { id: current.id, now },
      );
      return revoked ? "REVOKED" : "INVALID_SESSION";
    });
  }


  /** Помечает истёкшие строки отозванными, не трогает действующие и безопасен при повторном запуске. */
  async revokeExpired(now: UtcTimestamp): Promise<number> {
    return this.database.transaction((tx) => tx.all<{ id: string }>(
      `UPDATE auth_sessions SET revoked_at = $now
        WHERE revoked_at IS NULL AND ($now >= idle_expires_at OR $now >= absolute_expires_at)
        RETURNING id`,
      { now },
    ).length);
  }
}

/** Создаёт единственный SQLite-адаптер аутентификации из явно переданных серверных портов. */
export function createAuthRepository(
  database: Database,
  passwordHasher: PasswordHasher,
  randomTokenPort: RandomTokenPort,
  digestPort: DigestPort,
): AuthRepository {
  return new SqliteAuthRepository(database, passwordHasher, randomTokenPort, digestPort);
}

/** Повторно экспортирует тип буфера сырых секретных байтов для потребителей репозитория. */
export type { RawSecretBytes } from "./auth-ports.js";
