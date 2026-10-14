import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_ATTESTATION,
  lifecycleScenarios,
  sanitizeHostFacts,
  summarizeEvidence,
  validateEvidence,
  validateHarnessStatus,
} from './contract.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(packageRoot, '..', '..');
const evidenceName = 'evidence.json';
const knownReasons = Object.freeze({
  HOST_NOT_MACOS: 'The preflight host is not macOS.',
  PHYSICAL_HOST_ATTESTATION_REQUIRED: 'Physical Apple Silicon host attestation is required.',
  HOST_IDENTITY_UNSUPPORTED: 'Host identity does not satisfy Apple Silicon/macOS 13.5+.',
  VIRTUALIZATION_ENTITLEMENT_UNAVAILABLE: 'This disposable harness has no signed, entitled VM controller package.',
  VIRTUALIZATION_FRAMEWORK_UNAVAILABLE: 'The installed Swift toolchain could not type-check the required public Virtualization APIs.',
  LIVE_VM_REATTACH_API_UNAVAILABLE: 'Public Virtualization APIs document restoring a stopped VM, not attaching to the same live VM after controller restart.',
  VM_CONTROLLER_NOT_IMPLEMENTED: 'No production or spike VM controller is installed by this isolated harness.',
  LIFECYCLE_NOT_VERIFIED: 'The full lifecycle matrix has not passed on the physical host.',
  EVIDENCE_MISSING: 'Preflight evidence is missing for this exact Ebb SHA.',
  EVIDENCE_INVALID: 'Evidence structure or exact SHA does not match this checkout.',
  SCENARIO_REQUIRED: 'Use one scenario name from the Plan20 allowlist.',
  SCENARIO_UNKNOWN: 'Scenario is not in the Plan20 allowlist.',
  MANIFEST_WRITE_FAILED: 'Evidence could not be written to the exact-SHA temp directory.',
  HOST_COMMAND_UNAVAILABLE: 'A fixed host identity command failed or returned an invalid value.',
  HARNESS_NOT_EXACT_SHA: 'Harness source is modified or untracked and does not match the exact Ebb SHA.',
});

const args = process.argv.slice(2);
const command = args.shift();

try {
  const sha = readExactSha();
  const evidenceDir = join(repoRoot, 'temp', 'plan20-macos-feasibility', sha);
  if (command === 'preflight') await preflight(sha, evidenceDir);
  else if (command === 'lifecycle') await lifecycle(sha, evidenceDir, args);
  else if (command === 'provider') await provider(sha, evidenceDir);
  else if (command === 'report') await report(sha, evidenceDir);
  else fail('SCENARIO_UNKNOWN');
} catch (error) {
  // Never forward exception text, child output, paths, or arbitrary strings to the terminal.
  const code = typeof error?.code === 'string' && Object.hasOwn(knownReasons, error.code) ? error.code : 'EVIDENCE_INVALID';
  emit({ verdict: 'NOT_VERIFIED', code, explanation: knownReasons[code], rawCommandOutputRetained: false });
  process.exitCode = 1;
}

async function preflight(sha, evidenceDir) {
  await assertDisposableEvidenceDirectory(evidenceDir);
  const evidence = await loadOrCreateEvidence(sha, evidenceDir);
  if (process.platform !== 'darwin') {
    evidence.host = { status: 'NOT_VERIFIED', facts: sanitizeHostFacts({}), operatorPhysicalAppleSiliconAttestation: false };
    evidence.gates.preflight = 'NOT_RUN';
    evidence.preflightReason = 'HOST_NOT_MACOS';
    await saveEvidence(evidenceDir, evidence);
    emit(summarizeEvidence(evidence));
    process.exitCode = 1;
    return;
  }

  let facts;
  try { facts = await collectHostFacts(); }
  catch {
    evidence.host = { status: 'NOT_VERIFIED', facts: sanitizeHostFacts({}), operatorPhysicalAppleSiliconAttestation: false };
    evidence.gates.preflight = 'FAIL';
    evidence.preflightReason = 'HOST_COMMAND_UNAVAILABLE';
    await saveEvidence(evidenceDir, evidence);
    emit(summarizeEvidence(evidence));
    process.exitCode = 1;
    return;
  }
  const virtualizationFrameworkCompile = probeVirtualizationApi();
  if (!virtualizationFrameworkCompile) {
    evidence.host = { status: 'NOT_VERIFIED', facts: sanitizeHostFacts(facts), operatorPhysicalAppleSiliconAttestation: false,
      virtualizationFrameworkCompile: 'FAIL', signedVirtualizationEntitlement: 'NOT_AVAILABLE_IN_DISPOSABLE_HARNESS' };
    evidence.gates.preflight = 'FAIL';
    evidence.preflightReason = 'VIRTUALIZATION_FRAMEWORK_UNAVAILABLE';
    await saveEvidence(evidenceDir, evidence);
    emit(summarizeEvidence(evidence));
    process.exitCode = 1;
    return;
  }
  const attestation = await requestAttestation();
  const hostSupported = facts.architecture === 'arm64'
    && facts.arm64Flag === '1'
    && compareVersions(facts.macOSVersion, '13.5') >= 0
    && facts.model !== 'UNAVAILABLE';
  evidence.host = {
    status: hostSupported && attestation ? 'PASS' : 'NOT_VERIFIED',
    facts: sanitizeHostFacts(facts),
    operatorPhysicalAppleSiliconAttestation: attestation,
    virtualizationFrameworkCompile: 'PASS',
    signedVirtualizationEntitlement: 'NOT_AVAILABLE_IN_DISPOSABLE_HARNESS',
  };
  evidence.gates.preflight = 'FAIL';
  evidence.preflightReason = !attestation ? 'PHYSICAL_HOST_ATTESTATION_REQUIRED' : !hostSupported ? 'HOST_IDENTITY_UNSUPPORTED' : 'VIRTUALIZATION_ENTITLEMENT_UNAVAILABLE';
  // No VM is created until a signed entitled controller and reattach design are proven.
  await saveEvidence(evidenceDir, evidence);
  emit(summarizeEvidence(evidence));
  process.exitCode = 1;
}

