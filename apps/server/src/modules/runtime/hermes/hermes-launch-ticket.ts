import path from "node:path";
import { createHash } from "node:crypto";

const ticketBrand: unique symbol = Symbol("HermesLaunchTicket");

export type HermesLaunchObjectIdentity =
  | { readonly platform: "win32"; readonly volumeSerial: string; readonly fileId: string }
  | { readonly platform: "linux"; readonly device: string; readonly inode: string };

export interface HermesWindowsPathComponentIdentity {
  readonly volumeSerial: string;
  readonly fileId: string;
}

export interface HermesWindowsPathIdentityChain {
  readonly version: 1;
  /** Индекс auth-root в `components`; volume root всегда занимает индекс 0. */
  readonly authRootIndex: number;
  /** Идентичности каталогов в lexical-порядке от volume root до Run profile включительно. */
  readonly components: readonly HermesWindowsPathComponentIdentity[];
}

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
  /** Native no-follow identities for the Run's `home` directory and `config.yaml` file on Windows. */
  readonly profileHomeTargetIdentities?: {
    readonly home: HermesLaunchObjectIdentity;
    readonly config: HermesLaunchObjectIdentity;
  };
  /** Run-bound native identities from volume root through auth root and the exact Run profile. */
  readonly profileHomePathChain?: HermesWindowsPathIdentityChain;
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
  readonly profileHomePathChain?: HermesWindowsPathIdentityChain;
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
  ticketStates.set(ticket, {
    ...input,
    ...(input.profileHomePathChain
      ? { profileHomePathChain: cloneWindowsPathIdentityChain(input.profileHomePathChain) }
      : {}),
    environment: Object.freeze({ ...input.environment }),
    consumed: false,
  });
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
    ...(state.profileHomeTargetIdentities ? { profileHomeTargetIdentities: Object.freeze({
      home: Object.freeze({ ...state.profileHomeTargetIdentities.home }),
      config: Object.freeze({ ...state.profileHomeTargetIdentities.config }),
    }) } : {}),
    ...(state.profileHomePathChain
      ? { profileHomePathChain: cloneWindowsPathIdentityChain(state.profileHomePathChain) }
      : {}),
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
      (input.platform === "win32" && !isValidProfileHomeTargetIdentities(input.profileHomeTargetIdentities, input.profileHomeIdentity)) ||
      (input.platform === "linux" && input.profileHomeTargetIdentities !== undefined) ||
      (input.platform === "win32" && !isValidWindowsPathIdentityChain(input.profileHomePathChain, input)) ||
      (input.platform === "linux" && input.profileHomePathChain !== undefined) ||
      !isValidObjectIdentity(input.hermesSourceSnapshotRootIdentity) ||
      input.executableArgsPrefix.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  }
}

function isValidProfileHomeTargetIdentities(
  value: unknown,
  profileIdentity: HermesLaunchObjectIdentity,
): value is NonNullable<HermesLaunchTicketInput["profileHomeTargetIdentities"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const targets = value as Record<string, unknown>;
  if (Object.keys(targets).sort().join(",") !== "config,home") return false;
  for (const key of ["home", "config"] as const) {
    const identity = targets[key];
    if (typeof identity !== "object" || identity === null || Array.isArray(identity) ||
        Object.keys(identity).sort().join(",") !== "fileId,platform,volumeSerial" ||
        !isValidObjectIdentity(identity as HermesLaunchObjectIdentity) ||
        (identity as HermesLaunchObjectIdentity).platform !== "win32" ||
        (identity as Extract<HermesLaunchObjectIdentity, { platform: "win32" }>).volumeSerial !==
          (profileIdentity as Extract<HermesLaunchObjectIdentity, { platform: "win32" }>).volumeSerial) return false;
  }
  return (targets.home as Extract<HermesLaunchObjectIdentity, { platform: "win32" }>).fileId !==
    (targets.config as Extract<HermesLaunchObjectIdentity, { platform: "win32" }>).fileId;
}

