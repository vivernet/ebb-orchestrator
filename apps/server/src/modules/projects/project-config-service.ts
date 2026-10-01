import { constants } from "node:fs";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { parseProjectConfig, parseProjectConfigYaml, type ProjectConfigV1 } from "../../platform/config/project-config.js";
import type { ApprovalTransactionPort } from "../approvals/approval-port.js";
import { ProjectConfigRepository, ProjectConfigRepositoryConflictError, type ProjectConfigCandidateRecord, type ProjectConfigCandidateStatus, type ProjectConfigRevisionRecord } from "./project-config-repository.js";

type CandidateRow = ProjectConfigCandidateRecord;
type RevisionRow = ProjectConfigRevisionRecord;
interface FileSnapshot { readonly path: string; readonly state: "present" | "deleted"; readonly sha256: string | null; }
interface CaptureResult {
  readonly sourceHead: string;
  readonly manifest: readonly FileSnapshot[];
  readonly manifestJson: string;
  readonly manifestHash: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly normalizedPayload: Readonly<Record<string, unknown>>;
  readonly schemaVersion: number;
}

const MAX_PROJECT_CONFIG_FILES = 100;
const MAX_PROJECT_CONFIG_FILE_BYTES = 1_048_576;
const MAX_PROJECT_CONFIG_TOTAL_BYTES = 5_242_880;

export interface ProjectConfigCandidate {
  readonly candidateId: string;
  readonly projectId: string;
  readonly sourceHead: string;
  readonly manifest: readonly FileSnapshot[];
  readonly manifestHash: string;
  readonly files: Readonly<Record<string, string>>;
  readonly normalizedPreview: Readonly<Record<string, unknown>>;
  readonly status: ProjectConfigCandidateStatus;
  readonly createdAt: string;
}
/** Представляет неизменяемую approved revision и её проверяемую provenance. */
export interface ProjectConfigRevision {
  readonly revisionId: string;
  readonly candidateId: string;
  readonly projectId: string;
  readonly schemaVersion: number;
  readonly normalizedConfig: Readonly<Record<string, unknown>>;
  readonly manifestHash: string;
  readonly revisionHash: string;
  readonly manifest: readonly FileSnapshot[];
  readonly files: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

/** Представляет отказ Project Config lifecycle без раскрытия внутренних деталей хранения. */
export class ProjectConfigError extends Error {
  constructor(readonly code: "PROJECT_CONFIG_PROJECT_NOT_FOUND" | "PROJECT_CONFIG_NOT_FOUND" | "PROJECT_CONFIG_INVALID" | "PROJECT_CONFIG_UNSTABLE" | "PROJECT_CONFIG_CANDIDATE_NOT_CURRENT" | "PROJECT_CONFIG_ACTIVE_INVALID" | "PROJECT_CONFIG_UNSUPPORTED_PLATFORM", message: string) {
    super(message);
    this.name = "ProjectConfigError";
  }
}

/** Владеет reviewable repository candidates и единственным путём активации approved Project Config. */
export class ProjectConfigService {
  private readonly repository: ProjectConfigRepository;

  constructor(database: Database, private readonly approvals: ApprovalTransactionPort, repository?: ProjectConfigRepository) {
    this.repository = repository ?? new ProjectConfigRepository(database);
  }

  /** Снимает стабильный immutable snapshot только из canonical `.ebb-orchestrator/` каталога. */
  capture(projectId: string): ProjectConfigCandidate {
    if (process.platform === "win32") {
      throw new ProjectConfigError("PROJECT_CONFIG_UNSUPPORTED_PLATFORM", "Project Config capture is disabled on Windows until safe file-handle verification is supported.");
    }
    const root = this.repositoryRoot(projectId);
    const first = captureRepository(root);
    const second = captureRepository(root);
    if (first.manifestHash !== second.manifestHash || first.sourceHead !== second.sourceHead) {
      throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config changed during capture; retry after repository changes stop.");
    }
    const row = this.repository.capture({
      projectId,
      sourceHead: first.sourceHead,
      manifestJson: first.manifestJson,
      manifestHash: first.manifestHash,
      sourceFilesJson: JSON.stringify(first.sourceFiles),
      normalizedPayloadJson: canonicalJson(first.normalizedPayload),
      schemaVersion: first.schemaVersion,
    });
    return candidateFromRow(row);
  }

