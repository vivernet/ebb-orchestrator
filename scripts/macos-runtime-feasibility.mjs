import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';

const sourcePin = 'f6217f891ac0bb64f3d375211650a4c1ff8ca1ea';
/** Создаёт durable pre-dispatch intent; отсутствующие kernel/artifact identities остаются NULL. */
export function preparedOwner(binding) {
  return { schemaVersion: 2, ...binding, state: 'PREPARED', revision: 0,
    socketIdentity: null, plistIdentity: null, plistDigest: null, coalition: null, root: null };
}
/** Проверяет CAS и barrier transitions; stale callback не может разрешить dispatch/release. */
export function transitionOwner(owner, expectedRevision, state, patch = {}) {
  if (owner.revision !== expectedRevision) throw new Error('OWNER_CAS');
  const allowed = { PREPARED: ['PREPARED', 'LAUNCHING', 'NEVER_LAUNCHED'], LAUNCHING: ['BOUND'],
    BOUND: ['RELEASED', 'STOPPED'], RELEASED: ['STOPPED'], STOPPED: [], NEVER_LAUNCHED: [] };
  if (!allowed[owner.state]?.includes(state)) throw new Error('OWNER_TRANSITION');
  if (Object.keys(patch).some(key => ['state', 'revision', 'generation', 'nonce', 'boot', 'domain', 'label', 'args', 'binaryDigest'].includes(key))) throw new Error('OWNER_CORRELATION');
  const next = { ...owner, ...patch, state, revision: owner.revision + 1 };
  if (state === 'LAUNCHING' && (!next.socketIdentity || !next.plistIdentity || !next.plistDigest)) throw new Error('ARTIFACT_BINDING');
  if (state === 'BOUND' && (!next.coalition || !next.root)) throw new Error('KERNEL_BINDING');
  return next;
}
/** Nonzero manager result является ABSENT только при calibrated signature и двух domain-health reads. */
export function classifyManagerResult(result, context) {
  if (result.error || result.signal || result.status === null) return 'UNKNOWN';
  if (result.status === 0) return context.matches === true ? 'MATCH' : 'WRONG_GENERATION';
  const absent = context.absent;
  return context.healthBefore && context.healthAfter && absent && absent.status !== 0
    && result.status === absent.status && result.stdout === absent.stdout && result.stderr === absent.stderr
    ? 'ABSENT' : 'UNKNOWN';
}

function objectIdentity(path, type) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (type === 'file' && (!stat.isFile() || stat.nlink !== 1n))
    || (type === 'socket' && !stat.isSocket())) throw new Error('ARTIFACT_TYPE');
  if ((stat.mode & 0o077n) !== 0n) throw new Error('PRIVATE_ARTIFACT_MODE');
  if (process.getuid && stat.uid !== BigInt(process.getuid())) throw new Error('PRIVATE_ARTIFACT_OWNER');
  return `${stat.dev}:${stat.ino}`;
}
/** Публикует следующую revision через exclusive staging/rename/fsync; unsupported durability и competing writer закрывают CAS. */
export function publishOwner(path, owner) {
  if (owner.revision > 0) {
    objectIdentity(path, 'file');
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (current.revision !== owner.revision - 1 || current.generation !== owner.generation
      || current.nonce !== owner.nonce || current.boot !== owner.boot) throw new Error('DURABLE_OWNER_CAS');
  }
  const next = `${path}.next`;
  const fd = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(owner)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(next, path);
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(input).isFile() || readFileSync(input, 'utf8') !== `${JSON.stringify(owner)}\n`) throw new Error('OWNER_READBACK');
  } finally { closeSync(input); }
}
/** Проверяет bytes вместе с NUL до создания owner/launch; лимит получен из compiled native SDK. */
export function phase2SocketPath(directory, generation, capacity) {
  const socket = join(directory, `s-${generation.replaceAll('-', '').slice(0, 8)}`);
  if (!Number.isInteger(capacity) || capacity < 1 || Buffer.byteLength(socket, 'utf8') + 1 > capacity) throw new Error('SOCKET_PATH_BYTES');
  return socket;
}
/** ESRCH — только candidate: authoritative proof требует durable prior query/calibration и закрытый dispatch. */
export function stopProof(reading, owner, currentBoot, dispatch) {
  const binding = owner.bindingProof;
  if (!['BOUND', 'RELEASED', 'STOPPED'].includes(owner.state) || dispatch !== 'CLOSED' || !owner.coalition
    || owner.boot !== currentBoot || binding?.priorSuccessfulQuery !== true || binding.boot !== currentBoot
    || binding.coalition !== owner.coalition || owner.root?.coalition !== owner.coalition) return 'UNKNOWN';
  if (reading.result === 0 && reading.validPrefix === true && reading.started === reading.exited) return 'COUNTER_EQUALITY';
  const calibration = owner.absenceCalibration;
  return reading.result === -1 && reading.errno === 3 && calibration?.validated === true
    && calibration.boot === currentBoot && calibration.result === -1 && calibration.errno === 3
    ? 'KNOWN_BOUND_ID_ABSENT' : 'UNKNOWN';
}
function calibrateAbsence(binary, coalition, boot) {
  const before = native(binary, ['usage', coalition]);
  const invalidID = '18446744073709551615';
  const first = native(binary, ['usage', invalidID]);
  const second = native(binary, ['usage', invalidID]);
  const after = native(binary, ['usage', coalition]);
  const currentBoot = native(binary, ['clock']).value.boot;
  const validated = before.value.validPrefix === true && after.value.validPrefix === true
    && first.value.result === -1 && first.value.errno === 3 && second.value.result === -1 && second.value.errno === 3
    && currentBoot === boot;
  return { boot, queriedID: invalidID, result: first.value.result, errno: first.value.errno,
    repeatedResult: second.value.result, repeatedErrno: second.value.errno, bracketedKnownLive: before.value.validPrefix && after.value.validPrefix, validated };
}
function native(binary, args, timeout = 5000) {
  const result = run(binary, args, timeout);
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('NATIVE_PROTOCOL'); }
  return { ...result, value };
}

// Диагностика ограничена фиксированными командами; environment и credentials не читаются.
function phase1(output) {
const report = {
  schemaVersion: 1, phase: 'compile-export-permissions',
  sourcePin,
  platformReadiness: 'NOT_CLAIMED', membership: 'NOT_RUN',
  fullScopeStop: 'NOT_RUN', restart: 'NOT_RUN', staleAfterExec: 'NOT_RUN',
};
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
}

function run(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout, maxBuffer: 64 * 1024 });
  return { status: result.status, signal: result.signal, error: result.error?.code,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
}

const scenarios = ['barrier', 'fork', 'exec', 'spawn', 'setsid', 'doublefork', 'root-exit', 'burst',
  'crash-before-bootstrap', 'crash-after-dispatch', 'crash-before-bind', 'crash-before-ack', 'crash-after-ack',
  'stale-token', 'reload-generation', 'malformed-owner', 'manager-unavailable'];
