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

function policyFixture(code) {
  const start = prerequisite.indexOf('# BEGIN CI_POLICY_PYTHON');
  const end = prerequisite.indexOf('# END CI_POLICY_PYTHON');
  assert.ok(start >= 0 && end > start, 'actual authenticated package/policy preflight must exist');
  const source = prerequisite.slice(start, end).replace("if __name__ == '__main__':", 'if False:');
  return spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-c', `${source}\n${code}`], {
    encoding: 'utf8', shell: false, timeout: 5_000,
  });
}

test('privileged policy loading uses validated immutable stdin and never attaches the system executor', () => {
  assert.doesNotMatch(prerequisite, /executor = '\/usr\/lib\/systemd\/systemd-executor'/u);
  assert.doesNotMatch(prerequisite, /apparmor_parser', '-a', file/u);
  assert.match(prerequisite, /input=policy/u);
  assert.match(prerequisite, /--skip-kernel-load/u);
  assert.match(prerequisite, /raw_sha256/u);
});

test('cleanup validates live policy evidence before claiming retained-profile teardown', () => {
  const start = prerequisite.indexOf('cleanup() {');
  const end = prerequisite.indexOf('\n}\n', start);
  const cleanup = prerequisite.slice(start, end);
  assert.ok(cleanup.includes('verify_policy_evidence'));
  assert.ok(cleanup.indexOf('verify_policy_evidence') < cleanup.indexOf('OWNED_SCOPE_TEARDOWN=VERIFIED'));
});

test('negative namespace control stays unprofiled after exact profile loading', () => {
  assert.match(prerequisite, /run_probe --negative-control/u);
  assert.match(prerequisite, /HERMES_NAMESPACE_SETUP_NEGATIVE_CONTROL_UNEXPECTED/u);
});

test('authority failures report a bounded exact phase and sanitized error without raw stderr', () => {
  assert.match(prerequisite, /PHASE=/u);
  const result = policyFixture(String.raw`
import contextlib, io
for phase in ['SNAPSHOT', 'PARSER_PREFLIGHT', 'PARSER_ADD']:
    subprocess.run = lambda *args, **kwargs: type('Result', (), {'returncode': 1, 'stdout': b'',
      'stderr': b'private-path secret-value\nValueError: HERMES_SNAPSHOT_RAW_HASH_LINK_INVALID:ERRNO=0\n'})()
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stderr(stderr): command(['fixture'], phase=phase)
    except Refusal as error:
        message = str(error)
        assert 'PHASE='+phase in message and 'EXIT=1' in message
        assert 'private-path' not in message+stderr.getvalue() and 'secret-value' not in message+stderr.getvalue()
        if phase == 'SNAPSHOT': assert 'DETAIL=RAW_HASH_LINK_INVALID:ERRNO=0' in message
    else: raise AssertionError('failed authority command accepted')
assert authority_detail('SNAPSHOT', b'ValueError: HERMES_SNAPSHOT_READ_PROFILE_SHA256_INVALID:ERRNO=0\n') == 'READ_PROFILE_SHA256_INVALID:ERRNO=0'
assert authority_detail('SNAPSHOT', b'ValueError: HERMES_SNAPSHOT_READ_NS_LEVEL_UNAVAILABLE:ERRNO=2\n') == 'READ_NS_LEVEL_UNAVAILABLE:ERRNO=2'
for raw in [b'secret-value\x1b[31m', b'a'*65537, b'HERMES_SNAPSHOT_PRIVATE_PATH:ERRNO=0\n']:
    detail = authority_detail('SNAPSHOT', raw)
    assert detail in ['UNCLASSIFIED:ERRNO=0', 'DIAGNOSTIC_UNAVAILABLE:ERRNO=0']
subprocess.run = lambda *args, **kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired('private-path', 120, stderr=b'secret-value'))
try: command(['fixture'], phase='PARSER_PREFLIGHT')
except Refusal as error:
    assert str(error) == 'HERMES_NAMESPACE_SETUP_AUTHORITY_COMMAND_FAILED:PHASE=PARSER_PREFLIGHT:EXIT=TIMEOUT:DETAIL=TIMEOUT:ERRNO=0'
else: raise AssertionError('timeout accepted')
`);
  assert.equal(result.status, 0, result.stderr);
});

test('actual embedded SNAPSHOT reads nested profile raw hashes with exact link depth and rejects malformed reads and revision races', () => {
  const result = policyFixture(String.raw`
import contextlib, io, types
original_os = sys.modules['os']
base = '/sys/kernel/security/apparmor'
parent = base+'/policy/profiles/parent.1'
child = parent+'/profiles/child.2'
class Entry:
    def __init__(self, path): self.path = path
    def is_dir(self, follow_symlinks):
        assert follow_symlinks is False
        return True
def execute_snapshot(override=None, revision_race=False, raw_hash=False, raw_target=None, magic_policy=False, nested_raw_hash=False):
    files = {base+'/.ns_level': b'0\n', base+'/.ns_name': b'root\n',
             base+'/.ns_stacked': b'no\n', base+'/.stacked': b'no\n', base+'/revision': b'7\n',
             parent+'/name': b'parent\n', parent+'/attach': b'/usr/bin/parent\n', parent+'/sha256': b'a'*64+b'\n',
             child+'/name': b'child\n', child+'/attach': b'child\n', child+'/sha256': b'b'*64+b'\n'}
    raw_path = base+'/policy/raw_data/17/sha256'
    raw_owner = child if nested_raw_hash else parent
    valid_link = '../../../../raw_data/17/sha256' if nested_raw_hash else '../../raw_data/17/sha256'
    if raw_hash: files[raw_path] = b'c'*64+b'\n'
    if override: files.update(override)
    directories = {base+'/policy/profiles': [Entry(parent)], parent+'/profiles': [Entry(child)]}
    descriptors, reads = {}, []
    seam = types.ModuleType('os')
    # Synthetic syscall constants also work on Windows, which has no O_NOFOLLOW.
    for flag, value in [('O_RDONLY', 0), ('O_NOFOLLOW', 131072), ('O_NONBLOCK', 2048)]: setattr(seam, flag, value)
    def open_fixture(path, flags):
        assert path in files and flags == seam.O_RDONLY | seam.O_NOFOLLOW | seam.O_NONBLOCK
        descriptor = len(reads)+100
        descriptors[descriptor] = path
        return descriptor
    def read_fixture(descriptor, limit):
        assert limit == 8192
        path = descriptors[descriptor]
        value = files[path]
        if path == base+'/revision' and revision_race and path in reads: value = b'8\n'
        reads.append(path)
        return value
    seam.open, seam.read, seam.close = open_fixture, read_fixture, lambda descriptor: descriptors.pop(descriptor)
    seam.scandir = lambda path: directories[path]
    seam.path = types.SimpleNamespace(exists=lambda path: path in directories or (raw_hash and path == raw_owner+'/raw_sha256'),
                                     realpath=lambda path: base+'/apparmorfs:[123]/raw_data/17/sha256' if magic_policy else raw_target or raw_path)
    def readlink_fixture(path):
        assert path == raw_owner+'/raw_sha256'
        target = raw_target or valid_link
        reads.append('LINK='+target)
        return target
    seam.readlink = readlink_fixture
    output = io.StringIO()
    sys.modules['os'] = seam
    try:
        with contextlib.redirect_stdout(output): exec(SNAPSHOT, {})
    finally: sys.modules['os'] = original_os
    assert not descriptors
    return json.loads(output.getvalue()), reads
snapshot_result, reads = execute_snapshot()
assert snapshot_result == {'namespace': 'root', 'revision': 7, 'profiles': {
    'parent': {'attach': '/usr/bin/parent', 'hash': 'a'*64},
    'parent//child': {'attach': 'child', 'hash': 'b'*64}}}
assert reads.count(base+'/revision') == 2 and child+'/attach' in reads
snapshot_result, raw_reads = execute_snapshot(raw_hash=True)
assert snapshot_result['profiles']['parent']['raw_sha256'] == 'c'*64
assert base+'/policy/raw_data/17/sha256' in raw_reads
snapshot_result, _ = execute_snapshot(raw_hash=True, magic_policy=True)
assert snapshot_result['profiles']['parent']['raw_sha256'] == 'c'*64
snapshot_result, nested_reads = execute_snapshot(raw_hash=True, magic_policy=True, nested_raw_hash=True)
assert snapshot_result['profiles']['parent//child'] == {'attach': 'child', 'hash': 'b'*64, 'raw_sha256': 'c'*64}
assert 'raw_sha256' not in snapshot_result['profiles']['parent']
assert 'LINK=../../../../raw_data/17/sha256' in nested_reads
assert nested_reads.count(base+'/policy/raw_data/17/sha256') == 1
for wrong_depth in ['../../raw_data/17/sha256', '../../../../../../raw_data/17/sha256']:
    try: execute_snapshot(raw_hash=True, nested_raw_hash=True, raw_target=wrong_depth)
    except ValueError as error:
        assert str(error) == 'HERMES_SNAPSHOT_RAW_HASH_LINK_INVALID:ERRNO=0'
        continue
    raise AssertionError('nested raw hash accepted wrong relative depth')
for raw_target in ['/private/sha256', '../../raw_data/17/other', '../../raw_data/x/../sha256',
                   '../../raw_data/17/sha256\n', '../../../../raw_data/17/sha256']:
    try: execute_snapshot(raw_hash=True, raw_target=raw_target)
    except ValueError: continue
    raise AssertionError('out-of-bound raw hash path accepted')
try: execute_snapshot({base+'/policy/raw_data/17/sha256': b'invalid\n'}, raw_hash=True)
except ValueError: pass
else: raise AssertionError('malformed raw hash accepted')
for invalid in [b'', b'x'*8192, b'parent\nother\n', b'parent\x00\n', b'\xff\n']:
    try: execute_snapshot({parent+'/name': invalid})
    except (ValueError, UnicodeDecodeError): continue
    raise AssertionError('malformed or truncated field accepted')
try: execute_snapshot(revision_race=True)
except ValueError as error: assert str(error) == 'race'
else: raise AssertionError('revision race accepted')
`);
  assert.equal(result.status, 0, result.stderr);
});

test('actual loaded attachments reject same targets across names, unknown and unproven AARE overlap', () => {
  const result = policyFixture(`
targets = {'ours': '/ci/run-123/helper'}
for attachment in ['/ci/run-123/helper', '<unknown>', '/ci/{run-123,other}/**', '/**', '/ci/run-123/*']:
    try:
        check_attachments({'foreign': {'attach': attachment, 'hash': 'a'*64}}, targets)
    except Refusal:
        continue
    raise AssertionError(attachment)
check_attachments({'foreign': {'attach': '/usr/bin/chromium*', 'hash': 'a'*64}}, targets)
`);
  assert.equal(result.status, 0, result.stderr);
});

test('postload requires exact owned additions and rejects changed foreign policy or revision gap', () => {
  const result = policyFixture(`
before = {'namespace': 'root', 'revision': 7, 'profiles': {'old': {'attach': '/usr/bin/old', 'hash': 'a'*64}}}
after = {'namespace': 'root', 'revision': 8, 'profiles': {**before['profiles'], 'ours': {'attach': '/ci/run-123/helper', 'hash': 'b'*64, 'raw_sha256': 'c'*64}}}
check_change(before, after, 'ours', '/ci/run-123/helper', 'c'*64)
for bad in [dict(after, revision=9), dict(after, namespace='other'), dict(after, profiles={'ours': after['profiles']['ours']})]:
    try: check_change(before, bad, 'ours', '/ci/run-123/helper', 'c'*64)
    except Refusal: continue
    raise AssertionError('policy race accepted')
`);
  assert.equal(result.status, 0, result.stderr);
});

const contextLine = 'HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=UNCONFINED:AFTER=EXPECTED_PROFILE:NNP=0:SECCOMP=0';

test('actual prepare preflights and loads identical stdin bytes and binds exact binary kernel readback', () => {
  const result = policyFixture(String.raw`
import copy, tempfile
from pathlib import Path
targets = {'ebb-hermes-launcher-123-1': '/ci/run-123/launcher', 'ebb-hermes-probe-123-1': '/ci/run-123/probe'}
profile_targets = lambda *args: targets
helper_identity = lambda *args: {'dev': 1, 'ino': 2, 'sha256': 'a'*64}
for fixture in ['pass', 'preflight-failed', 'wrong-binary', 'foreign-change']:
    current = {'namespace': 'root', 'revision': 7, 'profiles': {'old': {'attach': '/usr/bin/old', 'hash': 'a'*64}}}
    calls = []
    snapshot = lambda: copy.deepcopy(current)
    def parser(args, **kwargs):
        policy = kwargs['input']
        assert args[:3] == ['sudo', '-n', 'apparmor_parser']
        assert kwargs['capture_output'] and kwargs['timeout'] == 120 and kwargs['check'] is False
        assert isinstance(policy, bytes) and '--skip-cache' in args
        assert len(args) == (6 if '--skip-kernel-load' in args else 5), 'no pathname argument may be reopened'
        calls.append((args, policy))
        name = policy.decode().split('profile ', 1)[1].split(' ', 1)[0]
        assert policy == policy_bytes(name, targets[name])
        binary = b'compiled-policy:'+policy
        if '--skip-kernel-load' in args:
            assert '--stdout' in args
            return type('Result', (), {'returncode': 1 if fixture == 'preflight-failed' else 0, 'stdout': binary})()
        assert args[-2:] == ['--add', '--skip-cache']
        assert policy is calls[-2][1], 'same immutable bytes object reaches privileged add'
        current['revision'] += 1
        current['profiles'][name] = {'attach': targets[name], 'hash': 'b'*64,
                                    'raw_sha256': 'c'*64 if fixture == 'wrong-binary' else hashlib.sha256(binary).hexdigest()}
        if fixture == 'foreign-change': current['profiles']['old']['hash'] = 'd'*64
        return type('Result', (), {'returncode': 0, 'stdout': b''})()
    subprocess.run = parser
    with tempfile.TemporaryDirectory() as directory:
        try: prepare(directory, '/ci/run-123/launcher', '123', '1')
        except Refusal:
            assert fixture != 'pass'
            assert not Path(directory, 'policy-evidence.json').exists()
            assert not list(Path(directory).glob('*.loaded'))
            if fixture == 'preflight-failed': assert len(calls) == 1
        else:
            assert fixture == 'pass' and len(calls) == 4
            evidence = json.loads(Path(directory, 'policy-evidence.json').read_text())
            assert evidence['after'] == current and set(evidence['owned']) == set(targets)
            assert len(list(Path(directory).glob('*.owned'))) == 2
        assert not list(Path(directory).glob('*.profile'))
`);
  assert.equal(result.status, 0, result.stderr);
});

test('policy source rejects name and path injection and leaves negative control unattached', () => {
  const result = policyFixture(String.raw`
name = 'ebb-hermes-probe-123-1'
assert policy_bytes(name, '/ci/run-123/probe') == b'abi <abi/4.0>,\nprofile ebb-hermes-probe-123-1 "/ci/run-123/probe" flags=(default_allow) {\n  userns,\n}\n'
for invalid_name, path in [(name+'\nprofile attack', '/ci/probe'), ('ebb-hermes-executor-123-1', '/ci/probe'),
                           (name, '/ci/probe" {}'), (name, '/ci/**'), (name, '/ci/../probe'), (name, '/ci//probe')]:
    try: policy_bytes(invalid_name, path)
    except Refusal: continue
    raise AssertionError('policy injection accepted')
targets = profile_targets('/ci/run-123', '/ci/run-123/launcher', '123', '1')
assert set(targets.values()) == {'/ci/run-123/launcher', '/ci/run-123/probe'}
assert '/ci/run-123/negative-probe' not in targets.values()
`);
  assert.equal(result.status, 0, result.stderr);
});

test('actual evidence validation recompiles expected bytes and rejects stale foreign owned or forged digest state', () => {
  const result = policyFixture(String.raw`
import copy
targets = {'ebb-hermes-launcher-123-1': '/ci/run-123/launcher', 'ebb-hermes-probe-123-1': '/ci/run-123/probe'}
compile_policy = lambda policy: hashlib.sha256(b'compiled:'+policy).hexdigest()
before = {'namespace': 'root', 'revision': 7, 'profiles': {'old': {'attach': '/usr/bin/old', 'hash': 'a'*64}}}
after = copy.deepcopy(before)
owned = {}
for name, target in targets.items():
    policy = policy_bytes(name, target)
    digest = compile_policy(policy)
    after['profiles'][name] = {'attach': target, 'hash': 'b'*64, 'raw_sha256': digest}
    owned[name] = {'source_sha256': hashlib.sha256(policy).hexdigest(), 'binary_sha256': digest}
after['revision'] += 2
evidence = {'schema': 1, 'before': before, 'after': after, 'owned': owned,
            'helper': {'dev': 1, 'ino': 2, 'sha256': 'a'*64}}
verify_evidence(evidence, copy.deepcopy(after), targets)
for fixture in ['schema', 'extra-owned', 'source-digest', 'binary-digest', 'attachment', 'foreign', 'revision', 'live-change', 'missing-owned']:
    changed, current = copy.deepcopy(evidence), copy.deepcopy(after)
    name = next(iter(targets))
    if fixture == 'schema': changed['schema'] = 2
    if fixture == 'extra-owned': changed['owned']['foreign'] = {}
    if fixture == 'missing-owned': del changed['owned'][name]
    if fixture == 'source-digest': changed['owned'][name]['source_sha256'] = 'c'*64
    if fixture == 'binary-digest':
        changed['owned'][name]['binary_sha256'] = 'c'*64
        changed['after']['profiles'][name]['raw_sha256'] = 'c'*64
        current = copy.deepcopy(changed['after'])
    if fixture == 'attachment': changed['after']['profiles'][name]['attach'] = '/ci/other'
    if fixture == 'foreign': changed['after']['profiles']['old']['hash'] = 'c'*64
    if fixture == 'revision': changed['after']['revision'] += 1
    if fixture == 'live-change': current['profiles']['old']['hash'] = 'c'*64
    try: verify_evidence(changed, current, targets)
    except Refusal: continue
    raise AssertionError(fixture)
`);
  assert.equal(result.status, 0, result.stderr);
});

test('actual helper identity binds bounded regular nofollow bytes to the generated first-party anchor', () => {
  const result = policyFixture(String.raw`
import types
launcher = '/ci/run-123/apps/server/dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher'
identity = {'dev': 1, 'ino': 2, 'sha256': hashlib.sha256(b'helper').hexdigest()}
valid_anchor = ('export const NATIVE_HELPER_INTEGRITY_ANCHOR = Object.freeze('+json.dumps({'linuxHermesLauncher': identity['sha256']})+');\n').encode()
anchor = valid_anchor
os.path.realpath = lambda path: path
def regular(path, limit):
    assert limit == (16*1024*1024 if path == launcher else 8192)
    return (b'helper', identity) if path == launcher else (anchor, {})
original_regular = read_regular
read_regular = regular
assert helper_identity(launcher) == identity
for invalid in [valid_anchor.replace(identity['sha256'].encode(), b'a'*64), b'export {};\n', valid_anchor+b'evil()']:
    anchor = invalid
    try: helper_identity(launcher)
    except Refusal: continue
    raise AssertionError('invalid built helper anchor accepted')
read_regular = original_regular
os.O_NOFOLLOW = 131072
os.O_NONBLOCK = 2048
meta = lambda **change: types.SimpleNamespace(**{'st_mode': stat.S_IFREG, 'st_dev': 1, 'st_ino': 2,
    'st_size': 6, 'st_mtime_ns': 3, 'st_ctime_ns': 4, **change})
for fixture in ['pass', 'changed-fd', 'changed-link', 'symlink', 'over-bound', 'truncated']:
    reads, stats, closed = [], [], []
    def open_fixture(path, flags):
        assert path == launcher and flags == os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        return 42
    def fstat_fixture(fd):
        assert fd == 42
        stats.append(fd)
        return meta(st_ino=9) if fixture == 'changed-fd' and len(stats) == 2 else meta(st_size=8) if fixture == 'over-bound' else meta()
    def read_fixture(fd, limit):
        assert fd == 42 and 0 < limit <= 7
        reads.append(fd)
        return (b'help' if fixture == 'truncated' else b'helper') if len(reads) == 1 else b''
    os.open, os.fstat, os.read = open_fixture, fstat_fixture, read_fixture
    os.stat = lambda *args, **kwargs: meta(st_ino=9) if fixture == 'changed-link' else meta(st_mode=stat.S_IFLNK) if fixture == 'symlink' else meta()
    os.close = lambda fd: closed.append(fd)
    try: data, result = read_regular(launcher, 6)
    except Refusal: assert fixture != 'pass'
    else: assert fixture == 'pass' and data == b'helper' and result == identity
    assert closed == [42]
`);
  assert.equal(result.status, 0, result.stderr);
});

test('actual evidence reader refuses symlinks malformed oversized empty and changed-helper evidence', () => {
  const result = policyFixture(String.raw`
import types
launcher, state = '/ci/run-123/launcher', '/ci/run-123'
identity = {'dev': 1, 'ino': 2, 'sha256': 'a'*64}
os.O_NOFOLLOW, os.O_NONBLOCK = 131072, 2048
helper_identity = lambda path: identity
snapshot = lambda: {'live': True}
profile_targets = lambda *args: {'target': launcher}
for fixture in ['pass', 'symlink', 'malformed', 'oversized', 'empty', 'not-regular', 'changed-helper']:
    validated, closed = [], []
    evidence = {'helper': dict(identity, ino=9) if fixture == 'changed-helper' else identity}
    data = json.dumps(evidence).encode()
    if fixture == 'malformed': data = b'{'
    if fixture == 'empty': data = b''
    if fixture == 'oversized': data = b'a'*(8*1024*1024+1)
    def open_fixture(path, flags):
        assert path.endswith('policy-evidence.json') and flags == os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        if fixture == 'symlink': raise OSError('nofollow')
        return 42
    os.open = open_fixture
    os.fstat = lambda fd: types.SimpleNamespace(st_mode=stat.S_IFDIR if fixture == 'not-regular' else stat.S_IFREG)
    def read_fixture(fd, limit):
        assert fd == 42 and limit == 8*1024*1024+1
        return data
    os.read, os.close = read_fixture, lambda fd: closed.append(fd)
    verify_evidence = lambda parsed, current, targets: validated.append((parsed, current, targets))
    try: verify(state, launcher, '123', '1')
    except (Refusal, OSError, ValueError): assert fixture != 'pass'
    else: assert fixture == 'pass' and validated == [(evidence, {'live': True}, {'target': launcher})]
    assert closed == ([] if fixture == 'symlink' else [42])
    assert bool(validated) == (fixture == 'pass')
`);
  assert.equal(result.status, 0, result.stderr);
});

test('actual setup requires positive exact labels and a separate namespace-denied negative control', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const start = prerequisite.indexOf('\nrun_probe\nif');
  assert.ok(start >= 0);
  for (const fixture of ['pass', 'restricted-pass', 'negative-baseline-label-change', 'negative-pass', 'negative-profile', 'negative-errno', 'positive-label', 'restriction-changed']) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `set -euo pipefail
calls=0
before_restriction=1
fail() { printf '%s\\n' "$1" >&2; exit 1; }
prepare_application_profiles() { :; }
verify_policy_evidence() { :; }
restriction() { [[ "$FIXTURE" == restriction-changed && "$calls" -ge 3 ]] && printf 0 || printf 1; }
cat() { printf Y; }
apparmor_parser() { :; }
run_probe() {
  calls=$((calls+1))
  probe_status=70
  probe_result=HERMES_NATIVE_NAMESPACE_PROBE:HERMES_PRIVATE_NAMESPACE_UNSHARE_UNAVAILABLE:ERRNO=13
  probe_context=HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=UNCONFINED:AFTER=UNCONFINED:NNP=0:SECCOMP=0
  if [[ "$FIXTURE" == restricted-pass ]]; then probe_context=HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=RESTRICTED_USERNS:AFTER=RESTRICTED_USERNS:NNP=0:SECCOMP=0; fi
  if [[ "$calls" == 2 ]]; then
    [[ "$#" == 0 ]] || fail POSITIVE_MODE_INVALID
    probe_status=0
    probe_result=HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0
    [[ "$FIXTURE" == positive-label ]] || probe_context=HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=EXPECTED_PROFILE:AFTER=EXPECTED_PROFILE:NNP=0:SECCOMP=0
  fi
  if [[ "$calls" == 3 ]]; then
    [[ "$#" == 1 && "$1" == --negative-control ]] || fail NEGATIVE_MODE_INVALID
    if [[ "$FIXTURE" == negative-pass ]]; then probe_status=0; probe_result=HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0; fi
    if [[ "$FIXTURE" == negative-profile ]]; then probe_context=HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=EXPECTED_PROFILE:AFTER=EXPECTED_PROFILE:NNP=0:SECCOMP=0; fi
    if [[ "$FIXTURE" == negative-baseline-label-change ]]; then probe_context=HERMES_NATIVE_NAMESPACE_CONTEXT:BEFORE=RESTRICTED_USERNS:AFTER=RESTRICTED_USERNS:NNP=0:SECCOMP=0; fi
    if [[ "$FIXTURE" == negative-errno ]]; then probe_result=HERMES_NATIVE_NAMESPACE_PROBE:HERMES_PRIVATE_NAMESPACE_UNSHARE_UNAVAILABLE:ERRNO=5; fi
  fi
}
${prerequisite.slice(start)}
`], { encoding: 'utf8', shell: false, timeout: 5_000, env: { ...process.env, FIXTURE: fixture } });
    const expected = ['pass', 'restricted-pass'].includes(fixture) ? 0 : 1;
    assert.equal(result.status, expected, `${fixture}: ${result.stderr}`);
    if (expected === 0) assert.match(result.stdout, /SCOPED_APPARMOR_PROFILE=VERIFIED/u);
    else assert.doesNotMatch(result.stdout, /SCOPED_APPARMOR_PROFILE=VERIFIED/u);
  }
});

