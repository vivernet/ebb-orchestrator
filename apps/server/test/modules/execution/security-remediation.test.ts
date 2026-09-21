import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { GitTools } from '../../../src/modules/execution/git-tools.js';
import { GitCli, assertSafeGitRef } from '../../../src/modules/git/git-cli.js';

const temp = () => fs.mkdtempSync(path.join(tmpdir(), 'security-git-'));

describe('security Git remediation', () => {
  it('keeps metacharacters in one commit message and suppresses hooks', async () => {
    const repo = temp();
    try {
      const tools = new GitTools(repo);
      await tools.initRepo();
      // Чистые CI runners не предоставляют глобальную Git identity. Делаем фикстуру
      // самодостаточной, чтобы commit и проверяемый обход hook выполнялись
      // Проверялся вместо пропуска из-за проверки автора Git.
      const git = new GitCli();
      await git.run(repo, ['config', 'user.name', 'Ebb Orchestrator Tests']);
      await git.run(repo, ['config', 'user.email', 'tests@ebb-orchestrator.invalid']);
      const marker = path.join(repo, 'hook-ran');
      fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nprintf ran > "${marker.replace(/\\/g, '/')}"\nexit 1\n`);
      if (process.platform !== 'win32') fs.chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
      fs.writeFileSync(path.join(repo, 'safe.txt'), 'content');
      await tools.add(['safe.txt']);
      const message = 'safe; touch SHOULD_NOT_EXIST && echo "$HOME"';
      const commitOutput = await tools.commit(message);
      expect(commitOutput).toContain(message);
      const log = (await git.run(repo, ['log', '-1', '--format=%B'])).stdout;
      expect(log).toContain(message);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(path.join(repo, 'SHOULD_NOT_EXIST'))).toBe(false);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it.each(['-bad', 'bad name', 'bad..name', 'bad~name', 'bad;echo', 'foo/.bar', 'foo/bar.lock', '@'])('rejects unsafe ref %s', (ref) => {
    expect(() => assertSafeGitRef(ref)).toThrow('Invalid Git ref');
  });
});