  /** Возвращает текущий persisted candidate и никогда не читает live repository для отображения diff. */
  getCurrentCandidate(projectId: string): ProjectConfigCandidate | undefined {
    const row = this.repository.getCurrentCandidate(projectId);
    if (!row) return undefined;
    if (!candidateIntegrityValid(row)) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Persisted Project Config candidate failed integrity validation.");
    return candidateFromRow(row);
  }

  /** Возвращает историю Project Config от новых revisions к старым для явного восстановления. */
  listRevisions(projectId: string): ProjectConfigRevision[] {
    return this.repository.listRevisions(projectId)
      .filter(revisionIntegrityValid).map(revisionFromRow);
  }

  /** Явно одобряет только показанный current candidate и атомарно меняет active revision. */
  approve(projectId: string, candidateId: string, expectedManifestHash: string): ProjectConfigRevision {
    let row: RevisionRow | undefined;
    try {
      row = this.repository.approveCandidate(projectId, candidateId, expectedManifestHash, (tx, candidate) => {
        if (!candidateIntegrityValid(candidate)) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Persisted Project Config candidate failed integrity validation.");
        const payload = JSON.parse(candidate.normalized_payload_json) as Record<string, unknown>;
        const revisionHash = hashDomain("ebb-project-config-revision-v1\0", canonicalJson(payload));
        const revisionId = randomUUID();
        const approval = this.approvals.requestInTransaction(tx, {
          type: "WORKFLOW_CHANGE", subjectId: projectId, subjectType: "PROJECT", requestedBy: "local-user",
          metadata: { kind: "project-config", candidateId, manifestHash: candidate.manifest_hash, revisionHash },
        });
        this.approvals.approveInTransaction(tx, {
          approvalId: approval.id, subjectId: projectId, subjectType: "PROJECT", type: "WORKFLOW_CHANGE", actor: "local-user",
          note: `Project Config candidate ${candidateId} approved (${candidate.manifest_hash})`,
        });
        const now = new Date().toISOString();
        return { revisionId, revisionHash, approvalId: approval.id, createdAt: now };
      });
    } catch (error) {
      if (error instanceof ProjectConfigRepositoryConflictError) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate changed during approval.");
      throw error;
    }
    if (!row) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Project Config candidate is stale or no longer current.");
    return revisionFromRow(row);
  }

  /** Возвращает только approved active revision и fail-closed при integrity mismatch. */
  getActive(projectId: string): ProjectConfigRevision | undefined {
    const { state, revision: row } = this.repository.getActiveRevision(projectId);
    if (state?.config_status === "DEGRADED") throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Project Config is degraded and requires explicit recovery.");
    if (!state?.active_revision_id) return undefined;
    if (!row) {
      this.repository.markDegraded(projectId, state.active_revision_id);
      throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved Project Config revision is missing or its approval is invalid.");
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.normalized_payload_json) as Record<string, unknown>;
      const project = parseProjectConfig(payload.project);
      if (project.schema_version !== row.schema_version || row.approval_status !== "APPROVED") throw new Error("unsupported active config");
      const actual = hashDomain("ebb-project-config-revision-v1\0", canonicalJson(payload));
      const manifestActual = hashDomain("ebb-project-config-manifest-v1\0", row.manifest_json);
      if (actual !== row.revision_hash || manifestActual !== row.manifest_hash || !snapshotIntegrityValid(row.manifest_json, row.source_files_json, row.manifest_hash)) throw new Error("active config integrity mismatch");
      if (JSON.stringify(payload.files) !== JSON.stringify(JSON.parse(row.source_files_json))) throw new Error("active source snapshot binding mismatch");
    } catch {
      this.repository.markDegraded(projectId, state.active_revision_id);
      throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved Project Config revision failed integrity validation.");
    }
    return revisionFromRow(row);
  }

