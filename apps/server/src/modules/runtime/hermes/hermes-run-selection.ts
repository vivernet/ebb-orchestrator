import type { StartRunOptions } from "../run-types.js";

export const HERMES_NATIVE_AUTH_POLICY_IDENTITY = "hermes-native-auth-json-root-fallback-v1";
export const HERMES_SNAPSHOT_BOOTSTRAP_POLICY_IDENTITY = "hermes-source-snapshot-bootstrap-v1";

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
  if (!options.runId || selection.runId !== options.runId ||
      !selection.providerId || !selection.modelId || !selection.endpointIdentity || !selection.endpointRevision ||
      !selection.sourceVersion || !selection.sourceCommit || !selection.profileHome) {
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
          providerPolicyId: `${selection.endpointIdentity}@${selection.endpointRevision};auth=${HERMES_NATIVE_AUTH_POLICY_IDENTITY}@${selection.sourceCommit}`,
          runtimeId: "hermes",
          runtimePolicyId: `${selection.sourceVersion}@${selection.sourceSnapshotKey};bootstrap=${HERMES_SNAPSHOT_BOOTSTRAP_POLICY_IDENTITY}`,
        },
      },
    } } : {}),
  };
}