/** Полная matrix и cleanup нужны для feasibility PASS; UNKNOWN не превращается в зелёный CI. */
export function feasibilityVerdict(matrix) {
  if (matrix.some(value => value.verdict === 'FAIL' || value.sentinelCleanup === 'FAIL')) return 'FAIL';
  return scenarios.every(scenario => matrix.some(value => value.scenario === scenario && value.verdict === 'PASS'
    && value.cleanup === 'PASS' && !['RETAINED', 'SIGNALLED', 'FAIL'].includes(value.sentinelCleanup))) ? 'PASS' : 'NOT_VERIFIED';
}
function session(binary, socket, nonce, generation, deadline, lease = false, boot = '') {
  const args = lease === 'recover' ? ['recover-barrier', socket, nonce, generation, boot]
    : lease ? ['lease', `${socket}.lock`] : ['serve', socket, nonce, generation, deadline];
  const child = spawn(binary, args,
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = []; const waiters = []; let buffered = '', failure;
  const timer = setTimeout(() => child.stdin.destroy(), 60_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    if (buffered.length > 8192) { failure = new Error('FRAME_OVERFLOW'); child.stdin.destroy(); return; }
    while (buffered.includes('\n')) {
      const index = buffered.indexOf('\n'), line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
      try { const event = JSON.parse(line); if (waiters.length) waiters.shift()(event); else events.push(event); }
      catch { failure = new Error('FRAME_INVALID'); child.stdin.destroy(); }
    }
  });
  let stderrBytes = 0;
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 4096) child.stdin.destroy(); });
  const closed = new Promise(resolveClose => {
    child.once('error', error => { failure = error; });
    child.once('close', (code, signal) => { clearTimeout(timer); resolveClose({ code, signal }); });
  });
  return { child, closed, next: () => new Promise((resolveEvent, reject) => {
    if (failure) { reject(failure); return; }
    if (events.length) { resolveEvent(events.shift()); return; }
    const timeout = setTimeout(() => reject(new Error('FRAME_TIMEOUT')), 5000);
    waiters.push(event => { clearTimeout(timeout); resolveEvent(event); });
  }) };
}
/** При RunAtLoad=false registration readback не требует несуществующий PID; launch readback требует current PID. */
export function parseJob(text, owner, binary, phase) {
  if (parseJobRejection(text, owner, binary, phase) !== null) return null;
  const pid = text.match(/^\s*pid = ([1-9]\d*)$/m)?.[1];
  return { pid: pid ? Number(pid) : null };
}
/** Fixed rejection category объясняет mismatch без raw service data; null означает прохождение всех прежних gates. */
export function parseJobRejection(text, owner, binary, phase) {
  if (!text.startsWith(`${owner.domain}/${owner.label} = {`)) return 'prefix';
  if (!text.endsWith('}')) return 'trailer';
  const program = text.match(/^\s*program = (.+)$/m)?.[1];
  const path = text.match(/^\s*path = (.+)$/m)?.[1];
  const domain = text.match(/^\s*domain = (\S+)(?: .*)?$/m)?.[1];
  const args = text.match(/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m)?.[1].trim().split('\n').map(value => value.trim());
  const properties = text.match(/^\s*properties = (.+)$/m)?.[1] ?? '';
  if (program !== binary) return 'program';
  if (path !== owner.plist) return 'path';
  if (domain !== owner.domain) return 'domain';
  if (JSON.stringify(args) !== JSON.stringify(owner.args)) return 'arguments';
  if (!properties.includes('launch only once') || properties.includes('keepalive')
    || !properties.includes('abandon process group')) return 'properties';
  const pid = text.match(/^\s*pid = ([1-9]\d*)$/m)?.[1];
  if (/^\s*pid\s*=/m.test(text) && (!pid || !Number.isSafeInteger(Number(pid)))) return 'pid-shape';
  if (phase === 'registered' && pid || phase === 'running' && !pid) return 'pid-shape';
  return null;
}
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
/** Новый disposable user-domain fixture явно выбирает Background; restart/demand policy остаётся закрытой. */
export function fixturePlist(label, binary, args) {
  // Apple DTS: https://developer.apple.com/forums/thread/696859 — omitted session defaults to Aqua.
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>Program</key><string>${xml(binary)}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>LimitLoadToSessionType</key><string>Background</string><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>LaunchOnlyOnce</key><true/><key>AbandonProcessGroup</key><true/></dict></plist>`;
}
/** Bootstrap/plutil evidence содержит только process metadata и allowlisted category; вывод и пути отбрасываются. */
export function bootstrapEvidence(result) {
  const safe = domainHealthEvidence(result, 'NO_DOMAIN');
  const text = result.stderr ?? '';
  const stderrCategory = !text ? 'EMPTY' : /input\/output error|\bi\/o error\b/i.test(text) ? 'IO_ERROR'
    : /permission denied|operation not permitted/i.test(text) ? 'PERMISSION'
      : /invalid.*plist|invalid.*property list|parse error|unexpected character/i.test(text) ? 'INVALID_PLIST'
        : /service.*already exists|already bootstrapped/i.test(text) ? 'SERVICE_EXISTS' : 'UNKNOWN';
  return { status: safe.status, signal: safe.signal, error: safe.error,
    stdoutBytes: safe.stdoutBytes, stderrBytes: safe.stderrBytes, stderrCategory };
}
/** Сохраняет только bounded manager-health признаки; inventory и произвольные diagnostics не покидают parser. */
export function domainHealthEvidence(result, domain) {
  const text = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  const headerMatched = text.startsWith(`${domain} = {`);
  const trailerMatched = text.endsWith('}');
  const error = result.error ? result.error === 'ETIMEDOUT' ? 'TIMEOUT' : result.error === 'ENOBUFS' ? 'BUFFER_LIMIT' : 'PROCESS_ERROR' : null;
  const signal = result.signal ? ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(result.signal) ? result.signal : 'OTHER_SIGNAL' : null;
  const status = Number.isSafeInteger(result.status) ? result.status : null;
  const stderrCategory = !result.stderr ? 'EMPTY'
    : /could not find domain|domain does not exist|no such process/i.test(result.stderr) ? 'DOMAIN_UNAVAILABLE'
      : /permission denied|operation not permitted/i.test(result.stderr) ? 'ACCESS_DENIED' : 'OTHER';
  return { status, signal, error, headerMatched, trailerMatched, stderrCategory,
    stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout ?? ''), stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr ?? ''),
    healthy: !result.error && !result.signal && status === 0 && headerMatched && trailerMatched };
}
/** Read-only same-domain health: bounded streaming discards inventory; ошибки и неполный результат закрывают manager proof. */
export function streamDomainHealth(domain, { deadline = 5000, limit = 2 * 1024 * 1024,
  start = () => spawn('/bin/launchctl', ['print', domain], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  return new Promise(resolveProbe => {
    const expected = Buffer.from(`${domain} = {`);
    let prefix = Buffer.alloc(0), last = null, stdoutBytes = 0, stderrBytes = 0, failure = null;
    let child;
    try { child = start(); } catch { resolveProbe({ healthy: false, error: 'PROCESS_ERROR', status: null, signal: null,
      stdoutBytes, stderrBytes, headerMatched: false, trailerMatched: false, stderrCategory: 'DISCARDED' }); return; }
    const fail = category => { failure ??= category; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail('TIMEOUT'), deadline);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > limit) { fail('BUFFER_LIMIT'); return; }
      if (prefix.length < expected.length) prefix = Buffer.concat([prefix, chunk.subarray(0, expected.length - prefix.length)]);
      for (const byte of chunk) if (![9, 10, 11, 12, 13, 32].includes(byte)) last = byte;
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stdoutBytes + stderrBytes > limit) fail('BUFFER_LIMIT'); });
    child.on('error', () => { failure ??= 'PROCESS_ERROR'; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      const headerMatched = prefix.equals(expected), trailerMatched = last === 125;
      resolveProbe({ status, signal: signal ? ['SIGTERM', 'SIGKILL', 'SIGABRT'].includes(signal) ? signal : 'OTHER_SIGNAL' : null,
        error: failure, stdoutBytes, stderrBytes, headerMatched, trailerMatched, stderrCategory: 'DISCARDED',
        healthy: !failure && !signal && status === 0 && headerMatched && trailerMatched });
    });
  });
}
/** Authority требует полного bounded same-user stream; другие domain types никогда не запрашиваются. */
export async function health(domain, evidence, options) {
  if (!/^user\/(0|[1-9]\d*)$/.test(domain)) return false;
  const summary = await streamDomainHealth(domain, options);
  if (evidence) evidence.push({ domainKind: domain.split('/')[0], ...summary });
  return summary.healthy;
}
function normalized(result, label) {
  return { status: result.status, signal: result.signal, error: result.error,
    stdout: result.stdout.replaceAll(label, '<label>'), stderr: result.stderr.replaceAll(label, '<label>') };
}
async function managerRead(owner, binary, phase, absent) {
  const healthBefore = await health(owner.domain);
  const result = run('/bin/launchctl', ['print', `${owner.domain}/${owner.label}`], 5000);
  const job = result.status === 0 ? parseJob(result.stdout, owner, binary, phase) : null;
  const parseRejection = result.status === 0 ? parseJobRejection(result.stdout, owner, binary, phase) : null;
  const healthAfter = await health(owner.domain);
  return { classification: classifyManagerResult(normalized(result, owner.label), { matches: Boolean(job), absent, healthBefore, healthAfter }),
    pid: job?.pid ?? null, status: result.status, error: result.error, healthBefore, healthAfter, parseRejection };
}
function safeOwnerFile(path, expected) {
  if (objectIdentity(path, 'file') === '') throw new Error('OWNER_IDENTITY');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error('OWNER_MISMATCH');
  return value;
}
function signalBinding(binary, binding, mode = 'signal', signal = '15') {
  return native(binary, [mode, String(binding.pid), binding.unique, String(binding.pidversion), binding.coalition, signal]);
}
function checkSentinel(binary, owner) {
  const current = native(binary, ['identity', String(owner.sentinel.pid)]);
  return current.status === 0 && current.value.boot === owner.boot
    && JSON.stringify(current.value.identity) === JSON.stringify(owner.sentinel)
    && owner.sentinel.coalition !== owner.coalition;
}
/** Проверяет результат fresh native observation, а не успешный signal или совпадение одного PID. */
export function sentinelProof(observation, binding, boot) {
  return observation?.state === 'STOPPED' && observation.unique === binding.unique
    && observation.pidversion === binding.pidversion && observation.boot === boot
    && ['BOUND_IDENTITY_PID_SLOT_GONE', 'BOUND_UNIQUE_ID_REPLACED'].includes(observation.proofKind);
}
/** Transfer принимается только с exact journal/manager/kernel peer correlation; сама READY не даёт authority. */
export function barrierTransferMatches(event, owner, manager) {
  return event.event === 'LEASE_BARRIER' && event.lockIdentity === owner.lockIdentity && event.boot === owner.boot
    && JSON.stringify(event.sender) === JSON.stringify(owner.controller)
    && event.frame?.protocol === 2 && event.frame.nonce === owner.nonce && event.frame.generation === owner.generation
    && event.frame.scenario === owner.args.at(-1)
    && Object.keys(event.frame).sort().join(',') === 'generation,nonce,protocol,scenario'
    && manager.classification === 'MATCH' && manager.pid === event.root?.pid;
}
/** Signal success не является cleanup proof; требует fresh bounded kernel observation exact ранее bound identity. */
function stopSentinel(binary, owner) {
  const signal = signalBinding(binary, owner.sentinel);
  if (signal.value.result !== 0) return { verdict: 'FAIL', signal: signal.value, observation: null };
  const observation = native(binary, ['observe', String(owner.sentinel.pid), owner.sentinel.unique,
    String(owner.sentinel.pidversion), owner.boot], 4000);
  const verified = observation.status === 0 && sentinelProof(observation.value, owner.sentinel, owner.boot);
  return { verdict: verified ? 'PASS' : 'FAIL', signal: signal.value, observation: observation.value };
}

async function exercise(binary, directory, scenario, report, selectedGeneration = randomUUID(), fault = false) {
  const generation = selectedGeneration, nonce = randomUUID(), label = `com.ebb.phase2.${generation}`;
  const clock = native(binary, ['clock']);
  if (clock.status !== 0 || !clock.value.boot) throw new Error('BOOT_ID_UNAVAILABLE');
  const domain = `user/${process.getuid()}`;
  const socket = phase2SocketPath(directory, generation, clock.value.socketPathCapacity), plist = join(directory, `${generation}.plist`), journal = join(directory, `${generation}.json`);
  const deadline = (BigInt(clock.value.milliseconds) + 55_000n).toString();
  const fixture = scenario.startsWith('crash-') ? 'fork' : scenario === 'stale-token' ? 'exec'
    : scenario === 'reload-generation' ? 'barrier' : scenario;
  const args = [binary, 'fixture', generation, nonce, socket, deadline, fixture];
  let owner = preparedOwner({ generation, nonce, boot: clock.value.boot, domain, label, socket, plist, args,
    binaryDigest: createHash('sha256').update(readFileSync(binary)).digest('hex'), deadline });
  const outcome = { generation, pending: true, scenario, verdict: 'NOT_VERIFIED', durableStates: ['PREPARED'], release: false,
    dispatch: 'OPEN', stop: 'UNKNOWN', cleanup: 'RETAINED' };
  report.scenarios.push(outcome);
  publishOwner(journal, owner);
  function checkpoint(point) {
    if (fault && scenario === point) {
      writeFileSync(join(directory, `${generation}.outcome`), JSON.stringify(outcome), { mode: 0o600, flag: 'wx' });
      // Actual process death: finally is not executed; native session observes controller EOF.
      process.exit(86);
    }
  }
  const controller = session(binary, socket, nonce, generation, deadline);
  const listen = await controller.next();
  if (listen.event !== 'LISTEN' || !listen.controller?.coalition) throw new Error('CONTROLLER_LISTEN');
  const sentinel = spawn(binary, ['leaf', deadline], { shell: false, stdio: 'ignore' });
  const sentinelClosed = new Promise(resolveClose => sentinel.once('close', (code, signal) => resolveClose({ code, signal })));
  let sentinelBinding;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = native(binary, ['identity', String(sentinel.pid)]);
    if (result.status === 0) { sentinelBinding = result.value.identity; break; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
  }
  if (!sentinelBinding) throw new Error('SENTINEL_IDENTITY');
  const contents = fixturePlist(label, binary, args);
  writeFileSync(plist, contents, { flag: 'wx', mode: 0o600 });
  owner = transitionOwner(owner, owner.revision, 'PREPARED', { socketIdentity: objectIdentity(socket, 'socket'),
    lockIdentity: objectIdentity(`${socket}.lock`, 'file'), controller: listen.controller,
    sentinel: sentinelBinding,
    plistIdentity: objectIdentity(plist, 'file'), plistDigest: createHash('sha256').update(contents).digest('hex') });
  publishOwner(journal, owner); outcome.durableStates.push('PREPARED_ARTIFACTS_BOUND');
  let registered = false, matching = false, absent;
  try {
    const validation = run('/usr/bin/plutil', ['-lint', '--', plist], 5000);
    outcome.plistValidation = bootstrapEvidence(validation);
    if (validation.status !== 0 || validation.error || validation.signal) throw new Error('PLIST_INVALID_OR_UNAVAILABLE');
    const contention = native(binary, ['try-lease', `${socket}.lock`]);
    outcome.nativeLockContention = contention.value;
    if (contention.value.acquired !== false || contention.value.contended !== true) throw new Error('LEASE_NOT_EXCLUSIVE');
    if (scenario === 'crash-before-bootstrap') {
      checkpoint(scenario);
      safeOwnerFile(journal, owner);
      owner = transitionOwner(owner, owner.revision, 'NEVER_LAUNCHED'); publishOwner(journal, owner);
      outcome.stop = 'NEVER_LAUNCHED'; outcome.verdict = 'PASS'; return;
    }
    outcome.managerHealth = [];
    if (!await health(domain, outcome.managerHealth)) throw new Error('DOMAIN_UNAVAILABLE');
    const negativeLabel = `com.ebb.phase2.absent.${randomUUID()}`;
    const negative = run('/bin/launchctl', ['print', `${domain}/${negativeLabel}`], 5000);
    if (!await health(domain) || negative.status === 0 || negative.error || negative.signal || !negative.stderr.includes(negativeLabel)) throw new Error('ABSENCE_CALIBRATION');
    absent = normalized(negative, negativeLabel);
    if (objectIdentity(socket, 'socket') !== owner.socketIdentity || objectIdentity(plist, 'file') !== owner.plistIdentity
      || createHash('sha256').update(readFileSync(plist)).digest('hex') !== owner.plistDigest) throw new Error('ARTIFACT_CHANGED');
    owner = transitionOwner(owner, owner.revision, 'LAUNCHING'); publishOwner(journal, owner); outcome.durableStates.push('LAUNCHING');
    const bootstrap = run('/bin/launchctl', ['bootstrap', domain, plist], 5000);
    registered = true; outcome.bootstrap = bootstrapEvidence(bootstrap);
    if (bootstrap.status !== 0 || bootstrap.error || bootstrap.signal) {
      outcome.bootstrapFailureReadback = await managerRead(owner, binary, 'static', absent);
      // Nonzero bootstrap never proves NEVER_LAUNCHED, even when the exact job is currently absent.
      throw new Error('BOOTSTRAP_UNCERTAIN');
    }
    const registration = await managerRead(owner, binary, 'registered', absent); outcome.registration = registration;
    if (registration.classification !== 'MATCH' || registration.pid !== null) throw new Error('REGISTRATION_UNVERIFIED');
    matching = true;
    const kick = run('/bin/launchctl', ['kickstart', `${domain}/${label}`], 5000);
    outcome.kickstart = { status: kick.status, error: kick.error };
    if (kick.status !== 0 || kick.error || kick.signal) throw new Error('DISPATCH_UNCERTAIN');
    const ready = await controller.next();
    if (ready.event !== 'READY' || ready.frame?.protocol !== 2 || ready.frame.nonce !== nonce || ready.frame.generation !== generation
      || ready.frame.scenario !== fixture || Object.keys(ready.frame).sort().join(',') !== 'generation,nonce,protocol,scenario') throw new Error('BARRIER_MISMATCH');
    async function prepareHandoff(point) {
      if (fault && scenario === point) {
        controller.child.stdin.write(`HANDOFF ${nonce}\n`);
        if ((await controller.next()).event !== 'HANDOFF') throw new Error('BARRIER_HANDOFF_UNAVAILABLE');
        outcome.handoff = true;
        outcome.faultPoint = point === 'crash-after-dispatch' ? 'AFTER_DISPATCH_BEFORE_APPLICATION_KERNEL_READBACK' : 'AFTER_READBACK_BEFORE_DURABLE_BIND';
        checkpoint(point);
      }
    }
    await prepareHandoff('crash-after-dispatch');
    const running = await managerRead(owner, binary, 'running', absent); outcome.running = running;
    if (running.classification !== 'MATCH' || running.pid !== ready.root.pid) { matching = false; throw new Error('ROOT_READBACK_UNVERIFIED'); }
    const fresh = native(binary, ['identity', String(ready.root.pid)]);
    if (fresh.status !== 0 || fresh.value.boot !== owner.boot || JSON.stringify(fresh.value.identity) !== JSON.stringify(ready.root)
      || ready.root.coalition === listen.controller.coalition) throw new Error('ROOT_KERNEL_MISMATCH');
    outcome.binding = ready.root;
    const live = native(binary, ['usage', ready.root.coalition]); outcome.liveAccounting = live.value;
    const preAckMembers = native(binary, ['members', ready.root.coalition]);
    if (live.status !== 0 || BigInt(live.value.started) - BigInt(live.value.exited) !== 1n
      || preAckMembers.value.members.length !== 1 || preAckMembers.value.members[0].unique !== ready.root.unique) throw new Error('PRE_ACK_NO_DESCENDANTS_UNVERIFIED');
    outcome.preAckAccounting = live.value;
    outcome.preAckNoDescendants = true;
    await prepareHandoff('crash-before-bind');
    if (scenario === 'crash-after-dispatch' || scenario === 'crash-before-bind') {
      controller.child.stdin.end(); await controller.closed;
      outcome.reason = 'NO_DURABLE_COALITION_AFTER_PRE_ACK_DEATH'; outcome.release = false; return;
    }
    const absenceCalibration = calibrateAbsence(binary, ready.root.coalition, owner.boot);
    owner = transitionOwner(owner, owner.revision, 'BOUND', { root: ready.root, coalition: ready.root.coalition, absenceCalibration,
      bindingProof: { priorSuccessfulQuery: true, coalition: ready.root.coalition, boot: owner.boot, sourcePin, binaryDigest: owner.binaryDigest } });
    if (!checkSentinel(binary, owner)) throw new Error('SENTINEL_MEMBERSHIP');
    outcome.sentinelOutsideScope = true;
    publishOwner(journal, owner); safeOwnerFile(journal, owner); outcome.durableStates.push('BOUND');
    checkpoint('crash-before-ack');
    if (scenario !== 'crash-before-ack') {
      controller.child.stdin.write(`ACK ${nonce} ${owner.revision}\n`);
      const release = await controller.next();
      if (release.event !== 'RELEASE' || release.sent !== true) throw new Error('ACK_UNCERTAIN');
      outcome.release = true;
      owner = transitionOwner(owner, owner.revision, 'RELEASED'); publishOwner(journal, owner); outcome.durableStates.push('RELEASED');
      // Отдельный deadline позволяет detached descendants появиться; это не final stop proof.
      await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
      const after = native(binary, ['usage', owner.coalition]); outcome.afterReleaseAccounting = after.value;
      if (after.status !== 0 || BigInt(after.value.started) <= BigInt(after.value.exited)) throw new Error('POST_RELEASE_LIVE_UNVERIFIED');
      const discovered = native(binary, ['members', owner.coalition]); outcome.members = discovered.value.members;
      const expectedCount = fixture === 'burst' ? 13 : ['fork', 'spawn', 'setsid'].includes(fixture) ? 2 : 1;
      if (discovered.status !== 0 || discovered.value.members.length < expectedCount
        || discovered.value.members.some(value => value.coalition !== owner.coalition)) throw new Error('DESCENDANT_MEMBERSHIP_UNVERIFIED');
      if (['root-exit', 'doublefork'].includes(fixture)
        && discovered.value.members.some(value => value.unique === owner.root.unique)) throw new Error('DETACHED_ROOT_STILL_LIVE');
      if (['setsid', 'root-exit', 'doublefork'].includes(fixture)
        && !discovered.value.members.some(value => value.session !== owner.root.session)) throw new Error('DETACHED_SESSION_UNVERIFIED');
      if (BigInt(after.value.started) < BigInt(live.value.started) || BigInt(after.value.exited) < BigInt(live.value.exited)) throw new Error('COUNTERS_NOT_MONOTONIC');
      if (fixture === 'exec') {
        const refreshed = discovered.value.members.find(value => value.pid === owner.root.pid && value.unique === owner.root.unique);
        if (!refreshed || refreshed.pidversion === owner.root.pidversion) throw new Error('EXEC_VERSION_NOT_CHANGED');
        const stale = signalBinding(binary, owner.root, 'stale'); outcome.staleToken = stale.value;
        const stillLive = native(binary, ['identity', String(refreshed.pid)]);
        if (stale.value.result === 0 || stillLive.status !== 0 || !checkSentinel(binary, owner)) throw new Error('STALE_TOKEN_NEGATIVE');
        outcome.staleTokenRejected = true;
      }
      checkpoint('crash-after-ack');
    }
    const beforeBootout = await managerRead(owner, binary, 'static', absent);
    // После root-exit менеджер может не иметь PID, но exact static binding всё ещё обязана совпасть.
    if (beforeBootout.classification !== 'MATCH') { matching = false; throw new Error('CLOSURE_BINDING_UNVERIFIED'); }
    const bootout = run('/bin/launchctl', ['bootout', `${domain}/${label}`], 5000);
    outcome.bootout = { status: bootout.status, error: bootout.error };
    const closure = await managerRead(owner, binary, 'registered', absent); outcome.closure = closure;
    if (bootout.status !== 0 || bootout.error || closure.classification !== 'ABSENT') throw new Error('DISPATCH_NOT_CLOSED');
    outcome.dispatch = 'CLOSED'; registered = false;
    safeOwnerFile(journal, owner);
    if (native(binary, ['clock']).value.boot !== owner.boot) throw new Error('BOOT_CHANGED');
    const stopped = native(binary, ['stop', owner.coalition], 31_000); outcome.kernelStop = stopped.value;
    outcome.stopProofKind = stopProof(stopped.value.usage, owner, native(binary, ['clock']).value.boot, outcome.dispatch);
    if (stopped.value.denied !== 0 || outcome.stopProofKind === 'UNKNOWN') throw new Error('KERNEL_STOP_UNVERIFIED');
    if (!checkSentinel(binary, owner)) throw new Error('SENTINEL_STOP_ISOLATION');
    outcome.sentinelAliveAfterStop = true;
    const final = native(binary, ['usage', owner.coalition]); outcome.finalAccounting = final.value;
    if (stopProof(final.value, owner, native(binary, ['clock']).value.boot, outcome.dispatch) === 'UNKNOWN') throw new Error('FINAL_STOP_UNVERIFIED');
    owner = transitionOwner(owner, owner.revision, 'STOPPED'); publishOwner(journal, owner);
    outcome.stop = 'STOPPED'; outcome.durableStates.push('STOPPED');
    outcome.verdict = 'PASS';
  } catch (error) {
    outcome.verdict = 'FAIL'; outcome.reason = error.message;
  } finally {
    if (owner.sentinel) {
      outcome.sentinelAliveBeforeCleanup = checkSentinel(binary, owner);
      const result = stopSentinel(binary, owner); outcome.sentinelCleanup = result.verdict;
      outcome.sentinelObservation = result.observation;
      if (result.verdict === 'PASS') {
        const closed = await sentinelClosed;
        outcome.sentinelCleanup = closed.signal === 'SIGTERM' ? 'PASS' : 'FAIL';
      }
    }
    // UNKNOWN retains owner. Exact matched job teardown is safety cleanup, never STOP evidence.
    if (registered && matching) {
      const readback = await managerRead(owner, binary, 'static', absent);
      if (readback.classification === 'MATCH') run('/bin/launchctl', ['bootout', `${domain}/${label}`], 5000);
    }
    if (['STOPPED', 'NEVER_LAUNCHED'].includes(owner.state)) {
      let cleanupAllowed = outcome.sentinelCleanup === 'PASS';
      const held = native(binary, ['try-lease', `${socket}.lock`]);
      if (held.value.contended !== true || held.value.acquired !== false) { cleanupAllowed = false; outcome.reason = 'LEASE_LOST_BEFORE_CLEANUP'; }
      if (owner.state === 'STOPPED') {
        const check = native(binary, ['usage', owner.coalition]);
        if (stopProof(check.value, owner, native(binary, ['clock']).value.boot, outcome.dispatch) === 'UNKNOWN') { outcome.cleanup = 'RETAINED'; cleanupAllowed = false; }
      }
      if (cleanupAllowed && objectIdentity(socket, 'socket') === owner.socketIdentity && objectIdentity(plist, 'file') === owner.plistIdentity) {
        rmSync(socket); rmSync(plist); rmSync(journal); outcome.cleanup = 'PASS';
      }
    }
    controller.child.stdin.end(); await controller.closed;
    if (outcome.cleanup === 'PASS') rmSync(`${socket}.lock`);
  }
}

async function recoverFault(binary, directory, generation, scenario, report) {
  const journal = join(directory, `${generation}.json`);
  const outcome = JSON.parse(readFileSync(join(directory, `${generation}.outcome`), 'utf8'));
  report.scenarios.push(outcome);
  const clock = native(binary, ['clock']).value;
  const socket = phase2SocketPath(directory, generation, clock.socketPathCapacity);
  let lock, leaseEvent;
  if (outcome.handoff) {
    // Только routing hint до lease; все authority fields заново читаются после SCM_RIGHTS transfer.
    objectIdentity(journal, 'file');
    const hint = JSON.parse(readFileSync(journal, 'utf8'));
    if (!/^[0-9a-f-]{36}$/i.test(hint.nonce) || hint.boot !== clock.boot) throw new Error('RECOVERY_ROUTING_HINT');
    lock = session(binary, socket, hint.nonce, generation, '0', 'recover', hint.boot);
    leaseEvent = await lock.next();
    if (leaseEvent.event !== 'LEASE_BARRIER') {
      lock.child.stdin.end(); await lock.closed;
      outcome.stop = 'UNKNOWN'; outcome.verdict = 'NOT_VERIFIED'; outcome.reason = 'CURRENT_BARRIER_TRANSFER_UNAVAILABLE'; return;
    }
  } else {
    lock = session(binary, socket, '', generation, '0', true);
    leaseEvent = await lock.next();
    if (leaseEvent.event !== 'LEASE') throw new Error('RECOVERY_OWNER_LEASE');
  }
  let owner;
  try {
    // Никакой pre-lock snapshot не authoritative: весь journal заново читается после exclusive lease.
    objectIdentity(journal, 'file');
    owner = JSON.parse(readFileSync(journal, 'utf8'));
    if (owner.schemaVersion !== 2 || owner.generation !== generation || owner.socket !== socket
      || owner.plist !== join(directory, `${generation}.plist`) || owner.label !== `com.ebb.phase2.${generation}`
      || owner.domain !== `user/${process.getuid()}` || owner.binaryDigest !== createHash('sha256').update(readFileSync(binary)).digest('hex')
      || objectIdentity(owner.socket, 'socket') !== owner.socketIdentity || objectIdentity(owner.plist, 'file') !== owner.plistIdentity
      || objectIdentity(`${owner.socket}.lock`, 'file') !== owner.lockIdentity
      || createHash('sha256').update(readFileSync(owner.plist)).digest('hex') !== owner.plistDigest) throw new Error('RECOVERY_OWNER_MISMATCH');
    safeOwnerFile(journal, owner);
    if (native(binary, ['clock']).value.boot !== owner.boot) throw new Error('RECOVERY_BOOT_MISMATCH');
    const contention = native(binary, ['try-lease', `${socket}.lock`]);
    if (contention.value.acquired !== false || contention.value.contended !== true) throw new Error('RECOVERY_LEASE_NOT_EXCLUSIVE');
    outcome.recovery = { independentController: true, journalState: owner.state, kernelWasDurable: owner.coalition !== null };
    if (owner.state === 'PREPARED') {
      owner = transitionOwner(owner, owner.revision, 'NEVER_LAUNCHED'); publishOwner(journal, owner);
      outcome.stop = 'NEVER_LAUNCHED'; outcome.release = false; outcome.verdict = 'PASS';
    } else if (owner.state === 'LAUNCHING') {
      const current = await managerRead(owner, binary, 'running'); outcome.recovery.current = current;
      const authenticated = barrierTransferMatches(leaseEvent, owner, current);
      if (!authenticated) {
        outcome.stop = 'UNKNOWN'; outcome.release = false; outcome.verdict = 'NOT_VERIFIED';
        outcome.reason = 'CURRENT_BARRIER_REQUIRED_FOR_NULL_COALITION'; return;
      }
      const fresh = native(binary, ['identity', String(leaseEvent.root.pid)]);
      if (fresh.status !== 0 || fresh.value.boot !== owner.boot || JSON.stringify(fresh.value.identity) !== JSON.stringify(leaseEvent.root)) throw new Error('RECOVERY_CURRENT_ROOT_MISMATCH');
      const live = native(binary, ['usage', leaseEvent.root.coalition]);
      if (!live.value.validPrefix || BigInt(live.value.started) - BigInt(live.value.exited) !== 1n) throw new Error('RECOVERY_PRE_ACK_SCOPE_UNVERIFIED');
      safeOwnerFile(journal, owner);
      lock.child.stdin.write(`ACCEPT ${owner.nonce} ${owner.revision}\n`);
      const accepted = await lock.next();
      if (accepted.event !== 'ACCEPTED' || accepted.revision !== owner.revision) throw new Error('RECOVERY_RECEIVER_ACK');
      const calibration = calibrateAbsence(binary, leaseEvent.root.coalition, owner.boot);
      owner = transitionOwner(owner, owner.revision, 'BOUND', { root: leaseEvent.root, coalition: leaseEvent.root.coalition,
        absenceCalibration: calibration, bindingProof: { priorSuccessfulQuery: true, coalition: leaseEvent.root.coalition,
          boot: owner.boot, sourcePin, binaryDigest: owner.binaryDigest } });
      publishOwner(journal, owner); safeOwnerFile(journal, owner);
      outcome.recovery.boundWithoutACK = true; outcome.release = false;
    }
    if (owner.state === 'BOUND' || owner.state === 'RELEASED') {
      if (!owner.coalition || !owner.root) throw new Error('RECOVERY_KERNEL_BINDING');
      const live = native(binary, ['usage', owner.coalition]); outcome.recovery.accounting = live.value;
      if (scenario === 'crash-after-ack') {
        const found = native(binary, ['members', owner.coalition]); outcome.recovery.members = found.value.members;
        if (!live.value.validPrefix || BigInt(live.value.started) <= BigInt(live.value.exited)
          || !found.value.members.some(value => value.unique !== owner.root.unique)) throw new Error('RECOVERY_DETACHED_LEAF_NOT_LIVE');
      }
      if (!checkSentinel(binary, owner)) throw new Error('RECOVERY_SENTINEL_MEMBERSHIP');
      const negativeLabel = `com.ebb.phase2.absent.${randomUUID()}`;
      if (!await health(owner.domain)) throw new Error('RECOVERY_DOMAIN_UNAVAILABLE');
      const absentResult = run('/bin/launchctl', ['print', `${owner.domain}/${negativeLabel}`], 5000);
      if (!await health(owner.domain) || absentResult.status === 0 || absentResult.error || absentResult.signal
        || !absentResult.stderr.includes(negativeLabel)) throw new Error('RECOVERY_ABSENCE_CALIBRATION');
      const absent = normalized(absentResult, negativeLabel);
      const current = await managerRead(owner, binary, 'static', absent);
      if (current.classification === 'MATCH') {
        const result = run('/bin/launchctl', ['bootout', `${owner.domain}/${owner.label}`], 5000);
        if (result.status !== 0 || result.error || result.signal) throw new Error('RECOVERY_BOOTOUT');
      } else if (current.classification !== 'ABSENT') throw new Error('RECOVERY_JOB_BINDING');
      const closure = await managerRead(owner, binary, 'static', absent); outcome.recovery.closure = closure;
      if (closure.classification !== 'ABSENT') throw new Error('RECOVERY_DISPATCH_OPEN');
      outcome.dispatch = 'CLOSED';
      const stop = native(binary, ['stop', owner.coalition], 31_000); outcome.recovery.kernelStop = stop.value;
      outcome.recovery.stopProofKind = stopProof(stop.value.usage, owner, native(binary, ['clock']).value.boot, outcome.dispatch);
      if (stop.value.denied !== 0 || outcome.recovery.stopProofKind === 'UNKNOWN') throw new Error('RECOVERY_STOP_UNKNOWN');
      if (!checkSentinel(binary, owner)) throw new Error('RECOVERY_SENTINEL_STOP_ISOLATION');
      outcome.sentinelAliveAfterStop = true;
      owner = transitionOwner(owner, owner.revision, 'STOPPED'); publishOwner(journal, owner);
      outcome.stop = 'STOPPED'; outcome.verdict = 'PASS';
    } else if (owner.state !== 'NEVER_LAUNCHED') throw new Error('RECOVERY_STATE');
  } catch (error) { outcome.verdict = 'FAIL'; outcome.reason = error.message; }
  finally {
    if (owner?.sentinel) {
      outcome.sentinelAliveBeforeCleanup = checkSentinel(binary, owner);
      const result = stopSentinel(binary, owner);
      outcome.sentinelCleanup = result.verdict; outcome.sentinelObservation = result.observation;
    }
    if (outcome.verdict === 'PASS' && outcome.sentinelCleanup === 'PASS' && ['STOPPED', 'NEVER_LAUNCHED'].includes(owner?.state)) {
      const held = native(binary, ['try-lease', `${socket}.lock`]);
      let allowed = held.value.contended === true && held.value.acquired === false;
      if (owner.state === 'STOPPED') {
        const fresh = native(binary, ['usage', owner.coalition]);
        allowed &&= stopProof(fresh.value, owner, native(binary, ['clock']).value.boot, outcome.dispatch) !== 'UNKNOWN';
      }
      if (allowed) {
        safeOwnerFile(journal, owner);
        rmSync(owner.socket); rmSync(owner.plist); rmSync(journal); outcome.cleanup = 'PASS';
      }
    }
    lock.child.stdin.end(); await lock.closed;
    if (outcome.cleanup === 'PASS') { rmSync(`${socket}.lock`); rmSync(join(directory, `${generation}.outcome`)); }
  }
}

function persistGenerations(directory, report) {
  report.parentLedger ??= { generation: randomUUID(), nonce: randomUUID(), boot: 'PARENT_REPORT', revision: -1 };
  const next = { ...report.parentLedger, revision: report.parentLedger.revision + 1,
    scenarios: report.scenarios, noNextDispatch: report.noNextDispatch === true };
  publishOwner(join(directory, 'parent-generations.json'), next);
  report.parentLedger = { generation: next.generation, nonce: next.nonce, boot: next.boot, revision: next.revision };
}

/** Durable parent intent precedes child execution; every ambiguous child/recovery result retains its owner and blocks dispatch. */
export async function runFaultGeneration({ report, directory, binary, generation, scenario,
  command = run, recover = recoverFault, persist = () => persistGenerations(directory, report) }) {
  const pending = { generation, scenario, pending: true, verdict: 'NOT_VERIFIED',
    stop: 'UNKNOWN', cleanup: 'RETAINED', dispatch: 'NOT_PROVEN_CLOSED', disposition: 'NO_NEXT_DISPATCH_UNTIL_RECOVERY' };
  report.scenarios.push(pending);
  try {
    persist();
    const crashed = command(process.execPath, [fileURLToPath(import.meta.url), directory,
      '--fault-controller', binary, generation, scenario], 60_000);
    pending.childResult = crashed;
    if (crashed.status !== 86 || crashed.signal || crashed.error) throw new Error('FAULT_CONTROLLER_DID_NOT_CRASH');
    const before = report.scenarios.length;
    await recover(binary, directory, generation, scenario, report);
    const outcomes = report.scenarios.splice(before);
    if (outcomes.length !== 1 || outcomes[0].scenario !== scenario) throw new Error('MISSING_RECOVERY_OUTCOME');
    Object.assign(pending, outcomes[0], { generation });
    if (!['STOPPED', 'NEVER_LAUNCHED'].includes(pending.stop) || pending.cleanup !== 'PASS') throw new Error('RECOVERY_UNRESOLVED_OWNER');
    pending.pending = false; pending.disposition = 'EXACT_CLEANUP_COMPLETE'; persist(); return true;
  } catch (error) {
    Object.assign(pending, { pending: true, stop: 'UNKNOWN', cleanup: 'RETAINED', verdict: 'FAIL', reason: error.message });
    report.noNextDispatch = true;
    try { persist(); } catch (persistenceError) { pending.persistenceError = persistenceError.message; }
    return false;
  }
}

/** Recursive cleanup requires settled generations and absence of all owned journals/artifacts; missing proof retains the root. */
export function canRemoveFixtureRoot(directory, report) {
  try {
    if (report.noNextDispatch || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) return false;
    const settled = values => values.every(value => value.generation
      ? value.pending === false && ['STOPPED', 'NEVER_LAUNCHED'].includes(value.stop) && value.cleanup === 'PASS'
      : value.cleanup !== 'RETAINED' && value.stop !== 'UNKNOWN');
    if (!settled(report.scenarios)) return false;
    const names = readdirSync(directory);
    if (names.some(name => !['fixture', 'parent-generations.json'].includes(name))) return false;
    if (names.includes('parent-generations.json')) {
      objectIdentity(join(directory, 'parent-generations.json'), 'file');
      const ledger = JSON.parse(readFileSync(join(directory, 'parent-generations.json'), 'utf8'));
      if (!report.parentLedger || ledger.revision !== report.parentLedger.revision
        || ledger.generation !== report.parentLedger.generation || ledger.nonce !== report.parentLedger.nonce
        || !Array.isArray(ledger.scenarios) || ledger.noNextDispatch || !settled(ledger.scenarios)
        || JSON.stringify(ledger.scenarios) !== JSON.stringify(report.scenarios)) return false;
    }
    return true;
  } catch { return false; }
}

async function phase2(output) {
  const started = process.hrtime.bigint();
  const report = { schemaVersion: 2, phase: 'coalition-lifecycle', sourcePin, platformReadiness: 'NOT_CLAIMED',
    phaseVerdict: 'NOT_VERIFIED', scenarios: [], productionPackaging: 'NOT_RUN', fullABICompatibility: 'NOT_CLAIMED' };
  if (process.platform !== 'darwin') {
    Object.assign(report, { phaseVerdict: 'NOT_RUN', reason: 'MACOS_REQUIRED' });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); process.exitCode = 1; return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'ebb-macos-phase2-'));
  let binary;
  try {
    report.sourceSHA = run('/usr/bin/git', ['rev-parse', 'HEAD']).stdout;
    report.platform = { osVersion: run('/usr/bin/sw_vers', ['-productVersion']), osBuild: run('/usr/bin/sw_vers', ['-buildVersion']),
      arch: run('/usr/bin/uname', ['-m']), sdk: run('/usr/bin/xcrun', ['--show-sdk-version']), compiler: run('/usr/bin/xcrun', ['clang++', '--version']) };
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('NODE24_REQUIRED');
    binary = join(directory, 'fixture');
    report.fixturePackageBuild = run('/usr/bin/xcrun', ['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
      resolve('scripts/macos-runtime-feasibility.cpp'), '-o', binary]);
    if (report.fixturePackageBuild.status !== 0) throw new Error('NATIVE_BUILD_FAILED');
    report.fixtureDigest = createHash('sha256').update(readFileSync(binary)).digest('hex');
    report.fixturePackageInvocation = native(binary, ['clock']);
    if (report.fixturePackageInvocation.status !== 0) throw new Error('NATIVE_PACKAGE_INVOCATION_FAILED');
    const ordered = [...scenarios.filter(value => !['crash-after-dispatch', 'crash-before-bind'].includes(value)), 'crash-after-dispatch', 'crash-before-bind'];
    for (const scenario of ordered) {
      if (process.hrtime.bigint() - started > 500_000_000_000n) throw new Error('OVERALL_DEADLINE');
      if (scenario === 'malformed-owner') {
        const path = join(directory, `negative-${randomUUID()}.json`);
        writeFileSync(path, '{"state":"BOUND","coalition":null}', { flag: 'wx', mode: 0o600 });
        let rejected = false;
        try { safeOwnerFile(path, preparedOwner({ generation: randomUUID() })); } catch { rejected = true; }
        rmSync(path);
        report.scenarios.push({ scenario, verdict: rejected ? 'PASS' : 'FAIL', dispatch: 'NEVER_AUTHORIZED', cleanup: 'PASS' }); continue;
      }
      if (scenario === 'manager-unavailable') {
        const result = run('/bin/launchctl', ['print', `ebb-invalid-domain/${randomUUID()}`], 5000);
        const classification = classifyManagerResult(result, { healthBefore: false, healthAfter: false });
        report.scenarios.push({ scenario, verdict: classification === 'UNKNOWN' ? 'PASS' : 'FAIL',
          classification, dispatch: 'NEVER_AUTHORIZED', cleanup: 'PASS' }); continue;
      }
      if (scenario.startsWith('crash-')) {
        const generation = randomUUID();
        if (!await runFaultGeneration({ report, directory, binary, generation, scenario })) break;
      } else {
        const previous = report.scenarios.find(value => value.scenario === 'barrier')?.binding;
        await exercise(binary, directory, scenario, report);
        const completed = report.scenarios.at(-1);
        if (['STOPPED', 'NEVER_LAUNCHED'].includes(completed.stop) && completed.cleanup === 'PASS') completed.pending = false;
        if (scenario === 'reload-generation' && report.scenarios.at(-1).verdict === 'PASS') {
          const outcome = report.scenarios.at(-1);
          const rejected = previous ? signalBinding(binary, previous) : null;
          outcome.oldGenerationRejected = Boolean(previous && previous.coalition !== outcome.binding.coalition && rejected?.value.bound === false);
          if (!outcome.oldGenerationRejected) { outcome.verdict = 'FAIL'; outcome.reason = 'GENERATION_REUSE_OR_OLD_BINDING_ACCEPTED'; }
        }
      }
      if (report.scenarios.at(-1).stop === 'UNKNOWN') break; // Не запускать следующий job при unresolved owner.
    }
    for (const scenario of scenarios) if (!report.scenarios.some(value => value.scenario === scenario)) {
      report.scenarios.push({ scenario, verdict: 'NOT_RUN', reason: 'PRIOR_UNRESOLVED_OWNER' });
    }
    report.phaseVerdict = feasibilityVerdict(report.scenarios);
  } catch (error) { report.phaseVerdict = 'FAIL'; report.reason = error.message; }
  finally {
    if (report.parentLedger) {
      try { persistGenerations(directory, report); } catch (error) { report.noNextDispatch = true; report.parentLedgerError = error.message; }
    }
    const retain = !canRemoveFixtureRoot(directory, report);
    if (retain) report.phaseVerdict = 'FAIL';
    report.temporaryCleanup = retain ? 'RETAINED_UNKNOWN_OWNER' : 'PASS';
    report.disposition = retain ? 'BLOCKED_RETAINED_OWNER_NO_NEXT_DISPATCH' : 'NO_RETAINED_OWNER';
    report.ciExitCode = report.phaseVerdict === 'PASS' ? 0 : 1;
    // Binary remains with unresolved identities; no recursive delete on UNKNOWN.
    if (!retain) rmSync(directory, { recursive: true, force: false });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = report.phaseVerdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] ?? 'temp/macos-runtime-feasibility.json');
  if (process.argv[3] === '--fault-controller') {
    await exercise(process.argv[4], process.argv[2], process.argv[6], { scenarios: [] }, process.argv[5], true);
    process.exitCode = 1;
  } else if (process.argv[3] === '--phase2') await phase2(output);
  else phase1(output);
}
