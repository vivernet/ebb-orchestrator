import { createHash } from "node:crypto";
import type { Database } from "../../src/platform/database/database.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { ProjectConfigRepository } from "../../src/modules/projects/project-config-repository.js";
import { ProjectConfigService } from "../../src/modules/projects/project-config-service.js";
import { parseProjectConfigYaml } from "../../src/platform/config/project-config.js";

/** Создаёт approved Project Config fixture для RunContextAssembler tests. */
export function seedApprovedProjectConfig(database: Database, projectId: string, defaultBranch = "master"): void {
  const projectYaml = `schema_version: 1\nproject:\n  name: test-project\n  default_branch: ${defaultBranch}\n`;
  const sourceFiles = { ".ebb-orchestrator/project.yaml": Buffer.from(projectYaml, "utf8").toString("base64") };
  const manifestJson = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: createHash("sha256").update(projectYaml, "utf8").digest("hex") }] });
  const manifestHash = createHash("sha256").update("ebb-project-config-manifest-v1\0", "utf8").update(manifestJson, "utf8").digest("hex");
  const sortValue = (value: unknown): unknown => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, entry]) => [key, sortValue(entry)]))
    : value;
  const payload = { project: parseProjectConfigYaml(projectYaml), files: sourceFiles };
  const candidate = new ProjectConfigRepository(database).capture({
    projectId,
    sourceHead: "a".repeat(40),
    manifestJson,
    manifestHash,
    sourceFilesJson: JSON.stringify(sourceFiles),
    normalizedPayloadJson: JSON.stringify(sortValue(payload)),
    schemaVersion: 1,
  });
  new ProjectConfigService(database, new ApprovalService(database)).approve(projectId, candidate.candidate_id, candidate.manifest_hash);
}
