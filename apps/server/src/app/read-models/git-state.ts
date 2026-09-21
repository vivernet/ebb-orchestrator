import type { Database } from "../../platform/database/database.js";
import type { GitProjection } from "@ebb-orchestrator/contracts";

/** Читает необязательное integration state проекта; отсутствующие ключи сохраняются отсутствующими. */
export function persistedGitState(db: Database, projectId: string): Pick<GitProjection, "repositoryPath" | "defaultBranch" | "github"> {
  const rows = db.all<{ key: string; value_json: string }>(
    "SELECT key,value_json FROM system_state WHERE key IN ($github,$git,$config,$projectConfig)",
    { github: `project:${projectId}:github`, git: `project:${projectId}:git`, config: `project:${projectId}:config`, projectConfig: `project_config:${projectId}` },
  );
  for (const row of rows) {
    let value: unknown;
    try { value = JSON.parse(row.value_json); } catch { continue; }
    const candidate = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const config = (candidate.project && typeof candidate.project === "object" ? candidate.project : candidate) as Record<string, unknown>;
    const github = (candidate.github && typeof candidate.github === "object" ? candidate.github : candidate) as Record<string, unknown>;
    const status = typeof github.status === "string" ? github.status : undefined;
    const url = typeof github.url === "string" ? github.url : null;
    if (status || url || typeof config.repositoryPath === "string" || typeof config.repository_path === "string" || typeof config.defaultBranch === "string" || typeof config.default_branch === "string") {
      return {
        repositoryPath: typeof config.repositoryPath === "string" ? config.repositoryPath : typeof config.repository_path === "string" ? config.repository_path : null,
        defaultBranch: typeof config.defaultBranch === "string" ? config.defaultBranch : typeof config.default_branch === "string" ? config.default_branch : null,
        github: status || url ? { status: status ?? "CONNECTED", url } : null,
      };
    }
  }
  return { repositoryPath: null, defaultBranch: null, github: null };
}