function validateOutput(output) {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const start = prerequisite.indexOf('validate_probe_output() {');
  const end = prerequisite.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start, 'production parser must validate bounded context and exact result');
  return spawnSync(bash, ['--noprofile', '--norc', '-c', `set -euo pipefail
fail() { printf '%s\\n' "$1" >&2; exit 1; }
${prerequisite.slice(start, end)}
probe_output="$FIXTURE_OUTPUT"
validate_probe_output
`], { encoding: 'utf8', shell: false, timeout: 5_000, env: { ...process.env, FIXTURE_OUTPUT: output } });
}

test('bounded namespace context accepts fixed labels and numeric flags while rejecting raw or extra output', () => {
  const valid = `${contextLine}\nHERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0`;
  assert.equal(validateOutput(valid).status, 0);
  for (const failure of ['UNAVAILABLE', 'LABEL_MISMATCH']) {
    assert.equal(validateOutput(`${contextLine}\nHERMES_NATIVE_NAMESPACE_PROBE:HERMES_APPARMOR_PROFILE_TRANSITION_${failure}:ERRNO=13`).status, 0);
  }
  for (const invalid of [valid + '\nprivate-path', valid.replace('NNP=0', 'NNP=2'),
    valid.replace('SECCOMP=0', 'SECCOMP=3'), valid.replace('BEFORE=UNCONFINED', 'BEFORE=/private/path'),
    valid.replace('PASS:ERRNO=0', 'UNKNOWN:ERRNO=0')]) {
    const result = validateOutput(invalid);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^HERMES_NAMESPACE_SETUP_PROBE_OUTPUT_INVALID\s*$/u);
  }
});