async function lifecycle(sha, evidenceDir, argv) {
  const scenario = parseScenario(argv);
  const evidence = await requireEvidence(sha, evidenceDir);
  const code = scenario.includes('reattach') ? 'LIVE_VM_REATTACH_API_UNAVAILABLE' : 'VM_CONTROLLER_NOT_IMPLEMENTED';
  evidence.gates.lifecycle[scenario] = 'NOT_VERIFIED';
  evidence.lifecycleReason = code;
  // Framework stop completion proves the stopped state only for the object controlled by that process;
  // it does not provide the missing cross-process live-VM reattach operation.
  await saveEvidence(evidenceDir, evidence);
  emit(summarizeEvidence(evidence));
  process.exitCode = 1;
}

async function provider(sha, evidenceDir) {
  const evidence = await requireEvidence(sha, evidenceDir);
  evidence.gates.provider = 'NOT_RUN';
  evidence.providerReason = 'LIFECYCLE_NOT_VERIFIED';
  await saveEvidence(evidenceDir, evidence);
  // Hermes is never invoked unless the existing setup can be reached unchanged from the proven guest.
  emit(summarizeEvidence(evidence));
  process.exitCode = 1;
}

async function report(sha, evidenceDir) {
  const evidence = await requireEvidence(sha, evidenceDir);
  const validationErrors = validateEvidence(evidence, sha);
  const summary = summarizeEvidence(evidence);
  if (validationErrors.length) {
    emit({ ...summary, verdict: 'NOT_VERIFIED', blockers: validationErrors });
    process.exitCode = 1;
    return;
  }
  emit(summary);
  if (summary.verdict !== 'FEASIBLE') process.exitCode = 1;
}

async function collectHostFacts() {
  const [model, arm64Flag, macOSVersion, buildVersion, architecture] = await Promise.all([
    fixedCommand('/usr/sbin/sysctl', ['-n', 'hw.model']),
    fixedCommand('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']),
    fixedCommand('/usr/bin/sw_vers', ['-productVersion']),
    fixedCommand('/usr/bin/sw_vers', ['-buildVersion']),
    fixedCommand('/usr/bin/uname', ['-m']),
  ]);
  const facts = sanitizeHostFacts({ model, arm64Flag, macOSVersion, buildVersion, architecture });
  if (Object.values(facts).includes('UNAVAILABLE')) fail('HOST_COMMAND_UNAVAILABLE');
  return facts;
}

function fixedCommand(binary, commandArgs) {
  const result = spawnSync(binary, commandArgs, { shell: false, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 4096 });
  if (result.status !== 0 || result.error || result.signal) fail('HOST_COMMAND_UNAVAILABLE');
  // Discard stderr and accept only a single short stdout line; the caller applies an allowlist regex.
  const value = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (value.includes('\n') || value.length > 64) fail('HOST_COMMAND_UNAVAILABLE');
  return value;
}

function probeVirtualizationApi() {
  const source = [
    'import Virtualization',
    'func probe(_ vm: VZVirtualMachine) {',
    '  let state: VZVirtualMachine.State = vm.state',
    '  if state == .stopped { _ = vm.canStart }',
    '  if vm.canStop { vm.stop { error in _ = error } }',
    '}',
  ].join('\n');
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-typecheck', '-framework', 'Virtualization', '-'], {
    input: source, shell: false, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4096,
  });
  return result.status === 0 && !result.error && !result.signal;
}

