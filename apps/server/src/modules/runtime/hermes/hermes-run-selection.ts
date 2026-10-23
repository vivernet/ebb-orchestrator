import type { StartRunOptions } from "../run-types.js";
import * as path from "node:path";
/** Installed Hermes and the user's existing home; provider/model/auth stay with Hermes. */
export interface HermesManagedRunSelection {
  readonly mode: "HERMES_MANAGED";
  readonly runId: string;
  readonly hermesHome: string;
  readonly runtimeIdentity: string;
}

export type HermesRuntimeSelection = HermesManagedRunSelection;

/** Проверенный выбор установленного Hermes до создания durable Run. */
export interface HermesRunSelectionPreflight {
  readonly selection: HermesRuntimeSelection;
}

/**
 * Связывает установленный Hermes с Run, сохраняя выбор provider/model за Hermes.
 *
 * Модель не ограничена `default`: и legacy `default`, и явная модель проходят
 * без отклонения; валидация явных моделей выполняется отдельно через реестр
 * built-in моделей.
 *
 * @param options Подготовленные входные данные того же Run.
 * @param selection Runtime identity; provider config and auth are not read.
 * @returns Options со стабильной runtime identity и неизвестной provider identity.
 * @throws {Error} При несовпадении Run/source identity.
 */
export function bindHermesRunSelectionToOptions<T extends StartRunOptions>(
  options: T,
  selection: HermesRuntimeSelection,
): T {
  if (selection.mode !== "HERMES_MANAGED" || options.runId !== selection.runId ||
      !path.isAbsolute(selection.hermesHome) || !selection.runtimeIdentity) {
    throw new Error("HERMES_RUN_SELECTION_BINDING_MISMATCH");
  }
  return options;
}