test('probe preserves errno and exact application transition cannot mutate global policy', () => {
  assert.match(probe, /PR_GET_NO_NEW_PRIVS/u);
  assert.match(probe, /PR_GET_SECCOMP/u);
  assert.match(probe, /EBB_NAMESPACE_PROBE_PROFILE_NAME/u);
  assert.ok(probe.indexOf('const int failureErrno') < probe.indexOf('const char* afterLabel'));
  assert.doesNotMatch(probe, /PR_SET_|aa_change_onexec|setns\(/u);
  assert.match(probe, /aa_change_profile\(EBB_NAMESPACE_PROBE_PROFILE_NAME\)/u);
  assert.match(probe, /argc != 1 && !applyExactProfile/u);
  assert.match(probe, /std::string\(argv\[1\]\) == "--apply-exact-profile"/u);
  assert.match(prerequisite, /prepare_application_profiles/u);
  assert.doesNotMatch(prerequisite, /HERMES_NATIVE_NAMESPACE_DIRECT_CONTROL/u);
});

test('Linux acceptance records success after all native gates and always verifies retained-lease teardown', () => {
  const job = workflow.jobs['process-scope-linux-acceptance'];
  const index = (name) => job.steps.findIndex((step) => step.name === name);
  const setup = index('Verify and prepare exact Linux helper user namespace permission');
  const build = index('Build native source-snapshot helpers');
  const acceptance = index('Run native provider-free source-snapshot acceptance');
  const cleanup = index('Verify Linux owned-scope teardown and retain profiles until runner disposal');
  assert.ok(setup > build && setup < acceptance, 'real namespace probe must follow the build and precede acceptance');
  assert.ok(cleanup > acceptance, 'profile cleanup must follow all native acceptances');
  assert.ok(index('Record successful Linux owned-scope acceptances') > acceptance);
  assert.ok(index('Record successful Linux owned-scope acceptances') < cleanup);
  assert.equal(job.steps[setup].id, 'linux-namespace-setup');
  assert.equal(job.steps.filter((step) => step.id === 'linux-namespace-setup').length, 1);
  assert.equal(job.steps[cleanup].if, "${{ always() && steps.linux-namespace-setup.outcome != 'skipped' }}");
  assert.equal(job.steps[setup].run, 'bash scripts/linux-hermes-namespace-prerequisite.sh setup');
  assert.equal(job.steps[cleanup].run, 'bash scripts/linux-hermes-namespace-prerequisite.sh cleanup');
  assert.equal(job['runs-on'], 'ubuntu-24.04');
});

test('actual retained-lease cleanup rejects unknown queries, live owned units, missing acceptance and partial ownership', () => {
  const start = prerequisite.indexOf('cleanup() {');
  const end = prerequisite.indexOf('\n}\n', start) + 2;
  assert.ok(start >= 0 && end > start);
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  for (const [fixture, expected] of [
    ['pass', 0], ['list-failed', 1], ['live', 1], ['show-failed', 1], ['empty', 1], ['missing-acceptance', 1], ['partial', 1], ['policy-invalid', 1], ['restriction-changed', 1],
  ]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `set -euo pipefail
GITHUB_RUN_ID=123
GITHUB_RUN_ATTEMPT=1
state_dir="$(mktemp -d)"
trap 'rm -f -- "$state_dir/acceptance-completed" "$state_dir/probe-units" "$state_dir"/ebb-hermes-{launcher,probe}-123-1.{attempted,loaded,owned}; rmdir -- "$state_dir"' EXIT
[[ "$FIXTURE" == missing-acceptance ]] || touch "$state_dir/acceptance-completed"
touch "$state_dir"/ebb-hermes-{launcher,probe}-123-1.{attempted,loaded,owned}
[[ "$FIXTURE" != partial ]] || rm -f -- "$state_dir/ebb-hermes-launcher-123-1.owned"
printf '%s\\n' 'ebb-hermes-userns-probe-123-1-42.service' > "$state_dir/probe-units"
fail() { printf '%s\\n' "$1" >&2; exit 1; }
systemctl() {
  if [[ "$2" == list-units ]]; then
    [[ "$FIXTURE" != live ]] || printf '%s\\n' 'ebb-orchestrator-run-fixture.service loaded active running'
    [[ "$FIXTURE" != list-failed ]]; return
  fi
  [[ "$FIXTURE" == empty ]] || printf '%s' 'not-found'
  [[ "$FIXTURE" != show-failed ]]
}
verify_policy_evidence() { [[ "$FIXTURE" != policy-invalid ]]; }
cat() { [[ "$FIXTURE" == restriction-changed ]] && printf 0 || printf 1; }
${prerequisite.slice(start, end)}
cleanup
`], { encoding: 'utf8', shell: false, timeout: 5_000, env: { ...process.env, FIXTURE: fixture } });
    assert.equal(result.status, expected, `${fixture}: ${result.stderr}`);
    if (expected === 0) assert.match(result.stdout, /OWNED_SCOPE_TEARDOWN=VERIFIED/u);
    else assert.doesNotMatch(result.stdout, /OWNED_SCOPE_TEARDOWN=VERIFIED/u);
  }
});

