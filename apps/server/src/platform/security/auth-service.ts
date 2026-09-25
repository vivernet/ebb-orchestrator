import { AUTH_CONTRACT_VERSION, type LoginResponseDto, type SessionResponseDto } from "@ebb-orchestrator/contracts";
import type { AuthClock, AuthPortErrorCode, PasswordHasher, RawSecretBytes } from "./auth-ports.js";
import type { AuthRepository, AuthSessionRecord, IssuedSession, RotatedCsrf } from "./auth-repository.js";

/**
 * AuthService — единственная application boundary для локальной auth.
 * Он не открывает транзакции, не создаёт crypto ports и не удерживает raw secrets:
 * атомарная проверка, touch, rotation и revoke остаются ответственностью repository.
 */
export interface AuthService {
  /** Проверяет пароль и выпускает сессию; наружу возвращается только DTO и raw токены для немедленной передачи boundary. */
  login(password: Readonly<RawSecretBytes>): Promise<
    { ok: true; value: IssuedSession & { response: LoginResponseDto } } |
    { ok: false; code: AuthPortErrorCode }
  >;
  /** Проверяет активную сессию и ротирует CSRF в одной repository-транзакции после успешной авторизации. */
  restoreAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>): Promise<
    { ok: true; value: RotatedCsrf & { response: SessionResponseDto } } |
    { ok: false; code: AuthPortErrorCode }
  >;
  /** Без CSRF-проверки атомарно продлевает idle TTL; предназначен только для безопасного восстановления GET-состояния. */
  authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>): Promise<
    { ok: true; value: AuthSessionRecord } |
    { ok: false; code: AuthPortErrorCode }
  >;
  /** Единственная authorized-mutation seam: repository за один BEGIN IMMEDIATE классифицирует сессию, сверяет CSRF и условно touch-ит её. */
  authenticateCsrfAndTouch(rawSessionToken: Readonly<RawSecretBytes>, rawCsrfToken: Readonly<RawSecretBytes> | null): Promise<
    { ok: true; value: AuthSessionRecord } |
    { ok: false; code: "SESSION_INVALID" | "CSRF_INVALID" | "UNAVAILABLE" }
  >;
  /** Классифицирует сессию и CSRF с требуемым precedence, затем отзывает строку без побочных изменений при отказе. */
  logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null): Promise<
    { ok: true; value: "REVOKED" | "IDEMPOTENT_INVALID_SESSION" } |
    { ok: false; code: "CSRF_INVALID" | "UNAVAILABLE" }
  >;
  /** Возвращает только факт наличия singleton user для startup/onboarding boundary. */
  hasLocalUser(): Promise<boolean>;
}

/** Реализация auth application service поверх явно переданных repository, hasher и clock. */
export class LocalAuthService implements AuthService {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly clock: AuthClock,
  ) {}

  /** Проверяет singleton user и выпускает durable session; отсутствие user не раскрывается наружу. */
  public async login(password: Readonly<RawSecretBytes>): Promise<Awaited<ReturnType<AuthService["login"]>>> {
    let issued: IssuedSession | undefined;
    let transferred = false;
    try {
      const user = await this.repository.findLocalUser();
      if (!user || !(await this.passwordHasher.verify(user.passwordHash, password))) return { ok: false, code: "INVALID_CREDENTIALS" };
      issued = await this.repository.issueSession(this.clock.now());
      const response = { contractVersion: AUTH_CONTRACT_VERSION, csrfToken: encodeToken(issued.rawCsrfToken), expiresAt: issued.session.absoluteExpiresAt };
      transferred = true;
      return { ok: true, value: { ...issued, response } };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    } finally {
      if (!transferred) {
        issued?.rawSessionToken.fill(0);
        issued?.rawCsrfToken.fill(0);
      }
    }
  }

  /** Атомарно проверяет cookie, обновляет idle TTL и ротирует CSRF после commit repository. */
  public async restoreAndRotateCsrf(rawSessionToken: Readonly<RawSecretBytes>): Promise<Awaited<ReturnType<AuthService["restoreAndRotateCsrf"]>>> {
    let rotated: RotatedCsrf | null = null;
    let transferred = false;
    try {
      rotated = await this.repository.authenticateAndRotateCsrf(rawSessionToken, this.clock.now());
      if (!rotated) return { ok: false, code: "SESSION_INVALID" };
      const response = { contractVersion: AUTH_CONTRACT_VERSION, authenticated: true as const, csrfToken: encodeToken(rotated.rawCsrfToken), expiresAt: rotated.session.absoluteExpiresAt };
      transferred = true;
      return { ok: true, value: { ...rotated, response } };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    } finally {
      if (!transferred) rotated?.rawCsrfToken.fill(0);
    }
  }

  /** Атомарно touch-ит только активную сессию для защищённых запросов. */
  public async authenticateAndTouch(rawSessionToken: Readonly<RawSecretBytes>): Promise<Awaited<ReturnType<AuthService["authenticateAndTouch"]>>> {
    try {
      const session = await this.repository.authenticateAndTouch(rawSessionToken, this.clock.now());
      return session ? { ok: true, value: session } : { ok: false, code: "SESSION_INVALID" };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  }

  /** Делегирует единственную logout classification repository и сохраняет её precedence. */
  public async logout(rawSessionToken: Readonly<RawSecretBytes> | null, rawCsrfToken: Readonly<RawSecretBytes> | null): Promise<Awaited<ReturnType<AuthService["logout"]>>> {
    try {
      const result = await this.repository.logout(rawSessionToken, rawCsrfToken, this.clock.now());
      if (result === "CSRF_INVALID") return { ok: false, code: "CSRF_INVALID" };
      return { ok: true, value: result === "REVOKED" ? "REVOKED" : "IDEMPOTENT_INVALID_SESSION" };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  }

  /** Возвращает только факт существования singleton user для startup wizard. */
  public hasLocalUser(): Promise<boolean> { return this.repository.hasLocalUser(); }

  /** Делегирует ровно одну атомарную repository-операцию для authorized mutation без локальной транзакции или crypto state. */
  public async authenticateCsrfAndTouch(rawSessionToken: Readonly<RawSecretBytes>, rawCsrfToken: Readonly<RawSecretBytes> | null): Promise<{ ok: true; value: AuthSessionRecord } | { ok: false; code: "SESSION_INVALID" | "CSRF_INVALID" | "UNAVAILABLE" }> {
    try {
      const result = await this.repository.authenticateCsrfAndTouch(rawSessionToken, rawCsrfToken, this.clock.now());
      return typeof result === "string" ? { ok: false, code: result === "INVALID_SESSION" ? "SESSION_INVALID" : "CSRF_INVALID" } : { ok: true, value: result };
    } catch {
      return { ok: false, code: "UNAVAILABLE" };
    }
  }
}

/** Создаёт LocalAuthService без скрытых random/digest зависимостей. */
export function createAuthService(repository: AuthRepository, passwordHasher: PasswordHasher, clock: AuthClock): AuthService {
  return new LocalAuthService(repository, passwordHasher, clock);
}

/** Типизированная constructor seam, зафиксированная контрактом 15-01. */
export type AuthServiceConstructor = new (repository: AuthRepository, passwordHasher: PasswordHasher, clock: AuthClock) => AuthService;
/** Типизированная factory seam, зафиксированная контрактом 15-01. */
export type CreateAuthService = typeof createAuthService;

function encodeToken(raw: Readonly<RawSecretBytes>): string { return Buffer.from(raw).toString("base64url"); }
