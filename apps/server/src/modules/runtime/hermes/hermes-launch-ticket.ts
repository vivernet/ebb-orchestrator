import path from "node:path";
import { createHash } from "node:crypto";

const ticketBrand: unique symbol = Symbol("HermesLaunchTicket");

export type HermesLaunchObjectIdentity =
  | { readonly platform: "win32"; readonly volumeSerial: string; readonly fileId: string }
  | { readonly platform: "linux"; readonly device: string; readonly inode: string };

export interface HermesLaunchTicketInput {
  readonly runId: string;
  readonly attempt: number | null;
  readonly platform: "win32" | "linux";
  /** Pinned Hermes entrypoint whose launcher and source layout were resolved. */
  readonly hermesExecutablePath: string;
  readonly hermesExecutableIdentity: HermesLaunchObjectIdentity;
  /** Actual OS image created by the supervisor; Python for the pinned distlib/hermes shim. */
  readonly executablePath: string;
  readonly executableIdentity: HermesLaunchObjectIdentity;
  /** Exact trusted interpreter prefix (`-I -B -S -c <snapshot-only Hermes bootstrap>`). */
  readonly executableArgsPrefix: readonly string[];
  readonly profileHome: string;
  readonly profileHomeIdentity: HermesLaunchObjectIdentity;
  /** Exact canonical JCS identity persisted on this Run's process owner. */
  readonly hermesSourceSnapshotKey: string;
  /** Read-only source tree root plus the native directory identity captured immediately before ticket creation. */
  readonly hermesSourceSnapshotRoot: string;
  readonly hermesSourceSnapshotRootIdentity: HermesLaunchObjectIdentity;
  readonly hermesSourceManifestDigest: string;
  /** Adjacent bounded v1 metadata projection, pinned by exact path, digest, and byte length. */
  readonly hermesSourceProjectionPath: string;
  readonly hermesSourceProjectionSha256: string;
  readonly hermesSourceProjectionSize: number;
  readonly environment: {
    readonly HERMES_HOME: string;
    readonly HOME: string;
    readonly HERMES_CONFIG: string;
  };
}

export interface HermesLaunchTicketFactoryInput {
  readonly runId: string;
  readonly attempt: number | null;
  readonly cwd: string;
  readonly profileHome: string;
  readonly environment: {
    readonly HERMES_HOME: string;
    readonly HOME: string;
    readonly HERMES_CONFIG: string;
  };
}

export interface PreparedHermesLaunch {
  readonly executablePath: string;
  readonly argsPrefix: readonly string[];
  readonly ticket: HermesLaunchTicket;
}

export type HermesLaunchTicketFactory = (input: HermesLaunchTicketFactoryInput) => Promise<PreparedHermesLaunch>;

/** Opaque одноразовое разрешение на Hermes launch для точной попытки Run. */
export interface HermesLaunchTicket {
  readonly [ticketBrand]: true;
}