test('namespace diagnostics call the production implementation and retain exact errno before emitting bounded output', () => {
  assert.match(probe, /#include "\.\.\/apps\/server\/native\/linux-hermes-launcher\/ebb-linux-hermes-launcher\.cpp"/u);
  assert.match(probe, /enterPrivateMountNamespace\(getuid\(\), getgid\(\)\);\s+const int failureErrno = failure \? errno : 0;/u);
  assert.match(probe, /HERMES_NATIVE_NAMESPACE_PROBE:%s:ERRNO=%d/u);
  assert.doesNotMatch(probe.replace(/\/\/[^\n]*/gu, ''), /strerror|perror|execve|system\(/u);
  for (const property of ['Type=exec', 'ExitType=cgroup', 'KillMode=control-group', 'Delegate=no', 'ProtectControlGroups=yes', 'Restart=no']) {
    assert.ok(prerequisite.includes(`--property=${property}`));
  }
  assert.match(prerequisite, /systemd-run --user --quiet --wait --pipe --collect/u);
});

test('application profiles keep exact target names and global restrictions, without host permission predicates', () => {
  assert.match(prerequisite, /GITHUB_EVENT_NAME:-.*push/u);
  assert.match(prerequisite, /RUNNER_ENVIRONMENT:-.*github-hosted/u);
  assert.match(prerequisite, /systemd-detect-virt --container/u);
  assert.doesNotMatch(prerequisite, /systemd-executor|ebb-hermes-executor/u);
  assert.match(prerequisite, /'ebb-hermes-launcher-'/u);
  assert.match(prerequisite, /'ebb-hermes-probe-'/u);
  assert.match(prerequisite, /flags=\(default_allow\)/u);
  assert.doesNotMatch(prerequisite, /sysctl\s+-w|setcap|apparmor_parser.*-[rR]|st_uid|st_gid|st_mode\s*&|stat -c/u);
});

test('retained profiles have separate attempted loaded owned markers and no unload or deletion', () => {
  for (const marker of ['attempted', 'loaded', 'owned']) assert.ok(prerequisite.includes(`name+'.${marker}'`));
  assert.match(prerequisite, /RETAINED_UNTIL_RUNNER_DISPOSAL/u);
  assert.doesNotMatch(prerequisite, /apparmor_parser.*-[rR]|rm -|rmdir|trap cleanup EXIT/u);
  assert.match(prerequisite, /acceptance-completed/u);
});

function runProbeWithManagerResult(showOutput, showStatus, stopStatus = 1, transition = false) {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  assert.ok(existsSync(bash), 'behavioral shell contracts require Git Bash on Windows or /bin/bash on Linux');
  const start = prerequisite.indexOf('run_probe() {');
  const end = prerequisite.indexOf('\n}\n\nrun_probe', start) + 2;
  assert.ok(start >= 0 && end > start, 'extract the actual prerequisite function');
  const parserStart = prerequisite.indexOf('validate_probe_output() {');
  const parserEnd = prerequisite.indexOf('\n}\n', parserStart) + 2;
  const harness = `set -euo pipefail
GITHUB_RUN_ID=123
GITHUB_RUN_ATTEMPT=1
state_dir="$(mktemp -d)"
trap 'rm -f -- "$state_dir/probe-output" "$state_dir/probe-units"; rmdir -- "$state_dir"' EXIT
fail() { printf '%s\\n' "$1" >&2; exit 1; }
systemd-run() {
  if [[ "$FIXTURE_TRANSITION" == yes && "\${*: -1}" != --apply-exact-profile ]]; then
    printf 'EXACT_TRANSITION_ARGUMENT_MISSING\\n' >&2; return 1;
  fi
  printf '%s\\n' '${contextLine}' 'HERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0'; return 0;
}
systemctl() {
  if [[ "$2" == show ]]; then
    printf '%s' '${showOutput}'; return ${showStatus};
  fi
  printf 'fixture raw bus failure\\n' >&2
  return ${stopStatus}
}
sleep() { :; }
${prerequisite.slice(parserStart, parserEnd)}
${prerequisite.slice(start, end)}
run_probe ${typeof transition === 'string' ? transition : transition ? '--apply-exact-profile' : ''}
`;
  return spawnSync(bash, ['--noprofile', '--norc', '-c', harness], {
    encoding: 'utf8', shell: false, timeout: 5_000,
    env: { ...process.env, FIXTURE_TRANSITION: transition ? 'yes' : 'no' },
  });
}

test('explicit application transition probe receives only its fixed compile-bound transition switch', () => {
  const result = runProbeWithManagerResult('not-found', 0, 1, true);
  assert.equal(result.status, 0, 'actual run_probe must pass fixed switch through the same unit');
  assert.equal(result.stderr, '');
  const invalid = runProbeWithManagerResult('not-found', 0, 1, '--arbitrary-profile');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /^HERMES_NAMESPACE_SETUP_PROBE_MODE_INVALID\s*$/u);
});

test('ordinary exact-profile proof gates acceptance and privileged load preserves observed policy', () => {
  assert.match(prerequisite, /BEFORE=EXPECTED_PROFILE:AFTER=EXPECTED_PROFILE/u);
  assert.match(prerequisite, /--skip-kernel-load/u);
  assert.match(prerequisite, /--skip-cache/u);
  assert.match(prerequisite, /raw_sha256/u);
  assert.doesNotMatch(prerequisite, /extractall|dpkg.*--install|apt-get.*install/u);
});

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
  assert.equal(result.stdout, `${contextLine}\nHERMES_NATIVE_NAMESPACE_PROBE:PASS:ERRNO=0\n`);
});

test('workflow prerequisite removal requires successful explicit not-found from manager', () => {
  const step = workflow.jobs['process-scope-linux-acceptance'].steps.find((entry) => entry.name === 'Verify native Linux runner prerequisites');
  assert.doesNotMatch(step.run, /load_state=.*\|\| true/u);
  assert.doesNotMatch(step.run, /-z "\$load_state"/u);
  assert.match(step.run, /if load_state=.*systemctl --user show/u);
  assert.match(step.run, /if \[\[ "\$probe_removed" != yes \]\]/u);
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  const start = step.run.indexOf('probe_removed=no');
  assert.ok(start >= 0);
  for (const [output, status, expected] of [['', 0, 1], ['not-found', 1, 1], ['not-found', 0, 0]]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `set -euo pipefail
probe_unit=fixture.service
systemctl() { printf '%s' "$FIXTURE_OUTPUT"; return "$FIXTURE_STATUS"; }
sleep() { :; }
${step.run.slice(start)}
`], { encoding: 'utf8', shell: false, timeout: 5_000,
      env: { ...process.env, FIXTURE_OUTPUT: output, FIXTURE_STATUS: String(status) } });
    assert.equal(result.status, expected, `manager output ${JSON.stringify(output)} with exit ${status}`);
  }
});