  /** Проверяет все active revisions перед READY и помечает повреждённые Projects как DEGRADED. */
  reconcileActiveOnStartup(): void {
    const projectIds = this.repository.listActiveProjectIds();
    for (const projectId of projectIds) {
      try { this.getActive(projectId); }
      catch (error) {
        if (!(error instanceof ProjectConfigError) || error.code !== "PROJECT_CONFIG_ACTIVE_INVALID") throw error;
      }
    }
  }

  /** Ставит исторический approved snapshot на review; он становится active только после нового точного approval. */
  stageRollback(projectId: string, revisionId: string): ProjectConfigCandidate {
    const row = this.repository.stageRollback(projectId, revisionId, revisionIntegrityValid);
    if (!row) throw new ProjectConfigError("PROJECT_CONFIG_CANDIDATE_NOT_CURRENT", "Historical Project Config revision cannot be restored.");
    return candidateFromRow(row);
  }

  private repositoryRoot(projectId: string): string {
    const path = this.repository.getRepositoryPath(projectId);
    if (!path) throw new ProjectConfigError("PROJECT_CONFIG_PROJECT_NOT_FOUND", "Project repository is unavailable.");
    try { return realpathSync(path); }
    catch { throw new ProjectConfigError("PROJECT_CONFIG_PROJECT_NOT_FOUND", "Project repository is unavailable."); }
  }
}

/** Проверяет Project Config integrity внутри scheduler-owned transaction перед dispatch. */
export function projectConfigDispatchAllowedTx(tx: DatabaseTx, projectId: string): boolean {
  if (!ProjectConfigRepository.hasLifecycleSchema(tx)) return true;
  const state = ProjectConfigRepository.readDispatchState(tx, projectId);
  if (!state) return true;
  if (state.config_status !== "READY") return false;
  // После первого candidate Project уже участвует в lifecycle: до первого
  // точного approval нет authoritative snapshot для dispatch.
  if (!state.active_revision_id) return false;
  const row = ProjectConfigRepository.readApprovedRevision(tx, projectId, state.active_revision_id);
  if (!row || row.approval_status !== "APPROVED" || !revisionIntegrityValid(row)) return false;
  return true;
}

/** Выдаёт runtime только проверенный approved snapshot; отсутствие lifecycle state сохраняет legacy Project. */
export function approvedProjectConfigSnapshotTx(tx: DatabaseTx, projectId: string): { revisionId: string; revisionHash: string; config: ProjectConfigV1 } | undefined {
  const state = ProjectConfigRepository.readDispatchState(tx, projectId);
  if (!state) return undefined;
  if (state.config_status !== "READY" || !state.active_revision_id) throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Project Config has no approved active revision.");
  const revision = approvedProjectConfigRevisionTx(tx, projectId, state.active_revision_id);
  return { revisionId: revision.revisionId, revisionHash: revision.revisionHash, config: revision.config };
}

/** Повторно проверяет immutable revision при загрузке выданной run capability. */
export function approvedProjectConfigRevisionTx(tx: DatabaseTx, projectId: string, revisionId: string): { revisionId: string; revisionHash: string; config: ProjectConfigV1; files: Readonly<Record<string, string>> } {
  const row = ProjectConfigRepository.readApprovedRevision(tx, projectId, revisionId);
  if (!row || row.approval_status !== "APPROVED" || !revisionIntegrityValid(row)) {
    throw new ProjectConfigError("PROJECT_CONFIG_ACTIVE_INVALID", "Approved Project Config revision failed integrity validation.");
  }
  const payload = JSON.parse(row.normalized_payload_json) as { project: unknown };
  return { revisionId: row.revision_id, revisionHash: row.revision_hash, config: parseProjectConfig(payload.project), files: revisionFromRow(row).files };
}