export interface HermesLaunchTicketRequest {
  readonly runId: string;
  readonly attempt: number | null;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

interface TicketState extends HermesLaunchTicketInput {
  consumed: boolean;
}

const ticketStates = new WeakMap<HermesLaunchTicket, TicketState>();

/**
 * Создаёт непрозрачный ticket, связывающий executable, profile identity и три Hermes path-env
 * значения с одной попыткой Run. Сам ticket нельзя сериализовать/восстановить после рестарта.
 *
 * @param input Проверенные абсолютные пути и native file/directory identities.
 * @returns Opaque ticket, который следующий launch boundary обязан потребить ровно один раз.
 * @throws {Error} Если путь, identity или обязательная environment binding неполны.
 */
export function createHermesLaunchTicket(input: HermesLaunchTicketInput): HermesLaunchTicket {
  assertTicketInput(input);
  const ticket = Object.freeze(Object.create(null)) as HermesLaunchTicket;
  ticketStates.set(ticket, { ...input, environment: Object.freeze({ ...input.environment }), consumed: false });
  return ticket;
}

/**
 * Проверяет Run/attempt, exact executable и Hermes path environment на последней TS-границе,
 * затем делает ticket одноразовым и выдаёт native identity для ОС-specific supervisor.
 *
 * @param ticket Opaque ticket от текущего RuntimeAdapter либо `undefined` для проверки отказа.
 * @param request Фактический launch request перед передачей OS supervisor.
 * @returns Копию ticket identity, которую supervisor передаёт своему проверенному native launcher.
 * @throws {Error} При отсутствующем, подменённом, неверно привязанном или повторном ticket.
 */
export function consumeHermesLaunchTicket(
  ticket: HermesLaunchTicket | undefined,
  request: HermesLaunchTicketRequest,
): HermesLaunchTicketInput {
  if (!ticket) throw new Error("HERMES_LAUNCH_TICKET_REQUIRED");
  const state = ticketStates.get(ticket);
  if (!state) throw new Error("HERMES_LAUNCH_TICKET_INVALID");
  if (state.consumed) throw new Error("HERMES_LAUNCH_TICKET_REUSED");
  state.consumed = true;
  if (state.runId !== request.runId || state.attempt !== request.attempt ||
      !samePath(state.executablePath, request.executable, state.platform) ||
      !hasExactPrefix(request.args, state.executableArgsPrefix) ||
      request.environment.HERMES_HOME !== state.environment.HERMES_HOME ||
      request.environment.HOME !== state.environment.HOME ||
      request.environment.HERMES_CONFIG !== state.environment.HERMES_CONFIG) {
    throw new Error("HERMES_LAUNCH_TICKET_MISMATCH");
  }
  return Object.freeze({
    runId: state.runId,
    attempt: state.attempt,
    platform: state.platform,
    hermesExecutablePath: state.hermesExecutablePath,
    hermesExecutableIdentity: Object.freeze({ ...state.hermesExecutableIdentity }),
    executablePath: state.executablePath,
    executableIdentity: Object.freeze({ ...state.executableIdentity }),
    executableArgsPrefix: Object.freeze([...state.executableArgsPrefix]),
    profileHome: state.profileHome,
    profileHomeIdentity: Object.freeze({ ...state.profileHomeIdentity }),
    hermesSourceSnapshotKey: state.hermesSourceSnapshotKey,
    hermesSourceSnapshotRoot: state.hermesSourceSnapshotRoot,
    hermesSourceSnapshotRootIdentity: Object.freeze({ ...state.hermesSourceSnapshotRootIdentity }),
    hermesSourceManifestDigest: state.hermesSourceManifestDigest,
    hermesSourceProjectionPath: state.hermesSourceProjectionPath,
    hermesSourceProjectionSha256: state.hermesSourceProjectionSha256,
    hermesSourceProjectionSize: state.hermesSourceProjectionSize,
    environment: state.environment,
  });
}

function assertTicketInput(input: HermesLaunchTicketInput): void {
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (!input.runId || (input.attempt !== null && (!Number.isSafeInteger(input.attempt) || input.attempt < 0)) ||
      (input.platform !== "win32" && input.platform !== "linux") ||
      !paths.isAbsolute(input.hermesExecutablePath) || !paths.isAbsolute(input.executablePath) ||
      !paths.isAbsolute(input.profileHome) ||
      !paths.isAbsolute(input.hermesSourceSnapshotRoot) || !paths.isAbsolute(input.hermesSourceProjectionPath) ||
      !["hermes", "hermes.exe"].includes(paths.basename(input.hermesExecutablePath).toLocaleLowerCase("en-US")) ||
      input.hermesExecutableIdentity.platform !== input.platform || input.executableIdentity.platform !== input.platform ||
      input.profileHomeIdentity.platform !== input.platform || input.hermesSourceSnapshotRootIdentity.platform !== input.platform ||
      input.executableArgsPrefix.length !== 5 || input.executableArgsPrefix[0] !== "-I" ||
      input.executableArgsPrefix[1] !== "-B" || input.executableArgsPrefix[2] !== "-S" ||
      input.executableArgsPrefix[3] !== "-c" ||
      !isCanonicalSnapshotTicketBinding(input) ||
      !/^[a-f0-9]{64}$/u.test(input.hermesSourceManifestDigest) ||
      !/^[a-f0-9]{64}$/u.test(input.hermesSourceProjectionSha256) ||
      !Number.isSafeInteger(input.hermesSourceProjectionSize) || input.hermesSourceProjectionSize <= 0 ||
      input.hermesSourceProjectionSize > 64 * 1024 * 1024 ||
      input.environment.HERMES_HOME !== input.profileHome ||
      !paths.isAbsolute(input.environment.HOME) || !paths.isAbsolute(input.environment.HERMES_CONFIG) ||
      !isValidObjectIdentity(input.hermesExecutableIdentity) || !isValidObjectIdentity(input.executableIdentity) ||
      !isValidObjectIdentity(input.profileHomeIdentity) ||
      !isValidObjectIdentity(input.hermesSourceSnapshotRootIdentity) ||
      input.executableArgsPrefix.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  }
}

function isCanonicalSnapshotTicketBinding(input: HermesLaunchTicketInput): boolean {
  const key = input.hermesSourceSnapshotKey;
  if (typeof key !== "string" || key.length > 4096) return false;
  try {
    const parsed = JSON.parse(key) as Record<string, unknown>;
    const { formatVersion, hermesVersion, manifestDigest: keyDigest, sourceCommit, sourceTree } = parsed;
    return Object.keys(parsed).length === 5 && formatVersion === 1 &&
      typeof hermesVersion === "string" && hermesVersion.length > 0 && hermesVersion.length <= 256 &&
      typeof keyDigest === "string" && /^[a-f0-9]{64}$/u.test(keyDigest) && keyDigest === input.hermesSourceManifestDigest &&
      typeof sourceCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceCommit) &&
      typeof sourceTree === "string" && sourceTree.length === sourceCommit.length &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceTree) &&
      key === JSON.stringify({ formatVersion, hermesVersion, manifestDigest: keyDigest, sourceCommit, sourceTree }) &&
      snapshotPathsMatch(input, createHash("sha256").update(key, "utf8").digest("hex"));
  } catch {
    return false;
  }
}

function snapshotPathsMatch(input: HermesLaunchTicketInput, directoryId: string): boolean {
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (paths.basename(input.hermesSourceSnapshotRoot) !== directoryId) return false;
  const expectedProjection = paths.join(paths.dirname(input.hermesSourceSnapshotRoot), `${directoryId}.native-v1.bin`);
  return samePath(expectedProjection, input.hermesSourceProjectionPath, input.platform);
}

function hasExactPrefix(args: readonly string[], prefix: readonly string[]): boolean {
  return args.length >= prefix.length && prefix.every((value, index) => args[index] === value);
}

function isValidObjectIdentity(identity: HermesLaunchObjectIdentity): boolean {
  return identity.platform === "win32"
    ? /^[a-f0-9]{16}$/iu.test(identity.volumeSerial) && /^[a-f0-9]{32}$/iu.test(identity.fileId)
    : /^(0|[1-9][0-9]*)$/u.test(identity.device) && /^(0|[1-9][0-9]*)$/u.test(identity.inode);
}

function samePath(left: string, right: string, platform: "win32" | "linux"): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalizedLeft = paths.normalize(left);
  const normalizedRight = paths.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}