function isValidWindowsPathIdentityChain(value: unknown, input: HermesLaunchTicketInput): value is HermesWindowsPathIdentityChain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const chain = value as Record<string, unknown>;
  if (Object.keys(chain).sort().join(",") !== "authRootIndex,components,version" || chain.version !== 1 ||
      !Number.isSafeInteger(chain.authRootIndex) || !Array.isArray(chain.components) ||
      chain.components.length < 2 || chain.components.length > 64) return false;
  const components = chain.components as unknown[];
  if (!components.every((component) => {
    if (typeof component !== "object" || component === null || Array.isArray(component) ||
        Object.keys(component).sort().join(",") !== "fileId,volumeSerial") return false;
    const record = component as Record<string, unknown>;
    return typeof record.volumeSerial === "string" && /^[a-f0-9]{16}$/u.test(record.volumeSerial) &&
      typeof record.fileId === "string" && /^[a-f0-9]{32}$/u.test(record.fileId);
  })) return false;
  const typedComponents = components as HermesWindowsPathComponentIdentity[];
  if (!typedComponents.every((component) => component.volumeSerial === typedComponents[0]?.volumeSerial)) return false;
  if (input.profileHomeIdentity.platform !== "win32") return false;
  const profileHomeIdentity = input.profileHomeIdentity;
  const root = path.win32.parse(input.profileHome).root;
  const relative = path.win32.relative(root, input.profileHome);
  const pathParts = relative.split(/[\\/]+/u).filter(Boolean);
  const authRoot = path.win32.dirname(path.win32.dirname(input.profileHome));
  const authRootParts = path.win32.relative(root, authRoot).split(/[\\/]+/u).filter(Boolean);
  const runProfileName = `ebb-orchestrator-run-${input.runId}`;
  const canonicalProfile = path.win32.join(authRoot, "profiles", runProfileName);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.runId) &&
    path.win32.isAbsolute(root) && path.win32.normalize(canonicalProfile).toLocaleLowerCase("en-US") ===
      path.win32.normalize(input.profileHome).toLocaleLowerCase("en-US") &&
    components.length === pathParts.length + 1 && chain.authRootIndex === authRootParts.length &&
    chain.authRootIndex > 0 && chain.authRootIndex < components.length &&
    typedComponents.at(-1)?.volumeSerial === profileHomeIdentity.volumeSerial.toLowerCase() &&
    typedComponents.at(-1)?.fileId === profileHomeIdentity.fileId.toLowerCase();
}

function cloneWindowsPathIdentityChain(chain: HermesWindowsPathIdentityChain): HermesWindowsPathIdentityChain {
  return Object.freeze({
    version: chain.version,
    authRootIndex: chain.authRootIndex,
    components: Object.freeze(chain.components.map((component) => Object.freeze({ ...component }))),
  });
}

function isCanonicalSnapshotTicketBinding(input: HermesLaunchTicketInput): boolean {
  const key = input.hermesSourceSnapshotKey;
  if (typeof key !== "string" || key.length > 4096) return false;
  try {
    const value: unknown = JSON.parse(key);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const parsed = value as Record<string, unknown>;
    const { formatVersion, hermesVersion, manifestDigest: keyDigest, sourceCommit, sourceTree } = parsed;
    const expectedKeys = input.platform === "win32"
      ? "formatVersion,hermesVersion,manifestDigest,materializationPolicyVersion,sourceCommit,sourceTree"
      : "formatVersion,hermesVersion,manifestDigest,sourceCommit,sourceTree";
    if (Object.keys(parsed).sort().join(",") !== expectedKeys || formatVersion !== 1 ||
        (input.platform === "win32" && parsed.materializationPolicyVersion !== 2) ||
        (input.platform === "linux" && Object.hasOwn(parsed, "materializationPolicyVersion"))) return false;
    const canonicalIdentity = input.platform === "win32"
      ? { formatVersion, hermesVersion, manifestDigest: keyDigest, materializationPolicyVersion: 2, sourceCommit, sourceTree }
      : { formatVersion, hermesVersion, manifestDigest: keyDigest, sourceCommit, sourceTree };
    return typeof hermesVersion === "string" && hermesVersion.length > 0 && hermesVersion.length <= 256 &&
      typeof keyDigest === "string" && /^[a-f0-9]{64}$/u.test(keyDigest) && keyDigest === input.hermesSourceManifestDigest &&
      typeof sourceCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceCommit) &&
      typeof sourceTree === "string" && sourceTree.length === sourceCommit.length &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceTree) &&
      key === JSON.stringify(canonicalIdentity) &&
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