function captureRepository(root: string): CaptureResult {
  const directory = join(root, ".ebb-orchestrator");
  let directoryInfo;
  try { directoryInfo = lstatSync(directory); } catch { throw new ProjectConfigError("PROJECT_CONFIG_NOT_FOUND", "Canonical Project Config directory was not found."); }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config directory must be a regular directory.");
  assertCanonicalContainment(directory, root);
  const sourceHead = git(root, ["rev-parse", "HEAD"]).trim();
  const tracked = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ".ebb-orchestrator"]).split(/\r?\n/).filter(Boolean).filter(isAllowedPath);
  const files = new Map<string, Buffer>();
  walk(directory, root, files);
  if (!files.has(".ebb-orchestrator/project.yaml")) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config requires `.ebb-orchestrator/project.yaml`.");
  const sourceFiles: Record<string, string> = {};
  const snapshots: FileSnapshot[] = [];
  for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Project Config file is not valid UTF-8: ${path}`); }
    if (text.includes("\0")) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Project Config file contains binary data: ${path}`);
    sourceFiles[path] = bytes.toString("base64");
    snapshots.push({ path, state: "present", sha256: sha256(bytes) });
  }
  const currentPaths = new Set(files.keys());
  for (const path of tracked) if (!currentPaths.has(path)) snapshots.push({ path, state: "deleted", sha256: null });
  snapshots.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const manifestJson = JSON.stringify({ files: snapshots.map(({ path, state, sha256: digest }) => ({ path, state, sha256: digest })) });
  const manifestHash = hashDomain("ebb-project-config-manifest-v1\0", manifestJson);
  const projectYaml = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(sourceFiles[".ebb-orchestrator/project.yaml"]!, "base64"));
  let projectConfig;
  try { projectConfig = parseProjectConfigYaml(projectYaml); }
  catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config project.yaml failed schema validation."); }
  const normalizedPayload = { project: projectConfig, files: Object.fromEntries(Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b, "en"))) };
  return { sourceHead, manifest: snapshots, manifestJson, manifestHash, sourceFiles, normalizedPayload, schemaVersion: projectConfig.schema_version };
}

