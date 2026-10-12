import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { canonicalizeContextValueV1, digestRunContextV1, parsePersistedContextJsonV1 } from "./context-provenance.js";
import type { ContextFingerprintInputV1 } from "./context-types.js";

/** Сохраняет исходные поля fingerprint без path-bearing workspaceIdentity и без исходного prompt/content. */
export interface ContextResumeBaselineV1 {
  formatVersion: 1;
  fingerprint: Omit<ContextFingerprintInputV1, "workspaceIdentity">;
}

/** Строит versioned baseline только из точного assembler fingerprint, не из runtime output. */
export function createResumeContextBaselineV1(fingerprint: ContextFingerprintInputV1): ContextResumeBaselineV1 {
  digestRunContextV1(fingerprint);
  const { workspaceIdentity: _workspaceIdentity, ...projection } = fingerprint;
  return { formatVersion: 1, fingerprint: projection };
}

/** Разбирает strict persisted baseline; неизвестные поля, версия и повторные JSON keys запрещают recovery. */
export function decodeResumeContextBaselineV1(source: string): ContextResumeBaselineV1 {
  try {
    const parsed = parsePersistedContextJsonV1(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "fingerprint,formatVersion") throw new Error();
    const baseline = parsed as ContextResumeBaselineV1;
    if (baseline.formatVersion !== 1 || !baseline.fingerprint || typeof baseline.fingerprint !== "object" ||
        Object.hasOwn(baseline.fingerprint, "workspaceIdentity")) throw new Error();
    // Null identity is used only to validate the exact fingerprint schema, never as recovered identity/evidence.
    digestRunContextV1({ ...baseline.fingerprint, workspaceIdentity: { repository: null, workspace: null, worktree: null } });
    return baseline;
  } catch { throw new Error("RESUME_BASELINE_UNAVAILABLE"); }
}

/** Digest-only snapshot: raw paths, Git output и file contents никогда не возвращаются и не сохраняются. */
export interface WorkspaceSnapshotV1 { formatVersion: 1; hash: string; }

/**
 * Хэширует все доступные regular files, включая ignored/untracked, и точный Git HEAD/index/status.
 * `.git` metadata исключается; symlink/special file, чтение с ошибкой или изменение во время снимка дают отказ.
 * Это recovery evidence, а не OS permission inventory или новый Run admission gate.
 */
export function captureWorkspaceSnapshotV1(workspace: string): WorkspaceSnapshotV1 {
  try {
    if (!isAbsolute(workspace)) throw new Error();
    const root = realpathSync(workspace);
    const rootStat = lstatSync(workspace);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    const git = (args: string[]): Buffer => execFileSync("git", [
      "-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args,
    ], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const gitState = (): string => hashBytes(canonicalizeContextValueV1({
      head: hashBytes(git(["rev-parse", "--verify", "HEAD"])),
      index: hashBytes(git(["ls-files", "--stage", "-z"])),
      status: hashBytes(git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching"])),
    }));
    const beforeGit = gitState();
    const files: Array<{ path: string; hash: string }> = [];
    const walk = (directory: string): void => {
      const before = lstatSync(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error();
      for (const name of readdirSync(directory).sort()) {
        if (name === ".git") continue;
        const file = join(directory, name);
        const entry = lstatSync(file);
        if (entry.isSymbolicLink()) throw new Error();
        if (entry.isDirectory()) { walk(file); continue; }
        if (!entry.isFile()) throw new Error();
        const descriptor = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
        const digest = createHash("sha256");
        try {
          const opened = fstatSync(descriptor);
          if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error();
          const buffer = Buffer.allocUnsafe(65536);
          let bytes: number;
          while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, bytes));
          const after = fstatSync(descriptor);
          const named = lstatSync(file);
          if (!named.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino ||
              after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
              named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) throw new Error();
        } finally { closeSync(descriptor); }
        files.push({ path: relative(root, file).split(sep).join("/"), hash: digest.digest("hex") });
      }
      const after = lstatSync(directory);
      if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error();
    };
    walk(root);
    const afterGit = gitState();
    if (beforeGit !== afterGit || realpathSync(workspace) !== root) throw new Error();
    return { formatVersion: 1, hash: hashBytes(canonicalizeContextValueV1({ formatVersion: 1, gitState: beforeGit, files })) };
  } catch { throw new Error("RESUME_WORKSPACE_SNAPSHOT_UNAVAILABLE"); }
}

function hashBytes(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

/** Точный безопасный набор evidence для сравнения исходного контекста и workspace при recovery. */
export interface ResumeContextEvidenceV1 {
  originalSessionId: string | null;
  capturedSessionId: string | null;
  captureState: string;
  persistedContextHash: string;
  reconstructedContextHash: string;
  persistedWorkspaceSnapshotHash: string;
  currentWorkspaceSnapshotHash: string;
  persistedResumeBindingHash: string;
}

/** Связывает два уже вычисленных SHA-256 digest; не изменяет исходный context_hash и не включает path/content. */
export function digestResumeBindingV1(contextHash: string, workspaceSnapshotHash: string): string {
  if (!isHash(contextHash) || !isHash(workspaceSnapshotHash)) throw new Error("RESUME_BASELINE_UNAVAILABLE");
  return createHash("sha256").update(canonicalizeContextValueV1({
    formatVersion: 1, contextHash, workspaceSnapshotHash,
  })).digest("hex");
}

/**
 * Проверяет чистые evidence без runtime dispatch и без provider/config/credential inspection.
 * Caller получает current hashes из authoritative manifest reconstruction и полного доступного workspace snapshot.
 * Неизвестные/повреждённые поля запрещают recovery; изменение context/workspace даёт стабильный отказ.
 */
export function assertResumeContextEligible(evidence: ResumeContextEvidenceV1): void {
  if (evidence.captureState !== "BOUND" || !evidence.originalSessionId ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(evidence.originalSessionId) ||
      evidence.originalSessionId !== evidence.capturedSessionId) throw new Error("RESUME_ORIGINAL_SESSION_UNAVAILABLE");
  if (![evidence.persistedContextHash,evidence.reconstructedContextHash,evidence.persistedWorkspaceSnapshotHash,
    evidence.currentWorkspaceSnapshotHash,evidence.persistedResumeBindingHash].every(isHash)) {
    throw new Error("RESUME_BASELINE_UNAVAILABLE");
  }
  if (digestResumeBindingV1(evidence.persistedContextHash, evidence.persistedWorkspaceSnapshotHash) !== evidence.persistedResumeBindingHash) {
    throw new Error("RESUME_BASELINE_UNAVAILABLE");
  }
  if (evidence.persistedContextHash !== evidence.reconstructedContextHash ||
      evidence.persistedWorkspaceSnapshotHash !== evidence.currentWorkspaceSnapshotHash) {
    throw new Error("RESUME_NOT_SAFE_WORKSPACE_CHANGED");
  }
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
