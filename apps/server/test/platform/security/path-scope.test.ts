import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PATH_OUTSIDE_SCOPE,
  PATH_UNRESOLVABLE,
  isPathWithinScope,
  normalizePathForScope,
  resolveArgsWithScope,
  resolvePathWithScope,
} from '../../../src/platform/security/path-scope.js';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'path-scope-'));
}

function removeWorkspace(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
}

describe('normalizePathForScope', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizePathForScope('  src/file.ts  ')).toBe('src/file.ts');
  });

  it('keeps a POSIX relative path intact', () => {
    expect(normalizePathForScope('nested/file.ts')).toBe('nested/file.ts');
  });

  it.skipIf(process.platform === 'win32')('keeps Windows-style backslashes intact on POSIX so drive signatures stay detectable', () => {
    expect(normalizePathForScope('C:\\outside.txt')).toBe('C:\\outside.txt');
    expect(normalizePathForScope('\\\\server\\share\\file')).toBe('\\\\server\\share\\file');
  });

  it.skipIf(process.platform !== 'win32')('normalizes backslashes to forward slashes on Windows', () => {
    expect(normalizePathForScope('nested\\file.ts')).toBe('nested/file.ts');
    expect(normalizePathForScope('C:\\outside.txt')).toBe('C:/outside.txt');
  });
});

