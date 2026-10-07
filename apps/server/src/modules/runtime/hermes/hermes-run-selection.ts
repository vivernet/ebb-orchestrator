import type { StartRunOptions } from "../run-types.js";
import * as path from "node:path";
import {
  HERMES_PROVIDER_SELECTION_SOURCE,
  isVerifiedHermesProviderSelectionProjection,
  type HermesProviderSelection,
} from "./hermes-provider-selection.js";
import {
  isVerifiedHermesRunProfileCreationReceipt,
  type HermesRunProfileCreationReceipt,
} from "../../../platform/home/hermes-profile-home.js";
import type { HermesWindowsPathIdentityChain } from "./hermes-launch-ticket.js";

export const HERMES_SNAPSHOT_BOOTSTRAP_POLICY_IDENTITY = "hermes-source-snapshot-bootstrap-v1";
export const HERMES_AUTH_ENVIRONMENT_POLICY_REVISION = "run-env-provenance-bound-v2";
export const HERMES_AUTH_PROFILE_POLICY_REVISION = "fresh-run-profile-v1";

const AUTH_ENVIRONMENT_KEYS = new Set([
  "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV",
  "HERMES_HOME", "HERMES_CONFIG", "HERMES_MODEL",
]);
const verifiedAuthRouteEvidence = new WeakSet<object>();

/** Exact Hermes-native auth route supported by the isolated v1 Run profile. */
export interface HermesNativeAuthRouteEvidence {
  readonly runId: string;
  readonly authRoot: string;
  readonly profileHome: string;
  readonly profileHomePathChain?: HermesWindowsPathIdentityChain;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointIdentity: string;
  readonly endpointRevision: string;
  readonly sourceVersion: string;
  readonly sourceCommit: string;
  readonly environmentPolicyRevision: string;
  readonly profilePolicyRevision: string;
  readonly route: "GLOBAL_DEFAULT_AUTH_JSON_FALLBACK";
  readonly profileState: "FRESH_EMPTY_RUN_PROFILE";
  readonly pluginState: "NO_RUN_PROFILE_PLUGIN_CONFIG";
  readonly policyIdentity: string;
}

/**
 * Source contract для Hermes `v0.21.5+7357.g9244275`: active-profile auth проверяется перед root
 * fallback (`hermes_cli/auth.py:496-549`, `830-847`, `952-977`). Новый profile создаётся пустым;
 * Hermes dotenv остаётся привязан к HERMES_HOME и pinned source `PROJECT_ROOT`, чей snapshot строится
 * из Git tree (`hermes_cli/main.py:423,712`); child env и профиль не содержат provider env/plugin
 * источников. Это подтверждает только поддерживаемый root auth-store route, не наличие или выбор
 * конкретной auth row и не успешность provider-запроса.
 *
 * @param input Verified scanner projection, native-created profile receipt, pinned source and child environment.
 * @param input.profileReceipt Opaque proof issued only after the verified native helper creates this Run profile.
 * @param input.providerSelection Immutable provider/model projection returned by the verified native scanner.
 * @param input.authRoot Hermes root that owns the global/default auth store.
 * @param input.hermesProjectRoot Exact pinned Hermes source root used by the scanner.
 * @param input.sourceVersion Pinned Hermes version.
 * @param input.sourceCommit Pinned Hermes source commit.
 * @param input.environment Injected child environment; only allowlisted keys are accepted.
 * @param input.profileHomePathChain Native-verified Windows identity chain for the fresh Run profile home.
 * @returns Непубличное evidence с версионированной policy identity без secret values и account IDs.
 * @throws {Error} Для неподдерживаемого pin, пути, env key, профиля или plugin configuration.
 */
