-- Git operations journal and merge conflict tracking

-- GitOperation journal for tracking git mutations
-- Operations start as STARTED before command execution
-- Verified as VERIFIED after inspecting actual git state
CREATE TABLE IF NOT EXISTS git_operations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'STARTED',
  repo_path TEXT NOT NULL,
  branch_name TEXT,
  worktree_id TEXT,
  target_ref TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_git_operations_repo_status ON git_operations(repo_path, status);
CREATE INDEX IF NOT EXISTS idx_git_operations_type ON git_operations(type);

-- Branch tracking (for reconciliation and audit)
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  name TEXT NOT NULL,
  target_ref TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (repo_path, name, removed_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_branches_repo ON branches(repo_path);
CREATE INDEX IF NOT EXISTS idx_branches_removed ON branches(removed_at);

-- Worktree tracking (for reconciliation and audit)
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (repo_path, path, removed_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_path);
CREATE INDEX IF NOT EXISTS idx_worktrees_removed ON worktrees(removed_at);

-- MergeConflict records for tracking merge failures
CREATE TABLE IF NOT EXISTS merge_conflicts (
  id TEXT PRIMARY KEY,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  files TEXT NOT NULL,
  classification TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_merge_conflicts_source ON merge_conflicts(source_branch);
CREATE INDEX IF NOT EXISTS idx_merge_conflicts_target ON merge_conflicts(target_branch);
CREATE INDEX IF NOT EXISTS idx_merge_conflicts_status ON merge_conflicts(status);