describe('resolvePathWithScope', () => {
  it('resolves a relative path inside the workspace to a canonical absolute path', () => {
    const workspace = makeWorkspace();
    try {
      writeFileSync(join(workspace, 'a.txt'), 'x');
      const result = resolvePathWithScope(workspace, 'a.txt');
      expect(result).toEqual({ ok: true, path: join(realpathSync(workspace), 'a.txt') });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('resolves a nested non-existent target inside the workspace', () => {
    const workspace = makeWorkspace();
    try {
      const result = resolvePathWithScope(workspace, 'deep/nested/file.txt');
      expect(result).toEqual({ ok: true, path: join(realpathSync(workspace), 'deep/nested/file.txt') });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('resolves an empty argument to the workspace root', () => {
    const workspace = makeWorkspace();
    try {
      const result = resolvePathWithScope(workspace, '');
      expect(result).toEqual({ ok: true, path: realpathSync(workspace) });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('rejects path traversal outside the workspace', () => {
    const workspace = makeWorkspace();
    try {
      expect(resolvePathWithScope(workspace, '../../secret.txt')).toEqual({ ok: false, error: PATH_OUTSIDE_SCOPE });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('rejects an absolute path outside the workspace', () => {
    const workspace = makeWorkspace();
    const outside = join(tmpdir(), `path-scope-outside-${process.pid}-${Date.now()}`);
    try {
      expect(resolvePathWithScope(workspace, outside)).toEqual({ ok: false, error: PATH_OUTSIDE_SCOPE });
    } finally {
      removeWorkspace(workspace);
      removeWorkspace(outside);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects an absolute /tmp path outside the workspace', () => {
    const workspace = makeWorkspace();
    try {
      expect(resolvePathWithScope(workspace, '/tmp/evil')).toEqual({ ok: false, error: PATH_OUTSIDE_SCOPE });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('rejects a sibling prefix that is not inside the workspace', () => {
    expect(resolvePathWithScope('/workspace/project', '/workspace/project-evil/file.ts')).toEqual({
      ok: false,
      error: PATH_OUTSIDE_SCOPE,
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a Windows drive path on a POSIX workspace instead of treating it as relative', () => {
    expect(resolvePathWithScope('/workspace/project', 'C:\\workspace\\project\\..\\..\\etc\\passwd')).toEqual({
      ok: false,
      error: PATH_OUTSIDE_SCOPE,
    });
    expect(resolvePathWithScope('/workspace/project', 'C:\\outside.txt')).toEqual({
      ok: false,
      error: PATH_OUTSIDE_SCOPE,
    });
    expect(resolvePathWithScope('/workspace/project', 'C:/outside.txt')).toEqual({
      ok: false,
      error: PATH_OUTSIDE_SCOPE,
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a UNC path on a POSIX workspace', () => {
    expect(resolvePathWithScope('/workspace/project', '\\\\server\\share\\file')).toEqual({
      ok: false,
      error: PATH_OUTSIDE_SCOPE,
    });
  });

  it('rejects escape through a directory symlink/junction', (ctx) => {
    const workspace = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'path-scope-outside-'));
    const link = join(workspace, 'link');
    try {
      writeFileSync(join(outside, 'secret.txt'), 'forbidden');
      try {
        symlinkSync(outside, link, 'dir');
      } catch {
        try {
          symlinkSync(outside, link, 'junction');
        } catch {
          ctx.skip();
          return;
        }
      }
      expect(resolvePathWithScope(workspace, 'link/secret.txt')).toEqual({ ok: false, error: PATH_OUTSIDE_SCOPE });
    } finally {
      removeWorkspace(workspace);
      removeWorkspace(outside);
    }
  });

  it('accepts a workspace addressed through a symlink alias', (ctx) => {
    const workspace = makeWorkspace();
    const alias = join(tmpdir(), `path-scope-alias-${process.pid}-${Date.now()}`);
    try {
      try {
        symlinkSync(workspace, alias, 'dir');
      } catch {
        try {
          symlinkSync(workspace, alias, 'junction');
        } catch {
          ctx.skip();
          return;
        }
      }
      const result = resolvePathWithScope(alias, 'a.txt');
      expect(result).toEqual({ ok: true, path: join(realpathSync(workspace), 'a.txt') });
    } finally {
      removeWorkspace(workspace);
      rmSync(alias, { force: true });
    }
  });

  it('resolves a relative argument against baseCwd but still requires the final path inside the workspace', () => {
    const workspace = makeWorkspace();
    try {
      const baseCwd = join(workspace, 'sub');
      const result = resolvePathWithScope(workspace, 'file.txt', baseCwd);
      expect(result).toEqual({ ok: true, path: join(realpathSync(workspace), 'sub/file.txt') });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('returns PATH_UNRESOLVABLE for a path containing a NUL byte', () => {
    const workspace = makeWorkspace();
    try {
      expect(resolvePathWithScope(workspace, 'a\0b')).toEqual({ ok: false, error: PATH_UNRESOLVABLE });
    } finally {
      removeWorkspace(workspace);
    }
  });
});

describe('isPathWithinScope', () => {
  it('returns true for a canonical path inside the workspace', () => {
    const workspace = makeWorkspace();
    try {
      writeFileSync(join(workspace, 'a.txt'), 'x');
      expect(isPathWithinScope(workspace, join(realpathSync(workspace), 'a.txt'))).toBe(true);
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('returns false for a path outside the workspace', () => {
    const workspace = makeWorkspace();
    try {
      expect(isPathWithinScope(workspace, join(workspace, '..', 'outside.txt'))).toBe(false);
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('returns false for path traversal', () => {
    const workspace = makeWorkspace();
    try {
      expect(isPathWithinScope(workspace, '../../secret.txt')).toBe(false);
    } finally {
      removeWorkspace(workspace);
    }
  });

  it.skipIf(process.platform === 'win32')('returns false for a Windows drive path on a POSIX workspace', () => {
    expect(isPathWithinScope('/workspace/project', 'C:\\workspace\\project\\file.ts')).toBe(false);
  });

  it('returns false for escape through a directory symlink/junction', (ctx) => {
    const workspace = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'path-scope-outside-'));
    const link = join(workspace, 'link');
    try {
      writeFileSync(join(outside, 'secret.txt'), 'forbidden');
      try {
        symlinkSync(outside, link, 'dir');
      } catch {
        try {
          symlinkSync(outside, link, 'junction');
        } catch {
          ctx.skip();
          return;
        }
      }
      expect(isPathWithinScope(workspace, join(link, 'secret.txt'))).toBe(false);
    } finally {
      removeWorkspace(workspace);
      removeWorkspace(outside);
    }
  });
});

describe('resolveArgsWithScope', () => {
  it('rewrites path fields to canonical absolute paths and keeps other fields', () => {
    const workspace = makeWorkspace();
    try {
      writeFileSync(join(workspace, 'a.txt'), 'x');
      const args = { path: 'a.txt', ext: '.txt', flags: 42 };
      const result = resolveArgsWithScope(workspace, args, ['path']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.args.path).toBe(join(realpathSync(workspace), 'a.txt'));
      expect(result.args.ext).toBe('.txt');
      expect(result.args.flags).toBe(42);
      // Исходный объект аргументов не мутируется.
      expect(args.path).toBe('a.txt');
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('handles multiple path fields and leaves missing fields untouched', () => {
    const workspace = makeWorkspace();
    try {
      const args = { source: 'a.txt', target: 'b.txt' };
      const result = resolveArgsWithScope(workspace, args, ['source', 'target', 'missing']);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.args.source).toBe(join(realpathSync(workspace), 'a.txt'));
      expect(result.args.target).toBe(join(realpathSync(workspace), 'b.txt'));
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('rejects a non-string path field as PATH_UNRESOLVABLE', () => {
    const workspace = makeWorkspace();
    try {
      expect(resolveArgsWithScope(workspace, { path: 42 }, ['path'])).toEqual({
        ok: false,
        error: PATH_UNRESOLVABLE,
      });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it('rejects traversal in any path field', () => {
    const workspace = makeWorkspace();
    try {
      expect(resolveArgsWithScope(workspace, { path: '../../secret.txt' }, ['path'])).toEqual({
        ok: false,
        error: PATH_OUTSIDE_SCOPE,
      });
    } finally {
      removeWorkspace(workspace);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a foreign absolute path field on a POSIX workspace', () => {
    expect(resolveArgsWithScope('/workspace/project', { path: 'C:\\outside.txt' }, ['path'])).toEqual({
      ok: false,
      error: PATH_OUTSIDE_SCOPE,
    });
  });
});
