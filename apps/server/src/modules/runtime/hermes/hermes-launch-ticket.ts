import path from "node:path";

const ticketBrand: unique symbol = Symbol("HermesLaunchTicket");

export type HermesLaunchObjectIdentity =
  | { readonly platform: "win32"; readonly volumeSerial: string; readonly fileId: string }
  | { readonly platform: "linux"; readonly device: string; readonly inode: string };

/** Минимальные сведения, связывающие прямой Hermes запуск с одним Run. */
export interface HermesLaunchTicketInput {
  readonly runId: string;
  readonly attempt: number | null;
  readonly platform: "win32" | "linux";
  readonly hermesExecutablePath: string;
  readonly hermesExecutableIdentity: HermesLaunchObjectIdentity;
  readonly sourceCommit: string | null;
  readonly executablePath: string;
  readonly executableIdentity: HermesLaunchObjectIdentity;
  readonly executableArgsPrefix: readonly string[];
  readonly hermesHome: string;
  readonly environment: {
    readonly HOMEDRIVE?: string;
    readonly HOMEPATH?: string;
    readonly USERPROFILE?: string;
    readonly LOCALAPPDATA?: string;
    readonly HERMES_HOME?: string;
    readonly HERMES_PROFILE?: string;
    readonly HERMES_MODEL?: string;
    readonly HOME?: string;
    readonly HERMES_CONFIG?: string;
    readonly HERMES_DATA_DIR_SUFFIX?: string;
    readonly HERMES_RUNTIME_DIR?: string;
  };
}

export interface HermesLaunchTicketFactoryInput {
  readonly mcpServer?: { readonly command: string; readonly args: readonly string[] };
  readonly runId: string;
  readonly attempt: number | null;
  readonly cwd: string;
  readonly hermesHome: string;
  readonly environment: HermesLaunchTicketInput["environment"];
}

export interface PreparedHermesLaunch {
  readonly executablePath: string;
  readonly argsPrefix: readonly string[];
  readonly ticket: HermesLaunchTicket;
}

export type HermesLaunchTicketFactory = (input: HermesLaunchTicketFactoryInput) => Promise<PreparedHermesLaunch>;

/** Одноразовое разрешение на запуск установленного Hermes для заданного Run. */
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
 * Создаёт одноразовый билет запуска и связывает его с Run, Python, Hermes launcher и окружением.
 *
 * @param input Абсолютные пути и идентичности исполняемых файлов для текущего запуска.
 * @returns Непрозрачный билет, который можно потребить только один раз.
 * @throws {Error} Если входные данные неполны или не соответствуют ожидаемым платформе и Run.
 */
export function createHermesLaunchTicket(input: HermesLaunchTicketInput): HermesLaunchTicket {
  assertTicketInput(input);
  const ticket = Object.freeze(Object.create(null)) as HermesLaunchTicket;
  ticketStates.set(ticket, { ...input, environment: Object.freeze({ ...input.environment }), consumed: false });
  return ticket;
}

/** Проверяет билет непосредственно перед передачей запроса supervisor-у. */
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
      request.environment.HERMES_CONFIG !== state.environment.HERMES_CONFIG ||
      request.environment.HERMES_PROFILE !== state.environment.HERMES_PROFILE ||
      request.environment.HERMES_MODEL !== state.environment.HERMES_MODEL ||
      request.environment.HOMEDRIVE !== state.environment.HOMEDRIVE ||
      request.environment.HOMEPATH !== state.environment.HOMEPATH ||
      request.environment.USERPROFILE !== state.environment.USERPROFILE ||
      request.environment.LOCALAPPDATA !== state.environment.LOCALAPPDATA ||
      request.environment.HERMES_DATA_DIR_SUFFIX !== state.environment.HERMES_DATA_DIR_SUFFIX ||
      request.environment.HERMES_RUNTIME_DIR !== state.environment.HERMES_RUNTIME_DIR) {
    throw new Error("HERMES_LAUNCH_TICKET_MISMATCH");
  }
  return Object.freeze({
    runId: state.runId,
    attempt: state.attempt,
    platform: state.platform,
    hermesExecutablePath: state.hermesExecutablePath,
    hermesExecutableIdentity: Object.freeze({ ...state.hermesExecutableIdentity }),
    sourceCommit: state.sourceCommit,
    executablePath: state.executablePath,
    executableIdentity: Object.freeze({ ...state.executableIdentity }),
    executableArgsPrefix: Object.freeze([...state.executableArgsPrefix]),
    hermesHome: state.hermesHome,
    environment: state.environment,
  });
}

function assertTicketInput(input: HermesLaunchTicketInput): void {
  const paths = input.platform === "win32" ? path.win32 : path.posix;
  if (!isUuidV4(input.runId) || (input.attempt !== null && (!Number.isSafeInteger(input.attempt) || input.attempt < 0)) ||
      (input.platform !== "win32" && input.platform !== "linux") ||
      !paths.isAbsolute(input.hermesExecutablePath) || !paths.isAbsolute(input.executablePath) ||
      !paths.isAbsolute(input.hermesHome) ||
      !(input.platform === "win32" ? ["hermes", "hermes.exe", "hermes.cmd"] : ["hermes", "hermes.exe"])
        .includes(paths.basename(input.hermesExecutablePath).toLowerCase()) ||
      (input.platform === "win32" && paths.basename(input.hermesExecutablePath).toLowerCase() === "hermes.cmd" &&
        paths.basename(input.executablePath).toLowerCase() !== "python.exe") ||
      input.hermesExecutableIdentity.platform !== input.platform || input.executableIdentity.platform !== input.platform ||
      (input.sourceCommit !== null && !/^[a-f0-9]{40}$/u.test(input.sourceCommit)) ||
      input.executableArgsPrefix.length < 2 || input.executableArgsPrefix.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      !isValidObjectIdentity(input.hermesExecutableIdentity) || !isValidObjectIdentity(input.executableIdentity) ||
      Object.values(input.environment).some((value) => value !== undefined && /[\0\r\n]/u.test(value))) {
    throw new Error("HERMES_LAUNCH_TICKET_INPUT_INVALID");
  }
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function isValidObjectIdentity(identity: HermesLaunchObjectIdentity): boolean {
  return identity.platform === "win32"
    ? /^[a-f0-9]{16}$/iu.test(identity.volumeSerial) && /^[a-f0-9]{32}$/iu.test(identity.fileId)
    : /^(0|[1-9][0-9]*)$/u.test(identity.device) && /^(0|[1-9][0-9]*)$/u.test(identity.inode);
}

function hasExactPrefix(args: readonly string[], prefix: readonly string[]): boolean {
  return args.length >= prefix.length && prefix.every((value, index) => args[index] === value);
}

function samePath(left: string, right: string, platform: "win32" | "linux"): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalizedLeft = paths.normalize(left);
  const normalizedRight = paths.normalize(right);
  return platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}
