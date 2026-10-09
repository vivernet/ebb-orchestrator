import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Phase 1 never claims membership, restart, exec identity or platform readiness', () => {
  const source = readFileSync('scripts/macos-runtime-feasibility.mjs', 'utf8');
  for (const field of ['membership', 'fullScopeStop', 'restart', 'staleAfterExec']) {
    assert.match(source, new RegExp(`${field}: 'NOT_RUN'`));
  }
  assert.match(source, /platformReadiness: 'NOT_CLAIMED'/);
  assert.match(source, /shell: false/);
  assert.match(source, /timeout = 30_000/);
  assert.doesNotMatch(source, /process\.env|sudo|pkill/);
});

test('hosted dispatch includes PR/master/develop and preserves credential-free Phase1', () => {
  const workflow = readFileSync('.github/workflows/macos-runtime-feasibility.yml', 'utf8');
  assert.match(workflow, /branches: \[master, develop\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node-version: '24'/);
  assert.doesNotMatch(workflow, /secrets\.|Hermes|sudo/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /timeout-minutes: 10/);
  const paths = [...workflow.matchAll(/ {4}paths:\n((?: {6}- .+\n)+)/g)].flatMap(match => match[1].trim().split('\n'));
  assert.equal(paths.length, 8);
  for (const line of paths) assert.match(line.trim(), /^- (\.github\/workflows\/macos-runtime-feasibility\.yml|scripts\/macos-runtime-feasibility\.(cpp|mjs|test\.mjs))$/);
});

test('Phase2 durable CAS forbids LAUNCHING before complete artifact bindings', async () => {
  const { preparedOwner, transitionOwner } = await import('./macos-runtime-feasibility.mjs');
  const owner = preparedOwner({ generation: 'g', nonce: 'n', boot: 'b', domain: 'user/501', label: 'label' });
  assert.equal(owner.socketIdentity, null);
  assert.equal(owner.plistIdentity, null);
  assert.equal(owner.coalition, null);
  assert.throws(() => transitionOwner(owner, 0, 'LAUNCHING'), /ARTIFACT_BINDING/);
  const bound = transitionOwner(owner, 0, 'PREPARED', { socketIdentity: 's', plistIdentity: 'p', plistDigest: 'd' });
  assert.throws(() => transitionOwner(bound, 0, 'LAUNCHING'), /CAS/);
  const launching = transitionOwner(bound, 1, 'LAUNCHING');
  assert.equal(launching.state, 'LAUNCHING');
  assert.equal(launching.coalition, null);
  assert.throws(() => transitionOwner(launching, 2, 'RELEASED'), /TRANSITION/);
  assert.throws(() => transitionOwner(launching, 2, 'BOUND'), /KERNEL_BINDING/);
  assert.throws(() => transitionOwner(launching, 2, 'BOUND', { generation: 'other' }), /CORRELATION/);
  const owned = transitionOwner(launching, 2, 'BOUND', { coalition: '123', root: { pid: 42 } });
  const released = transitionOwner(owned, 3, 'RELEASED');
  const stopped = transitionOwner(released, 4, 'STOPPED');
  assert.throws(() => transitionOwner(stopped, 5, 'LAUNCHING'), /TRANSITION/);
});

test('job readback distinguishes inactive registration from current root and rejects program/nonce/policy mismatch', async () => {
  const { parseJob } = await import('./macos-runtime-feasibility.mjs');
  const owner = { domain: 'user/501', label: 'com.ebb.phase2.g', plist: '/tmp/g.plist', args: ['/tmp/binary', 'fixture', 'g', 'nonce'] };
  const body = `user/501/com.ebb.phase2.g = {\n program = /tmp/binary\n path = /tmp/g.plist\n domain = user/501 [100]\n arguments = {\n /tmp/binary\n fixture\n g\n nonce\n }\n properties = launch only once | abandon process group\n}`;
  assert.deepEqual(parseJob(body, owner, '/tmp/binary', 'registered'), { pid: null });
  assert.equal(parseJob(body, owner, '/tmp/binary', 'running'), null);
  const running = body.replace(' properties =', ' pid = 42\n properties =');
  assert.deepEqual(parseJob(running, owner, '/tmp/binary', 'running'), { pid: 42 });
  assert.equal(parseJob(running, owner, '/tmp/binary', 'registered'), null);
  assert.equal(parseJob(body.replace('nonce\n', 'other\n'), owner, '/tmp/binary', 'registered'), null);
  assert.equal(parseJob(body.replace('program = /tmp/binary', 'program = /tmp/other'), owner, '/tmp/binary', 'registered'), null);
  assert.equal(parseJob(body.replace('launch only once', 'keepalive'), owner, '/tmp/binary', 'registered'), null);
});

test('Phase2 non-Darwin reports NOT_RUN with schema v2, never simulation PASS', { skip: process.platform === 'darwin' }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ebb-macos-phase2-test-'));
  try {
    const reportPath = join(temporary, 'phase2.json');
    const child = spawnSync(process.execPath, ['scripts/macos-runtime-feasibility.mjs', reportPath, '--phase2'], {
      shell: false, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.phaseVerdict, 'NOT_RUN');
    assert.equal(report.reason, 'MACOS_REQUIRED');
    assert.equal(report.platformReadiness, 'NOT_CLAIMED');
  } finally { rmSync(temporary, { recursive: true }); }
});

test('manager result classifier rejects unavailable, wrong generation and vacuous absent output', async () => {
  const { classifyManagerResult } = await import('./macos-runtime-feasibility.mjs');
  const missing = { status: 113, signal: null, stdout: '', stderr: 'missing exact label' };
  assert.equal(classifyManagerResult(missing, { absent: missing, healthBefore: false, healthAfter: true }), 'UNKNOWN');
  assert.equal(classifyManagerResult(missing, { absent: missing, healthBefore: true, healthAfter: true }), 'ABSENT');
  assert.equal(classifyManagerResult({ ...missing, status: 1 }, { absent: missing, healthBefore: true, healthAfter: true }), 'UNKNOWN');
  assert.equal(classifyManagerResult({ status: 0, signal: null, stdout: '', stderr: '' }, { matches: false }), 'WRONG_GENERATION');
});

test('domain health evidence is bounded and never serializes launchctl inventory or arbitrary errors', async () => {
  const { domainHealthEvidence } = await import('./macos-runtime-feasibility.mjs');
  assert.equal(typeof domainHealthEvidence, 'function');
  const result = { status: 0, signal: null, error: null,
    stdout: 'user/501 = {\n services = { PRIVATE_INVENTORY }\n}', stderr: '' };
  const valid = domainHealthEvidence(result, 'user/501');
  assert.equal(valid.healthy, true); assert.equal(valid.headerMatched, true); assert.equal(valid.trailerMatched, true);
  assert.doesNotMatch(JSON.stringify(valid), /PRIVATE_INVENTORY|stdout"|stderr"/);
  for (const changed of [{ ...result, status: 113, stderr: 'Could not find domain for SECRET' },
    { ...result, error: 'SECRET_ERROR' }, { ...result, signal: 'SIGTERM' },
    { ...result, stdout: 'gui/501 = {\n}' }, { ...result, stdout: 'user/501 = {\n} trailing' }]) {
    const evidence = domainHealthEvidence(changed, 'user/501');
    assert.equal(evidence.healthy, false);
    assert.doesNotMatch(JSON.stringify(evidence), /SECRET|services|PRIVATE|trailing/);
  }
  assert.equal(domainHealthEvidence({ ...result, error: 'ETIMEDOUT' }, 'user/501').error, 'TIMEOUT');
  assert.equal(domainHealthEvidence({ ...result, error: 'ENOBUFS' }, 'user/501').error, 'BUFFER_LIMIT');
});

test('streaming domain experiment discards inventory and fails closed on limit and timeout', async () => {
  const { streamDomainHealth } = await import('./macos-runtime-feasibility.mjs');
  const { spawn } = await import('node:child_process');
  assert.equal(typeof streamDomainHealth, 'function');
  const start = source => () => spawn(process.execPath, ['-e', source], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const success = await streamDomainHealth('user/501', { start: start("process.stdout.write('user/501 = {\\n' + 'PRIVATE'.repeat(12000) + '\\n}\\n')") });
  assert.equal(success.healthy, true); assert.ok(success.stdoutBytes > 65536);
  assert.doesNotMatch(JSON.stringify(success), /PRIVATE|stdout"|stderr"/);
  const limited = await streamDomainHealth('user/501', { limit: 100, start: start("process.stdout.write('user/501 = {'+'X'.repeat(1000)+'}')") });
  assert.equal(limited.healthy, false); assert.equal(limited.error, 'BUFFER_LIMIT');
  const timed = await streamDomainHealth('user/501', { deadline: 30, start: start('setTimeout(()=>{},1000)') });
  assert.equal(timed.healthy, false); assert.equal(timed.error, 'TIMEOUT');
});

test('actual health authority accepts complete 82KB same-user stream and rejects malformed/truncated or other domains', async () => {
  const { health } = await import('./macos-runtime-feasibility.mjs');
  const { spawn } = await import('node:child_process');
  assert.equal(typeof health, 'function');
  let calls = 0;
  const start = text => () => {
    calls++;
    const child = spawn(process.execPath, ['-e', "process.stdin.on('data',chunk=>process.stdout.write(chunk))"],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(text); return child;
  };
  const evidence = [];
  assert.equal(await health('user/501', evidence, { start: start('user/501 = {\n' + 'X'.repeat(82240) + '\n}\n') }), true);
  assert.ok(evidence[0].stdoutBytes > 65536);
  for (const text of ['user/501 = {\ntruncated', 'gui/501 = {\n}', 'user/501 = {\n} trailing']) {
    assert.equal(await health('user/501', [], { start: start(text) }), false);
  }
  const before = calls;
  for (const domain of ['gui/501', 'system', 'user/other']) assert.equal(await health(domain, [], { start: start('') }), false);
  assert.equal(calls, before);
  assert.equal(await health('user/501', [], { limit: 20, start: start('user/501 = {' + 'X'.repeat(100) + '}') }), false);
  assert.equal(await health('user/501', [], { deadline: 20, start: () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},1000)'],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) }), false);
});

test('bootstrap diagnostics sanitize output and new user fixture declares only Background session', async () => {
  const { bootstrapEvidence, fixturePlist } = await import('./macos-runtime-feasibility.mjs');
  assert.equal(typeof bootstrapEvidence, 'function'); assert.equal(typeof fixturePlist, 'function');
  for (const [stderr, category] of [['Bootstrap failed: 5: Input/output error PRIVATE', 'IO_ERROR'],
    ['Permission denied PRIVATE', 'PERMISSION'], ['Invalid property list PRIVATE', 'INVALID_PLIST'],
    ['Service already exists PRIVATE', 'SERVICE_EXISTS'], ['PRIVATE unknown', 'UNKNOWN']]) {
    const evidence = bootstrapEvidence({ status: 5, signal: null, error: null, stdout: 'PRIVATE', stderr });
    assert.equal(evidence.stderrCategory, category); assert.equal(evidence.status, 5);
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|stdout"|stderr"/);
  }
  const plist = fixturePlist('label', '/tmp/binary', ['/tmp/binary', 'fixture', 'g', 'n']);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key><string>Background<\/string>/);
  for (const key of ['RunAtLoad', 'KeepAlive']) assert.match(plist, new RegExp(`<key>${key}</key><false/>`));
  for (const key of ['LaunchOnlyOnce', 'AbandonProcessGroup']) assert.match(plist, new RegExp(`<key>${key}</key><true/>`));
  assert.doesNotMatch(plist, /Aqua|SessionCreate|MachServices|StartInterval|WatchPaths/);
  const source = readFileSync('scripts/macos-runtime-feasibility.mjs', 'utf8');
  assert.match(source, /run\('\/usr\/bin\/plutil', \['-lint', '--', plist\], 5000\)/);
  const bootstrapFailure = source.slice(source.indexOf('if (bootstrap.status !== 0'), source.indexOf('const registration = await managerRead'));
  assert.match(bootstrapFailure, /bootstrapFailureReadback = await managerRead\(owner, binary, 'static', absent\)/);
  assert.ok(bootstrapFailure.indexOf('bootstrapFailureReadback') < bootstrapFailure.indexOf("throw new Error('BOOTSTRAP_UNCERTAIN')"));
  assert.doesNotMatch(bootstrapFailure, /transitionOwner|bootout|rmSync/);
});

test('feasibility verdict requires entire matrix and rejects retained UNKNOWN or failed sentinel cleanup', async () => {
  const { feasibilityVerdict } = await import('./macos-runtime-feasibility.mjs');
  assert.equal(feasibilityVerdict([]), 'NOT_VERIFIED');
  assert.equal(feasibilityVerdict([{ scenario: 'barrier', verdict: 'PASS', cleanup: 'RETAINED', stop: 'UNKNOWN' }]), 'NOT_VERIFIED');
  assert.equal(feasibilityVerdict([{ scenario: 'barrier', verdict: 'PASS', cleanup: 'PASS', sentinelCleanup: 'FAIL' }]), 'FAIL');
  const matrix = ['barrier', 'fork', 'exec', 'spawn', 'setsid', 'doublefork', 'root-exit', 'burst',
    'crash-before-bootstrap', 'crash-after-dispatch', 'crash-before-bind', 'crash-before-ack', 'crash-after-ack',
    'stale-token', 'reload-generation', 'malformed-owner', 'manager-unavailable'].map(scenario => ({ scenario, verdict: 'PASS', cleanup: 'PASS' }));
  assert.equal(feasibilityVerdict(matrix), 'PASS');
  matrix[9] = { ...matrix[9], stop: 'UNKNOWN', cleanup: 'RETAINED', verdict: 'NOT_VERIFIED' };
  assert.equal(feasibilityVerdict(matrix), 'NOT_VERIFIED');
});

test('ESRCH is UNKNOWN without calibrated absent semantics, durable binding, same boot and CLOSED dispatch', async () => {
  const module = await import('./macos-runtime-feasibility.mjs');
  assert.equal(typeof module.stopProof, 'function');
  const reading = { result: -1, errno: 3, validPrefix: false };
  const owner = { state: 'BOUND', coalition: '99', root: { coalition: '99' }, boot: 'boot',
    bindingProof: { coalition: '99', boot: 'boot', priorSuccessfulQuery: true },
    absenceCalibration: { result: -1, errno: 3, boot: 'boot', validated: true } };
  assert.equal(module.stopProof(reading, owner, 'boot', 'CLOSED'), 'KNOWN_BOUND_ID_ABSENT');
  assert.equal(module.stopProof(reading, { ...owner, absenceCalibration: null }, 'boot', 'CLOSED'), 'UNKNOWN');
  assert.equal(module.stopProof(reading, { ...owner, bindingProof: null }, 'boot', 'CLOSED'), 'UNKNOWN');
  assert.equal(module.stopProof(reading, { ...owner, state: 'LAUNCHING' }, 'boot', 'CLOSED'), 'UNKNOWN');
  assert.equal(module.stopProof(reading, owner, 'different', 'CLOSED'), 'UNKNOWN');
  assert.equal(module.stopProof(reading, owner, 'boot', 'OPEN'), 'UNKNOWN');
  assert.equal(module.stopProof({ result: -1, errno: 1 }, owner, 'boot', 'CLOSED'), 'UNKNOWN');
});

test('socket path is shortened and rejects UTF-8 byte overflow before launch preparation', async () => {
  const module = await import('./macos-runtime-feasibility.mjs');
  assert.equal(typeof module.phase2SocketPath, 'function');
  const path = module.phase2SocketPath('/tmp/ebb', '12345678-1234-1234-1234-123456789abc', 104);
  assert.equal(path.endsWith('s-12345678'), true);
  assert.equal(module.phase2SocketPath('/' + 'a'.repeat(91), '12345678', 104).length, 103);
  assert.throws(() => module.phase2SocketPath('/' + 'a'.repeat(92), '12345678', 104), /SOCKET_PATH_BYTES/);
  assert.throws(() => module.phase2SocketPath('/' + 'я'.repeat(46), '12345678', 104), /SOCKET_PATH_BYTES/);
});

test('durable journal staging excludes a competing writer without overwriting its lease', async () => {
  const module = await import('./macos-runtime-feasibility.mjs');
  assert.equal(typeof module.publishOwner, 'function');
  const directory = mkdtempSync(join(tmpdir(), 'ebb-journal-contention-'));
  try {
    const path = join(directory, 'owner.json');
    writeFileSync(`${path}.next`, 'first-controller', { flag: 'wx', mode: 0o600 });
    assert.throws(() => module.publishOwner(path, module.preparedOwner({ generation: 'g' })), /EEXIST/);
    assert.equal(readFileSync(`${path}.next`, 'utf8'), 'first-controller');
  } finally { rmSync(directory, { recursive: true }); }
});

test('sentinel cleanup requires bound unique identity/version/boot and explicit native death proof', async () => {
  const { sentinelProof } = await import('./macos-runtime-feasibility.mjs');
  const binding = { pid: 42, unique: '123', pidversion: 7 };
  assert.equal(sentinelProof({ result: 0 }, binding, 'boot'), false);
  assert.equal(sentinelProof({ state: 'STOPPED', pid: 42 }, binding, 'boot'), false);
  const observation = { state: 'STOPPED', unique: '123', pidversion: 7, boot: 'boot', proofKind: 'BOUND_UNIQUE_ID_REPLACED' };
  assert.equal(sentinelProof(observation, binding, 'boot'), true);
  assert.equal(sentinelProof({ ...observation, unique: 'other' }, binding, 'boot'), false);
  assert.equal(sentinelProof({ ...observation, pidversion: 8 }, binding, 'boot'), false);
  assert.equal(sentinelProof(observation, binding, 'different'), false);
});

test('current barrier handoff rejects wrong sender/lock/nonce/generation and PID-only manager substitution', async () => {
  const { barrierTransferMatches } = await import('./macos-runtime-feasibility.mjs');
  const owner = { lockIdentity: '1:2', boot: 'boot', controller: { unique: 'sender' }, nonce: 'nonce', generation: 'gen', args: ['fork'] };
  const event = { event: 'LEASE_BARRIER', lockIdentity: '1:2', boot: 'boot', sender: owner.controller, root: { pid: 42 },
    frame: { protocol: 2, nonce: 'nonce', generation: 'gen', scenario: 'fork' } };
  const manager = { classification: 'MATCH', pid: 42 };
  assert.equal(barrierTransferMatches(event, owner, manager), true);
  assert.equal(barrierTransferMatches(event, owner, { classification: 'ABSENT', pid: 42 }), false);
  assert.equal(barrierTransferMatches({ ...event, lockIdentity: '1:3' }, owner, manager), false);
  assert.equal(barrierTransferMatches({ ...event, sender: { unique: 'other' } }, owner, manager), false);
  assert.equal(barrierTransferMatches({ ...event, frame: { ...event.frame, nonce: 'other' } }, owner, manager), false);
  assert.equal(barrierTransferMatches({ ...event, frame: { ...event.frame, generation: 'other' } }, owner, manager), false);
});

test('fault controller unexpected result preserves pending owner and binary and prevents recursive cleanup/next dispatch', async () => {
  const module = await import('./macos-runtime-feasibility.mjs');
  assert.equal(typeof module.runFaultGeneration, 'function');
  assert.equal(typeof module.canRemoveFixtureRoot, 'function');
  const results = [{ status: 1, signal: null }, { status: null, signal: 'SIGTERM' },
    { status: null, signal: 'SIGTERM', error: 'ETIMEDOUT' }, { status: null, signal: null, error: 'ENOENT' }];
  for (const result of results) {
    const directory = mkdtempSync(join(tmpdir(), 'ebb-fault-parent-'));
    try {
      const binary = join(directory, 'fixture'), journal = join(directory, 'gen.json');
      writeFileSync(binary, 'owned-fixture'); writeFileSync(journal, '{"state":"LAUNCHING"}');
      const report = { scenarios: [] }; let recovered = false, dispatched = false;
      const safe = await module.runFaultGeneration({ report, directory, binary, generation: 'gen', scenario: 'crash-after-dispatch',
        persist: () => writeFileSync(join(directory, 'parent-generations.json'), JSON.stringify(report.scenarios)),
        command: () => { dispatched = true; assert.equal(report.scenarios[0].cleanup, 'RETAINED');
          assert.equal(JSON.parse(readFileSync(join(directory, 'parent-generations.json'), 'utf8'))[0].stop, 'UNKNOWN'); return result; },
        recover: async () => { recovered = true; } });
      assert.equal(dispatched, true); assert.equal(recovered, false); assert.equal(safe, false);
      assert.equal(report.noNextDispatch, true);
      assert.equal(module.canRemoveFixtureRoot(directory, report), false);
      assert.equal(existsSync(journal), true); assert.equal(readFileSync(binary, 'utf8'), 'owned-fixture');
      assert.equal(report.scenarios[0].cleanup, 'RETAINED'); assert.equal(report.scenarios[0].stop, 'UNKNOWN');
    } finally { rmSync(directory, { recursive: true }); }
  }
});

test('parent root cleanup rejects missing outcome, remaining owned journal or recovery failure', async () => {
  const module = await import('./macos-runtime-feasibility.mjs');
  assert.equal(typeof module.canRemoveFixtureRoot, 'function');
  const directory = mkdtempSync(join(tmpdir(), 'ebb-fault-recovery-'));
  try {
    const binary = join(directory, 'fixture'); writeFileSync(binary, 'fixture');
    const report = { scenarios: [] };
    const safe = await module.runFaultGeneration({ report, directory, binary, generation: 'gen', scenario: 'crash-before-ack',
      persist: () => {}, command: () => ({ status: 86, signal: null }), recover: async () => { throw new Error('MISSING_OUTCOME'); } });
    assert.equal(safe, false); assert.equal(module.canRemoveFixtureRoot(directory, report), false);
    assert.equal(existsSync(binary), true);
    const proven = { scenarios: [{ generation: 'gen', stop: 'STOPPED', cleanup: 'PASS', pending: false }] };
    writeFileSync(join(directory, 'gen.json'), '{}');
    assert.equal(module.canRemoveFixtureRoot(directory, proven), false);
    rmSync(join(directory, 'gen.json'));
    assert.equal(module.canRemoveFixtureRoot(directory, proven), true);
  } finally { rmSync(directory, { recursive: true }); }
});

test('non-macOS execution reports NOT_RUN and returns nonzero', { skip: process.platform === 'darwin' }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ebb-macos-wrapper-test-'));
  try {
    const reportPath = join(temporary, 'report.json');
    const child = spawnSync(process.execPath, ['scripts/macos-runtime-feasibility.mjs', reportPath], {
      shell: false, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.reason, 'MACOS_REQUIRED');
    assert.equal(report.phaseVerdict, 'NOT_RUN');
    assert.equal(report.platformReadiness, 'NOT_CLAIMED');
  } finally { rmSync(temporary, { recursive: true }); }
});
