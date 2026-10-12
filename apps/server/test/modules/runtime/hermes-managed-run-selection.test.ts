import { describe, expect, it } from "vitest";
import { bindHermesRunSelectionToOptions, type HermesManagedRunSelection } from "../../../src/modules/runtime/hermes/hermes-run-selection.js";
import type { StartRunOptions } from "../../../src/modules/runtime/run-types.js";

const runId = "dd144217-e39b-4e84-a4a7-057193700ca2";
const selection: HermesManagedRunSelection = {
  mode: "HERMES_MANAGED", runId, hermesHome: process.platform === "win32" ? "C:\\fixture\\hermes" : "/fixture/hermes",
  runtimeIdentity: "fixture-runtime",
};
const options: StartRunOptions = {
  runId, taskId: "fixture-task", epicId: null, role: "developer", model: "default",
  triggerReason: "runtime-request", contextVersion: "1", outputSchemaVersion: "1",
};

describe("Hermes-managed Run selection", () => {
  it("preserves default request metadata without inventing a configured model", () => {
    expect(bindHermesRunSelectionToOptions(options, selection)).toEqual(options);
  });
  it("rejects an explicit model override instead of silently ignoring it", () => {
    expect(() => bindHermesRunSelectionToOptions({ ...options, model: "custom-model" }, selection))
      .toThrow("HERMES_MODEL_OVERRIDE_UNSUPPORTED");
  });
  it("binds the installed runtime selection to the same Run UUID", () => {
    expect(() => bindHermesRunSelectionToOptions({ ...options, runId: "another-run" }, selection))
      .toThrow("HERMES_RUN_SELECTION_BINDING_MISMATCH");
  });
});