function walk(directory: string, root: string, output: Map<string, Buffer>): void {
  assertCanonicalContainment(directory, root);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const fullPath = join(directory, entry.name);
    const relativePath = relative(root, fullPath).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config cannot contain symlinks or reparse points.");
    assertCanonicalContainment(fullPath, root);
    if (entry.isDirectory()) {
      if (relativePath !== ".ebb-orchestrator/guidelines" && relativePath !== ".ebb-orchestrator/decisions") throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Unknown Project Config directory: ${relativePath}`);
      walk(fullPath, root, output);
      continue;
    }
    if (!entry.isFile() || !isAllowedPath(relativePath)) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", `Unknown Project Config file: ${relativePath}`);
    if (output.size >= MAX_PROJECT_CONFIG_FILES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config exceeds the file count limit.");
    const bytes = readStableFile(fullPath, root);
    const totalBytes = [...output.values()].reduce((total, content) => total + content.length, 0) + bytes.length;
    if (totalBytes > MAX_PROJECT_CONFIG_TOTAL_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config exceeds the total size limit.");
    output.set(relativePath, bytes);
  }
  assertCanonicalContainment(directory, root);
}

function readStableFile(path: string, root: string): Buffer {
  assertCanonicalContainment(path, root);
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config accepts regular files only.");
  if (before.size > MAX_PROJECT_CONFIG_FILE_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file exceeds the size limit.");
  let descriptor: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config file changed during capture.");
    if (opened.size > MAX_PROJECT_CONFIG_FILE_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file exceeds the size limit.");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    assertCanonicalContainment(path, root);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.size !== after.size) {
      throw new ProjectConfigError("PROJECT_CONFIG_UNSTABLE", "Project Config file changed during capture.");
    }
    if (bytes.length > MAX_PROJECT_CONFIG_FILE_BYTES) throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config file exceeds the size limit.");
    return bytes;
  } catch (cause) {
    if (cause instanceof ProjectConfigError) throw cause;
    throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config could not be read safely.");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function assertCanonicalContainment(path: string, root: string): void {
  try {
    const resolved = realpathSync.native(path);
    const configRoot = join(root, ".ebb-orchestrator");
    const within = relative(configRoot, resolved);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("outside canonical config root");
  } catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config path escapes its canonical directory or changed during capture."); }
}

function isAllowedPath(path: string): boolean {
  return path === ".ebb-orchestrator/project.yaml" || path === ".ebb-orchestrator/workflows.yaml"
    || /^\.ebb-orchestrator\/(?:guidelines|decisions)\/[^/]+\.md$/.test(path);
}
function git(root: string, args: string[]): string {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new ProjectConfigError("PROJECT_CONFIG_INVALID", "Project Config provenance could not be verified against Git."); }
}
function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function hashDomain(domain: string, value: string): string { return createHash("sha256").update(domain, "utf8").update(value, "utf8").digest("hex"); }
function canonicalJson(value: unknown): string { return JSON.stringify(sortValue(value)); }
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, sortValue(entry)]));
}
function candidateFromRow(row: CandidateRow): ProjectConfigCandidate {
  const manifest = (JSON.parse(row.manifest_json) as { files: FileSnapshot[] }).files;
  const encodedFiles = JSON.parse(row.source_files_json) as Record<string, string>;
  const files = Object.fromEntries(Object.entries(encodedFiles).map(([path, bytes]) => [path, Buffer.from(bytes, "base64").toString("utf8")]));
  return { candidateId: row.candidate_id, projectId: row.project_id, sourceHead: row.source_head, manifest, manifestHash: row.manifest_hash, files, normalizedPreview: JSON.parse(row.normalized_payload_json) as Record<string, unknown>, status: row.status, createdAt: row.created_at };
}
function revisionFromRow(row: RevisionRow): ProjectConfigRevision {
  const manifest = (JSON.parse(row.manifest_json) as { files: FileSnapshot[] }).files;
  const encodedFiles = JSON.parse(row.source_files_json) as Record<string, string>;
  const files = Object.fromEntries(Object.entries(encodedFiles).map(([path, bytes]) => [path, Buffer.from(bytes, "base64").toString("utf8")]));
  return { revisionId: row.revision_id, candidateId: row.candidate_id, projectId: row.project_id, schemaVersion: row.schema_version, normalizedConfig: JSON.parse(row.normalized_payload_json) as Record<string, unknown>, manifestHash: row.manifest_hash, revisionHash: row.revision_hash, manifest, files, createdAt: row.created_at };
}

function candidateIntegrityValid(row: CandidateRow): boolean {
  try {
    if (!snapshotIntegrityValid(row.manifest_json, row.source_files_json, row.manifest_hash)) return false;
    const files = JSON.parse(row.source_files_json) as Record<string, string>;
    const projectYaml = Buffer.from(files[".ebb-orchestrator/project.yaml"]!, "base64").toString("utf8");
    const project = parseProjectConfigYaml(projectYaml);
    const normalized = { project, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))) };
    return project.schema_version === row.schema_version && canonicalJson(normalized) === row.normalized_payload_json;
  } catch { return false; }
}

function snapshotIntegrityValid(manifestJson: string, sourceFilesJson: string, manifestHash: string): boolean {
  try {
    if (hashDomain("ebb-project-config-manifest-v1\0", manifestJson) !== manifestHash) return false;
    const parsedManifest = JSON.parse(manifestJson) as { files?: FileSnapshot[] };
    if (!parsedManifest || !Array.isArray(parsedManifest.files)) return false;
    const manifest = parsedManifest.files;
    const files = JSON.parse(sourceFilesJson) as Record<string, string>;
    const present = new Set<string>();
    for (const entry of manifest) {
      if (!isAllowedPath(entry.path) || (entry.state !== "present" && entry.state !== "deleted")) return false;
      if (entry.state === "deleted") {
        if (entry.sha256 !== null || files[entry.path] !== undefined) return false;
        continue;
      }
      const encoded = files[entry.path];
      if (typeof encoded !== "string") return false;
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || sha256(bytes) !== entry.sha256) return false;
      present.add(entry.path);
    }
    return Object.keys(files).length === present.size && Object.keys(files).every((path) => present.has(path));
  } catch { return false; }
}

function revisionIntegrityValid(row: RevisionRow): boolean {
  try {
    const payload = JSON.parse(row.normalized_payload_json) as Record<string, unknown>;
    const project = parseProjectConfig(payload.project);
    return project.schema_version === row.schema_version
      && hashDomain("ebb-project-config-revision-v1\0", canonicalJson(payload)) === row.revision_hash
      && snapshotIntegrityValid(row.manifest_json, row.source_files_json, row.manifest_hash)
      && JSON.stringify(payload.files) === JSON.stringify(JSON.parse(row.source_files_json));
  } catch { return false; }
}