async function requestAttestation() {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(`Type exactly: ${EXPECTED_ATTESTATION}\n> `);
    return answer === EXPECTED_ATTESTATION;
  } finally { readline.close(); }
}

function readExactSha() {
  const inheritedGitNames = Object.keys(process.env).filter(isGitEnvironmentName);
  if (inheritedGitNames.some(name => ['GIT_DIR', 'GIT_WORK_TREE'].includes(name.toUpperCase()))) fail('HARNESS_NOT_EXACT_SHA');
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (isGitEnvironmentName(name)) delete env[name];
  const git = (gitArgs, maxBuffer = 4096) => spawnSync('git', gitArgs, {
    cwd: repoRoot, env, shell: false, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer,
  });
  const root = git(['rev-parse', '--show-toplevel'], 1024);
  if (root.status !== 0 || root.error || root.signal || resolve(root.stdout.trim()) !== resolve(repoRoot)) fail('HARNESS_NOT_EXACT_SHA');
  const trackedSources = git(['ls-files', '--error-unmatch', 'tools/plan20-macos-feasibility/src/cli.mjs', 'tools/plan20-macos-feasibility/src/contract.mjs']);
  if (trackedSources.status !== 0 || trackedSources.error || trackedSources.signal) fail('HARNESS_NOT_EXACT_SHA');
  const status = git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', 'tools/plan20-macos-feasibility']);
  if (status.status !== 0 || status.error || status.signal
    || validateHarnessStatus(typeof status.stdout === 'string' ? status.stdout : '').length) fail('HARNESS_NOT_EXACT_SHA');
  const result = git(['rev-parse', '--verify', 'HEAD^{commit}'], 256);
  const sha = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(sha)) fail('EVIDENCE_INVALID');
  return sha;
}

function isGitEnvironmentName(name) { return name.toUpperCase().startsWith('GIT_'); }

async function loadOrCreateEvidence(sha, evidenceDir) {
  let content;
  try {
    content = await readFile(join(evidenceDir, evidenceName), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('EVIDENCE_INVALID');
    content = null;
  }
  if (content !== null) {
    let existing;
    try { existing = JSON.parse(content); } catch { fail('EVIDENCE_INVALID'); }
    if (validateEvidence(existing, sha).length) fail('EVIDENCE_INVALID');
    return existing;
  }
  return {
    schemaVersion: 1,
    exactEbbSha: sha,
    spikeController: 'NOT_IMPLEMENTED',
    host: { status: 'NOT_VERIFIED', facts: sanitizeHostFacts({}), operatorPhysicalAppleSiliconAttestation: false },
    guest: null,
    gates: {
      preflight: 'NOT_RUN', lifecycle: Object.fromEntries(lifecycleScenarios.map(name => [name, 'NOT_RUN'])),
      provider: 'NOT_RUN', packaging: 'NOT_RUN', cleanup: 'NOT_RUN',
    },
    review: { architecture: 'NOT_RUN', security: 'NOT_RUN' },
  };
}

async function requireEvidence(sha, evidenceDir) {
  try {
    const evidence = JSON.parse(await readFile(join(evidenceDir, evidenceName), 'utf8'));
    if (validateEvidence(evidence, sha).length) fail('EVIDENCE_INVALID');
    return evidence;
  } catch (error) {
    if (error?.code && Object.hasOwn(knownReasons, error.code)) throw error;
    if (error?.code === 'ENOENT') fail('EVIDENCE_MISSING');
    fail('EVIDENCE_INVALID');
  }
}

async function saveEvidence(evidenceDir, evidence) {
  try {
    await mkdir(evidenceDir, { recursive: true });
    const target = join(evidenceDir, evidenceName);
    const temporary = join(evidenceDir, `.evidence-${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } catch { fail('MANIFEST_WRITE_FAILED'); }
}

async function assertDisposableEvidenceDirectory(evidenceDir) {
  try {
    const entries = await readdir(evidenceDir, { withFileTypes: true });
    if (entries.some(entry => entry.name !== evidenceName || !entry.isFile())) fail('EVIDENCE_INVALID');
    const manifest = join(evidenceDir, evidenceName);
    try {
      const metadata = await lstat(manifest);
      if (!metadata.isFile() || metadata.isSymbolicLink()) fail('EVIDENCE_INVALID');
    } catch (error) { if (error?.code !== 'ENOENT') fail('EVIDENCE_INVALID'); }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function parseScenario(argv) {
  const scenarioIndex = argv.indexOf('--scenario');
  const scenario = scenarioIndex >= 0 ? argv[scenarioIndex + 1] : undefined;
  if (!scenario) fail('SCENARIO_REQUIRED');
  if (!lifecycleScenarios.includes(scenario)) fail('SCENARIO_UNKNOWN');
  return scenario;
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(code) { const error = new Error('SAFE_FAILURE'); error.code = code; throw error; }
