import type { GitOperationStatus, GitOperationType } from "./git-types.js";

export interface GitOperation {
  id: string;
  type: GitOperationType;
  status: GitOperationStatus;
  repo_path: string;
  branch_name: string | null;
  worktree_id: string | null;
  target_ref: string | null;
  created_at: string;
  verified_at: string | null;
}

export interface MergeConflict {
  id: string;
  source_branch: string;
  target_branch: string;
  files: string;
  classification: "TRIVIAL" | "RESOLVABLE" | "ARCHITECTURAL";
  status: "OPEN" | "RESOLVED";
  created_at: string;
  resolved_at: string | null;
}

export interface WorktreeRecord {
  id: string;
  repo_path: string;
  path: string;
  branch: string;
  created_at: string;
  removed_at: string | null;
}

export interface BranchRecord {
  id: string;
  repo_path: string;
  name: string;
  target_ref: string;
  created_at: string;
  removed_at: string | null;
}
