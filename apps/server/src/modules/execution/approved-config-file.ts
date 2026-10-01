import { relative, resolve, sep } from "node:path";

/** Отделяет canonical repository config от live workspace при чтении AgentRun. */
export function approvedConfigFileForPath(
  workspace: string,
  requestedPath: string,
  files: Readonly<Record<string, string>> | undefined,
): { applies: false } | { applies: true; content: string | undefined } {
  if (!files) return { applies: false };
  const relativePath = relative(workspace, resolve(workspace, requestedPath)).split(sep).join("/");
  const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
  if (key !== ".ebb-orchestrator" && !key.startsWith(".ebb-orchestrator/")) return { applies: false };
  if (process.platform !== "win32") return { applies: true, content: files[key] };
  const matches = Object.entries(files).filter(([filePath]) => filePath.toLowerCase() === key);
  return { applies: true, content: matches.length === 1 ? matches[0]![1] : undefined };
}
