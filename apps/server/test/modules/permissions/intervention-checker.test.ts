import { describe, it, expect } from 'vitest';
import { ActionId, PermissionDecision } from '../../../src/modules/permissions/permission-types.js';
import { InterventionChecker } from '../../../src/modules/permissions/intervention-checker.js';
import { DEFAULT_SECURITY_BLACKLIST } from '../../../src/modules/permissions/default-security-blacklist.js';

const checker = new InterventionChecker();

describe('InterventionChecker', () => {
  describe('каталог по умолчанию', () => {
    const fixture: { id: string; vector: { executable: string; argv: string[] } }[] = [
      { id: 'cmd-rm-recursive-r', vector: { executable: 'rm', argv: ['-r', '--force', 'x'] } },
      { id: 'cmd-rm-recursive-R', vector: { executable: 'rm', argv: ['-R', 'x'] } },
      { id: 'cmd-rm-rf', vector: { executable: 'rm', argv: ['-rf', 'x'] } },
      { id: 'cmd-rm-fr', vector: { executable: 'rm', argv: ['-fr', 'x'] } },
      { id: 'cmd-rm-Rf', vector: { executable: 'rm', argv: ['-Rf', 'x'] } },
      { id: 'cmd-rm-fR', vector: { executable: 'rm', argv: ['-fR', 'x'] } },
      { id: 'cmd-rm-long-recursive', vector: { executable: 'rm', argv: ['--recursive', 'x'] } },
      { id: 'path-etc-passwd', vector: { executable: 'cp', argv: ['/etc/passwd', '/tmp/x'] } },
      { id: 'path-etc-sudoers', vector: { executable: 'tee', argv: ['/etc/sudoers'] } },
      { id: 'cmd-dd-device-output', vector: { executable: 'dd', argv: ['if=/dev/zero', 'of=/dev/sda'] } },
      { id: 'cmd-firewall-iptables', vector: { executable: 'iptables', argv: ['-L', '-n'] } },
      { id: 'cmd-firewall-ip6tables', vector: { executable: 'ip6tables', argv: ['-F'] } },
      { id: 'cmd-firewall-nft', vector: { executable: 'nft', argv: ['list', 'ruleset'] } },
      { id: 'cmd-firewall-ufw', vector: { executable: 'ufw', argv: ['status'] } },
      { id: 'cmd-firewall-cmd', vector: { executable: 'firewall-cmd', argv: ['--state'] } },
    ];

    it.each(fixture)('блокирует $id с ABSOLUTE_DENY и reasonCode', ({ id, vector }) => {
      const result = checker.evaluate(ActionId.CommandExec, vector);
      expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(result.reason).toContain(id);
    });

    it('все ID каталога уникальны и reasonCode равен id', () => {
      const ids = DEFAULT_SECURITY_BLACKLIST.map((rule) => rule.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThan(0);
      for (const rule of DEFAULT_SECURITY_BLACKLIST) {
        expect(rule.reasonCode).toBe(rule.id);
      }
    });
  });

  describe('near misses', () => {
    it('rm -f workspace/tmp не является рекурсивным удалением', () => {
      const result = checker.evaluate(ActionId.CommandExec, { executable: 'rm', argv: ['-f', 'workspace/tmp'] });
      expect(result.decision).toBe(PermissionDecision.ALLOW);
    });

    it('git status не входит в чёрный список', () => {
      const result = checker.evaluate(ActionId.CommandExec, { executable: 'git', argv: ['status'] });
      expect(result.decision).toBe(PermissionDecision.ALLOW);
    });

    it('dd с конкретным устройством of=/dev/sda блокируется как запись в устройство', () => {
      const result = checker.evaluate(ActionId.CommandExec, { executable: 'dd', argv: ['if=/dev/zero', 'of=/dev/sda'] });
      expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(result.reason).toContain('cmd-dd-device-output');
    });

    it('dd c выводом в обычный файл of=/tmp/backup.img не входит в чёрный список', () => {
      const result = checker.evaluate(ActionId.CommandExec, { executable: 'dd', argv: ['if=/dev/zero', 'of=/tmp/backup.img'] });
      expect(result.decision).toBe(PermissionDecision.ALLOW);
    });
  });

  describe('exact matcher', () => {
    const exact = new InterventionChecker([
      { id: 'tiny-exact', action: ActionId.CommandExec, matcher: { type: 'exact', pattern: '["git","status"]' }, reasonCode: 'tiny-exact' },
    ]);

    it('совпадает только при полном равенстве канонической строки', () => {
      expect(exact.evaluate(ActionId.CommandExec, { executable: 'git', argv: ['status'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(exact.evaluate(ActionId.CommandExec, { executable: 'git', argv: ['status', '--short'] }).decision).toBe(PermissionDecision.ALLOW);
      expect(exact.evaluate(ActionId.CommandExec, { executable: 'git', argv: ['statusx'] }).decision).toBe(PermissionDecision.ALLOW);
    });
  });

  describe('prefix matcher', () => {
    const prefix = new InterventionChecker([
      { id: 'tiny-prefix', action: ActionId.CommandExec, matcher: { type: 'prefix', pattern: '["git",' }, reasonCode: 'tiny-prefix' },
    ]);

    it('совпадает с начала канонической строки', () => {
      expect(prefix.evaluate(ActionId.CommandExec, { executable: 'git', argv: ['status'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(prefix.evaluate(ActionId.CommandExec, { executable: 'git', argv: ['fetch'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(prefix.evaluate(ActionId.CommandExec, { executable: 'gitter', argv: ['status'] }).decision).toBe(PermissionDecision.ALLOW);
      expect(prefix.evaluate(ActionId.CommandExec, { executable: 'xgit', argv: ['status'] }).decision).toBe(PermissionDecision.ALLOW);
    });
  });

  describe('wildcard matcher', () => {
    const wc = (pattern: string) => new InterventionChecker([
      { id: 'wc-test', action: ActionId.CommandExec, matcher: { type: 'wildcard', pattern }, reasonCode: 'wc-test' },
    ]);

    it('* покрывает любую последовательность, включая пустую', () => {
      expect(wc('*').evaluate(ActionId.CommandExec, { executable: 'any', argv: ['x'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('["git","a*b"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['acb'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('["git","a*b"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['ab'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('["git","a*b"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['ac'] }).decision).toBe(PermissionDecision.ALLOW);
    });

    it('? совпадает ровно с одним символом', () => {
      expect(wc('["git","sta?s"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['stats'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('["git","sta?s"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['stars'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('["git","sta?s"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['status'] }).decision).toBe(PermissionDecision.ALLOW);
      expect(wc('["git","st?s"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['stas'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('["git","st?s"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['stop'] }).decision).toBe(PermissionDecision.ALLOW);
    });

    it('шаблон якорен к полной строке', () => {
      expect(wc('*"status"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['status'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('*"status"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['fetch'] }).decision).toBe(PermissionDecision.ALLOW);
      expect(wc('["git","status"').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['status'] }).decision).toBe(PermissionDecision.ALLOW);
    });

    it('метасимволы не интерпретируются как регулярное выражение', () => {
      expect(wc('["git","x[1]"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['x[1]'] }).decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(wc('["git","x[1]"]').evaluate(ActionId.CommandExec, { executable: 'git', argv: ['x1'] }).decision).toBe(PermissionDecision.ALLOW);
    });
  });

  describe('нормализация', () => {
    it('basename извлекается по / и \\, ASCII lower-case, без .exe', () => {
      const variants = ['rm', '/usr/bin/rm', 'C:\\Tools\\RM.EXE', 'rm.exe', './rm'];
      for (const executable of variants) {
        const result = checker.evaluate(ActionId.CommandExec, { executable, argv: ['-rf', 'x'] });
        expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
        expect(result.reason).toContain('cmd-rm-rf');
      }
    });

    it('аргументы нормализуются в NFKC', () => {
      const result = checker.evaluate(ActionId.CommandExec, { executable: 'rm', argv: ['－rf', 'x'] });
      expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
      expect(result.reason).toContain('cmd-rm-rf');
    });

    it('NFKC применяется только к проверке: исходный argv не меняется', () => {
      const argv = ['－rf', 'x'];
      checker.evaluate(ActionId.CommandExec, { executable: 'rm', argv });
      expect(argv).toEqual(['－rf', 'x']);
    });
  });

  describe('malformed vectors fail closed', () => {
    const cases: [string, unknown][] = [
      ['undefined', undefined],
      ['null', null],
      ['executable не строка', { executable: 42, argv: [] }],
      ['executable пустая строка', { executable: '', argv: [] }],
      ['argv не массив', { executable: 'rm', argv: '-rf' }],
      ['argv содержит не строку', { executable: 'rm', argv: ['-rf', 7] }],
    ];

    it.each(cases)('%s -> ABSOLUTE_DENY', (_label, args) => {
      const result = checker.evaluate(ActionId.CommandExec, args as never);
      expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
    });

    it('candidate JSON больше 8192 UTF-8 байт блокируется', () => {
      const huge = Array.from({ length: 300 }, () => 'а'.repeat(50));
      const result = checker.evaluate(ActionId.CommandExec, { executable: 'rm', argv: huge });
      expect(result.decision).toBe(PermissionDecision.ABSOLUTE_DENY);
    });

    it('правило неприменимо к не-CommandExec действиям', () => {
      const result = checker.evaluate(ActionId.GitCommit, { executable: 'rm', argv: ['-rf', 'x'] });
      expect(result.decision).toBe(PermissionDecision.ALLOW);
    });
  });

  describe('валидация правил', () => {
    it('отвергает pattern длиннее 256 символов', () => {
      expect(() => new InterventionChecker([
        { id: 'too-long', action: ActionId.CommandExec, matcher: { type: 'prefix', pattern: 'x'.repeat(257) }, reasonCode: 'too-long' },
      ])).toThrow();
    });

    it('отвергает некорректные правила', () => {
      expect(() => new InterventionChecker([
        { id: '', action: ActionId.CommandExec, matcher: { type: 'prefix', pattern: 'a' }, reasonCode: '' },
      ])).toThrow();
      expect(() => new InterventionChecker([
        { id: 'bad-type', action: ActionId.CommandExec, matcher: { type: 'regexp', pattern: 'a' } as never, reasonCode: 'x' },
      ])).toThrow();
    });
  });
});