export function deriveHermesNativeAuthRouteEvidence(input: {
  profileReceipt: HermesRunProfileCreationReceipt;
  providerSelection: HermesProviderSelection;
  authRoot: string;
  hermesProjectRoot: string;
  sourceVersion: string;
  sourceCommit: string;
  environment: Readonly<Record<string, string>>;
  profileHomePathChain?: HermesWindowsPathIdentityChain;
}): HermesNativeAuthRouteEvidence {
  const runId = input.profileReceipt.runId;
  const profileHome = input.profileReceipt.profileHome;
  const providerId = input.providerSelection.providerId;
  const modelId = input.providerSelection.modelId;
  if (!isSafeRunPathSegment(runId) || !providerId || !modelId ||
      input.sourceVersion !== HERMES_PROVIDER_SELECTION_SOURCE.version ||
      input.sourceCommit !== HERMES_PROVIDER_SELECTION_SOURCE.commit ||
      !input.providerSelection.endpointIdentityEligible ||
      !input.providerSelection.endpointIdentity || !input.providerSelection.endpointRevision ||
      (process.platform === "win32" && input.profileHomePathChain === undefined) ||
      (process.platform !== "win32" && input.profileHomePathChain !== undefined) ||
      !isVerifiedHermesRunProfileCreationReceipt(input.profileReceipt, { runId, hermesRoot: input.authRoot, profileHome }) ||
      !isVerifiedHermesProviderSelectionProjection(input.providerSelection, {
        runId,
        hermesConfigHome: input.authRoot,
        hermesRunProfileHome: profileHome,
        hermesProjectRoot: input.hermesProjectRoot,
        sourceVersion: input.sourceVersion,
        sourceCommit: input.sourceCommit,
        runEnvironment: input.environment,
      }) ||
      !isSupportedAuthProfilePath(input.authRoot, profileHome, runId) ||
      Object.keys(input.environment).some((key) => !AUTH_ENVIRONMENT_KEYS.has(key))) {
    throw new Error("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
  }

  const evidence: HermesNativeAuthRouteEvidence = Object.freeze({
    runId,
    authRoot: input.authRoot,
    profileHome,
    providerId,
    modelId,
    endpointIdentity: input.providerSelection.endpointIdentity,
    endpointRevision: input.providerSelection.endpointRevision,
    sourceVersion: input.sourceVersion,
    sourceCommit: input.sourceCommit,
    environmentPolicyRevision: HERMES_AUTH_ENVIRONMENT_POLICY_REVISION,
    profilePolicyRevision: HERMES_AUTH_PROFILE_POLICY_REVISION,
    ...(input.profileHomePathChain ? { profileHomePathChain: clonePathIdentityChain(input.profileHomePathChain) } : {}),
    route: "GLOBAL_DEFAULT_AUTH_JSON_FALLBACK",
    profileState: "FRESH_EMPTY_RUN_PROFILE",
    pluginState: "NO_RUN_PROFILE_PLUGIN_CONFIG",
    policyIdentity: buildAuthPolicyIdentity(input.sourceCommit),
  });
  verifiedAuthRouteEvidence.add(evidence);
  return evidence;
}

function clonePathIdentityChain(chain: HermesWindowsPathIdentityChain): HermesWindowsPathIdentityChain {
  return Object.freeze({
    version: chain.version,
    authRootIndex: chain.authRootIndex,
    components: Object.freeze(chain.components.map((component) => Object.freeze({ ...component }))),
  });
}

/** Re-derives the policy instead of accepting a caller-supplied auth marker. */
export function isHermesNativeAuthRouteEvidence(value: unknown): value is HermesNativeAuthRouteEvidence {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    verifiedAuthRouteEvidence.has(value);
}

/** Non-secret Hermes selection pinned to one newly created Run profile. */
export interface HermesRunSelection {
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointIdentity: string;
  readonly endpointRevision: string;
  readonly sourceVersion: string;
  readonly sourceCommit: string;
  /** Exact canonical JCS snapshot key persisted on the durable Run process owner. */
  readonly sourceSnapshotKey: string;
  readonly profileHome: string;
  readonly profileHomePathChain?: HermesWindowsPathIdentityChain;
  readonly authRouteEvidence: HermesNativeAuthRouteEvidence;
}

/** Selection plus a rollback-only cleanup action for the exact newly created empty profile. */
export interface HermesRunSelectionPreflight {
  readonly selection: HermesRunSelection;
  /** Releases a retained source reference only after the Run and owner transaction committed. */
  commit?(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Connects the source-pinned, non-secret Hermes selection to the exact Run options and their
 * context fingerprint before context assembly. The model written to `agent_runs`, CLI `--model`,
 * generated profile config, and fingerprint therefore share one selected value.
 *
 * @param options Caller-owned Run request with its immutable subject, prompt and workspace context.
 * @param selection Native Hermes provider/model projection bound to the Run UUID and profile.
 * @returns New options preserving all caller data while replacing only runtime/model identity.
 * @throws {Error} If the UUID, selection identity, or context input is incomplete or mismatched.
 */
export function bindHermesRunSelectionToOptions<T extends StartRunOptions>(
  options: T,
  selection: HermesRunSelection,
): T {
  if (!isHermesNativeAuthRouteEvidence(selection.authRouteEvidence) ||
      selection.authRouteEvidence.runId !== selection.runId ||
      selection.authRouteEvidence.profileHome !== selection.profileHome ||
      !samePathIdentityChain(selection.authRouteEvidence.profileHomePathChain, selection.profileHomePathChain) ||
      selection.authRouteEvidence.providerId !== selection.providerId ||
      selection.authRouteEvidence.modelId !== selection.modelId ||
      selection.authRouteEvidence.endpointIdentity !== selection.endpointIdentity ||
      selection.authRouteEvidence.endpointRevision !== selection.endpointRevision ||
      selection.authRouteEvidence.sourceVersion !== selection.sourceVersion ||
      selection.authRouteEvidence.sourceCommit !== selection.sourceCommit) {
    throw new Error("HERMES_NATIVE_AUTH_SOURCE_UNSUPPORTED");
  }
  if (!options.runId || selection.runId !== options.runId ||
      !selection.providerId || !selection.modelId || !selection.endpointIdentity || !selection.endpointRevision ||
      !selection.sourceVersion || !selection.sourceCommit || !selection.profileHome ||
      selection.sourceVersion !== HERMES_PROVIDER_SELECTION_SOURCE.version ||
      selection.sourceCommit !== HERMES_PROVIDER_SELECTION_SOURCE.commit) {
    throw new Error("HERMES_RUN_SELECTION_BINDING_MISMATCH");
  }
  if (typeof selection.sourceSnapshotKey !== "string" || selection.sourceSnapshotKey.length === 0) {
    throw new Error("HERMES_RUN_SELECTION_BINDING_MISMATCH");
  }

  return {
    ...options,
    model: selection.modelId,
    ...(options.contextInput ? { contextInput: {
      ...options.contextInput,
      versions: {
        ...options.contextInput.versions,
        runtime: "hermes",
        runtimeVersion: selection.sourceVersion,
        model: selection.modelId,
      },
      execution: {
        ...options.contextInput.execution,
        policyIdentity: {
          providerId: selection.providerId,
          providerPolicyId: `${selection.endpointIdentity}@${selection.endpointRevision};auth=${selection.authRouteEvidence.policyIdentity}`,
          runtimeId: "hermes",
          runtimePolicyId: `${selection.sourceVersion}@${selection.sourceSnapshotKey};bootstrap=${HERMES_SNAPSHOT_BOOTSTRAP_POLICY_IDENTITY}`,
        },
      },
    } } : {}),
  };
}

function samePathIdentityChain(
  left: HermesWindowsPathIdentityChain | undefined,
  right: HermesWindowsPathIdentityChain | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildAuthPolicyIdentity(sourceCommit: string): string {
  return `hermes-native-global-default-auth-v2@${sourceCommit};env=${HERMES_AUTH_ENVIRONMENT_POLICY_REVISION};profile=${HERMES_AUTH_PROFILE_POLICY_REVISION};dotenv=source-snapshot-only;plugins=absent`;
}

function isSupportedAuthProfilePath(authRoot: string, profileHome: string, runId: string): boolean {
  if (!path.isAbsolute(authRoot) || !path.isAbsolute(profileHome)) return false;
  const expected = path.join(authRoot, "profiles", `ebb-orchestrator-run-${runId}`);
  return sameNativePath(profileHome, expected);
}

function sameNativePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.win32.normalize(left).toLocaleLowerCase("en-US") === path.win32.normalize(right).toLocaleLowerCase("en-US")
    : path.posix.normalize(left) === path.posix.normalize(right);
}

function isSafeRunPathSegment(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}
