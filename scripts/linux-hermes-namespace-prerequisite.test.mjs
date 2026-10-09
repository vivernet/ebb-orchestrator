import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';
import * as yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../.github/workflows/production-gates.yml', import.meta.url), 'utf8'));
const prerequisite = readFileSync(new URL('./linux-hermes-namespace-prerequisite.sh', import.meta.url), 'utf8');
const probe = readFileSync(new URL('./linux-hermes-namespace-probe.cpp', import.meta.url), 'utf8');

test('Linux acceptance proves namespace prerequisites after native build and tears down its profile even on failure', () => {
  const job = workflow.jobs['process-scope-linux-acceptance'];
  const index = (name) => job.steps.findIndex((step) => step.name === name);
  const setup = index('Verify and prepare exact Linux helper user namespace permission');
  const build = index('Build native source-snapshot helpers');
  const acceptance = index('Run native provider-free source-snapshot acceptance');
  const cleanup = index('Remove ephemeral Linux helper AppArmor profiles');
  assert.ok(setup > build && setup < acceptance, 'real namespace probe must follow the build and precede acceptance');
  assert.ok(cleanup > acceptance, 'profile cleanup must follow all native acceptances');
  assert.equal(job.steps[cleanup].if, '${{ always() }}');
  assert.equal(job.steps[setup].run, 'bash scripts/linux-hermes-namespace-prerequisite.sh setup');
  assert.equal(job.steps[cleanup].run, 'bash scripts/linux-hermes-namespace-prerequisite.sh cleanup');
  assert.equal(job['runs-on'], 'ubuntu-24.04');
});

test('namespace diagnostics call the production implementation and retain exact errno before emitting bounded output', () => {
  assert.match(probe, /#include "\.\.\/apps\/server\/native\/linux-hermes-launcher\/ebb-linux-hermes-launcher\.cpp"/u);
  assert.match(probe, /enterPrivateMountNamespace\(getuid\(\), getgid\(\)\);\s+const int failureErrno = failure \? errno : 0;/u);
  assert.match(probe, /HERMES_NATIVE_NAMESPACE_PROBE:%s:ERRNO=%d/u);
  assert.doesNotMatch(probe.replace(/\/\/[^\n]*/gu, ''), /strerror|perror|argv|execve|system\(/u);
  for (const property of ['Type=exec', 'ExitType=cgroup', 'KillMode=control-group', 'Delegate=no', 'ProtectControlGroups=yes', 'Restart=no']) {
    assert.ok(prerequisite.includes(`--property=${property}`));
  }
  assert.match(prerequisite, /systemd-run --user --quiet --wait --pipe --collect/u);
});

test('AppArmor preparation requires observed permission errno and keeps global restrictions and exact attachments', () => {
  assert.match(prerequisite, /GITHUB_ACTIONS:-.*true/u);
  assert.match(prerequisite, /RUNNER_ENVIRONMENT:-.*github-hosted/u);
  assert.match(prerequisite, /GITHUB_EVENT_NAME:-.*push/u);
  assert.match(prerequisite, /probe_status.*70.*before_restriction.*1/u);
  assert.match(prerequisite, /UNSHARE_UNAVAILABLE:ERRNO=\(1\|13\)/u);
  assert.match(prerequisite, /profile ebb-hermes-launcher-.*"\$launcher" flags=\(default_allow\)/u);
  assert.match(prerequisite, /profile ebb-hermes-probe-.*"\$\{state_dir\}\/probe" flags=\(default_allow\)/u);
  assert.match(prerequisite, /\$\(restriction\).*\$before_restriction/u);
  assert.doesNotMatch(prerequisite, /sysctl\s+-w|setcap|chmod\s+[0-9]*[467][0-9]{3}|sudo\s+(systemd-run|.*probe)|flags=\(complain\)/u);
  const profile = prerequisite.slice(prerequisite.indexOf('cat > "$profile_file" <<EOF'), prerequisite.indexOf('\nEOF'));
  assert.equal((profile.match(/userns,/gu) ?? []).length, 2);
  assert.doesNotMatch(profile, /\*|\?|capability|mount,/u);
});

test('prerequisite cleanup validates private canonical state and unloads profiles before deleting their exact files', () => {
  assert.match(prerequisite, /runner_temp.*!= \/ /u);
  assert.match(prerequisite, /repository_root.*!= \/ /u);
  assert.match(prerequisite, /realpath -e -- "\$state_dir".*== "\$state_dir"/u);
  assert.match(prerequisite, /stat -c '%u:%a'.*state_dir.*== "\$\(id -u\):700"/u);
  assert.match(prerequisite, /stat -c '%u:%a'.*profile_file.*== "\$\(id -u\):600"/u);
  assert.ok(prerequisite.indexOf('sudo apparmor_parser -R "$profile_file"') < prerequisite.indexOf('rm -f -- "$profile_file"'));
  assert.match(prerequisite, /trap cleanup EXIT/u);
  assert.match(prerequisite, /profile-load-attempted/u);
  assert.doesNotMatch(prerequisite, /rm\s+-[a-zA-Z]*r|\/etc\/apparmor|\bkillall\b|\bpkill\b/u);
});

function runProbeWithManagerResult(showOutput, showStatus, stopStatus = 1) {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  assert.ok(existsSync(bash), 'behavioral shell contracts require Git Bash on Windows or /bin/bash on Linux');
  const start = prerequisite.indexOf('run_probe() {');
  const end = prerequisite.indexOf('\n}\n\nrun_probe', start) + 2;
  assert.ok(start >= 0 && end > start, 'extract the actual prerequisite function');
  const harness = `set -euo pipefail
GITHUB_RUN_ID=123
GITHUB_RUN_ATTEMPT=1
state_dir="$(mktemp -d)"
trap 'rm -f -- "$state_dir/probe-output"; rmdir -- "$state_dir"' EXIT
fail() { printf '%s\\n' "$1" >&2; exit 1; }
systemd-run() { printf 'HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0\\n'; return 0; }
systemctl() {
  if [[ "$2" == show ]]; then
    printf '%s' '${showOutput}'; return ${showStatus};
  fi
  printf 'fixture raw bus failure\\n' >&2
  return ${stopStatus}
}
sleep() { :; }
${prerequisite.slice(start, end)}
run_probe
`;
  return spawnSync(bash, ['--noprofile', '--norc', '-c', harness], {
    encoding: 'utf8', shell: false, timeout: 5_000,
  });
}

test('native probe PASS cannot turn a failed manager query into removal proof', () => {
  for (const output of ['', 'not-found']) {
    const result = runProbeWithManagerResult(output, 1);
    assert.equal(result.status, 1, 'nonzero show exit must reject even apparent not-found output');
    assert.match(result.stderr, /^HERMES_NAMESPACE_SETUP_PROBE_UNIT_NOT_REMOVED\s*$/u);
    assert.doesNotMatch(result.stderr, /fixture raw bus failure/u);
  }
});

test('successful manager query with empty LoadState cannot prove removal', () => {
  const result = runProbeWithManagerResult('', 0);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^HERMES_NAMESPACE_SETUP_PROBE_UNIT_NOT_REMOVED\s*$/u);
});

test('successful explicit not-found proves auto-collected probe removal despite stop/reset misses', () => {
  const result = runProbeWithManagerResult('not-found', 0);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0\n');
});
