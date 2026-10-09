import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Диагностика ограничена фиксированными командами; environment и credentials не читаются.
const output = resolve(process.argv[2] ?? 'temp/macos-runtime-feasibility.json');
const report = {
  schemaVersion: 1, phase: 'compile-export-permissions',
  sourcePin: 'f6217f891ac0bb64f3d375211650a4c1ff8ca1ea',
  platformReadiness: 'NOT_CLAIMED', membership: 'NOT_RUN',
  fullScopeStop: 'NOT_RUN', restart: 'NOT_RUN', staleAfterExec: 'NOT_RUN',
};
function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout, maxBuffer: 64 * 1024 });
  return { status: result.status, signal: result.signal, error: result.error?.code,
    stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
}
if (process.platform !== 'darwin') {
  Object.assign(report, { phaseVerdict: 'NOT_RUN', reason: 'MACOS_REQUIRED' });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'ebb-macos-feasibility-'));
  try {
    report.platform = { osVersion: run('/usr/bin/sw_vers', ['-productVersion']),
      osBuild: run('/usr/bin/sw_vers', ['-buildVersion']), arch: run('/usr/bin/uname', ['-m']),
      sdk: run('/usr/bin/xcrun', ['--show-sdk-version']), compiler: run('/usr/bin/xcrun', ['clang++', '--version']) };
    const source = resolve('scripts/macos-runtime-feasibility.cpp');
    const common = ['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror', source];
    report.publicSDK = run('/usr/bin/xcrun', [...common, '-DEBB_PUBLIC_SDK', '-o', join(temporary, 'public-sdk')]);
    report.publicSDK.verdict = report.publicSDK.status === 0 ? 'PASS' : 'FAIL';
    const binary = join(temporary, 'spi-probe');
    report.spiCompile = run('/usr/bin/xcrun', [...common, '-o', binary]);
    report.spiCompile.verdict = report.spiCompile.status === 0 ? 'PASS' : 'FAIL';
    if (report.spiCompile.status === 0) {
      const probe = run(binary, [], 25_000);
      report.execution = probe;
      try { report.native = JSON.parse(probe.stdout); } catch { report.native = { permissions: 'FAIL', reason: 'INVALID_NATIVE_JSON' }; }
      report.phaseVerdict = probe.status === 0 && report.native.permissions === 'PASS' ? 'PASS' : 'FAIL';
    } else report.phaseVerdict = 'FAIL';
  } finally {
    rmSync(temporary, { recursive: true, force: false });
    report.temporaryCleanup = 'PASS';
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = report.phaseVerdict === 'PASS' ? 0 : 1;
}
