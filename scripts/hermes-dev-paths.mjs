import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Разрешает путь implementation plan только внутри текущего worktree.
 *
 * @param {string} worktreeRoot Корень текущего Git worktree.
 * @param {string} planPath Абсолютный или worktree-relative путь к plan.
 * @returns {string | null} Канонический lexical path или null при выходе за границу.
 */
export function resolvePlanPath(worktreeRoot, planPath) {
  const root = resolve(worktreeRoot);
  const candidate = resolve(root, planPath);
  const candidateRelative = relative(root, candidate);
  if (!candidateRelative || candidateRelative.startsWith('..') || isAbsolute(candidateRelative)) return null;
  return candidate;
}
