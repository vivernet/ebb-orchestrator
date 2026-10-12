import * as path from "node:path";
import type { HermesManagedRunSelection } from "../../src/modules/runtime/hermes/hermes-run-selection.js";

/** Provider-free selection fixture; it never reads Hermes configuration or credentials. */
export function createHermesManagedSelectionFixture(runId: string, runtimeIdentity: string, hermesHome = path.join(process.platform === "win32" ? "C:/fixture" : "/fixture", "configured-hermes")): HermesManagedRunSelection {
  return { mode: "HERMES_MANAGED", runId, hermesHome, runtimeIdentity };
}
