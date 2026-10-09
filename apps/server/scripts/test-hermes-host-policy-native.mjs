import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { makeWindowsFixturePrivate } from './windows-fixture-acl.mjs';

const serverDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const helper = join(serverDirectory, 'dist/native/hermes-profile-path', process.platform === 'win32' ? 'ebb-hermes-profile-path.exe' : 'ebb-hermes-profile-path');
const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'ebb-host-policy-'));
const runId = '12345678-1234-4234-9234-123456789abc';
const run = join(fixture, 'profiles', `ebb-orchestrator-run-${runId}`);
function invoke(args) {
  const result = spawnSync(helper, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16384,
    env: process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP } : { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.error, undefined);
  return result;
}
function grantForeignFixtureAccess(target, inherited = false) {
  const identity = JSON.parse(invoke(['verify-windows-system-powershell']).stdout);
  const executable = identity.path.replace(/^\\\\\?\\/u, '');
  const icacls = resolve(dirname(executable), '..', '..', 'icacls.exe');
  const result = spawnSync(icacls, [target, '/grant', inherited ? '*S-1-1-0:(OI)(CI)F' : '*S-1-1-0:F'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000,
    env: { SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}
function denyFixtureSecurityRead(target) {
  const identity = JSON.parse(invoke(['verify-windows-system-powershell']).stdout);
  const executable = identity.path.replace(/^\\\\\?\\/u, '');
  const icacls = resolve(dirname(executable), '..', '..', 'icacls.exe');
  // OWNER RIGHTS suppresses the owner's implicit READ_CONTROL; data/attribute access stays granted.
  const result = spawnSync(icacls, [target, '/deny', '*S-1-3-4:(RC)'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000,
    env: { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}
function verifyContentOnlyHostFiles() {
  const home = join(fixture, 'content-only-host');
  mkdirSync(home);
  const config = join(home, 'config.yaml');
  writeFileSync(config, 'model:\n  provider: openai-api\n  default: fixture-model\n');
  const images = join(home, 'public-image.bin');
  writeFileSync(images, 'public fixture image');
  const dotenv = join(home, '.env');
  writeFileSync(dotenv, 'OPENAI_BASE_URL=https://api.openai.com/v1\n');
  for (const target of [config, images, dotenv]) {
    makeWindowsFixturePrivate(target, { serverDirectory, systemRoot: process.env.SYSTEMROOT });
    denyFixtureSecurityRead(target);
    assert.notEqual(invoke(['verify-private-path', 'file', target]).status, 0, 'security descriptor read is denied on exact fixture');
    assert.equal(invoke(['verify-host-path', 'file', target]).status, 0, 'host attributes are authorized');
  }
  const planned = join(home, 'profiles', `ebb-orchestrator-run-${runId}`);
  const failures = [];
  const selection = invoke(['project-selection', home, planned, runId]);
  if (selection.status !== 0 || JSON.parse(selection.stdout).status !== 'EXPLICIT_SELECTION') failures.push('host-config-content-open');
  const endpoint = spawnSync(helper, ['project-endpoint', home, planned, home, 'openai-api', 'fixture-model', 'OPENAI_BASE_URL', runId], {
    input: '0\n0\n', encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000,
    env: { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  assert.equal(endpoint.error, undefined);
  if (endpoint.status !== 0 || JSON.parse(endpoint.stdout).status !== 'PINNED_DEFAULT') failures.push('host-dotenv-content-open');
  const imageIdentity = JSON.parse(invoke(['verify-host-path', 'file', images]).stdout);
  const supervisor = join(serverDirectory, 'dist/native/windows-run-supervisor/ebb-run-supervisor-frame-test.exe');
  const openedImages = spawnSync(supervisor, ['verify-host-image-opens', images, imageIdentity.volumeSerial, imageIdentity.fileId], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, env: { SYSTEMROOT: process.env.SYSTEMROOT },
  });
  assert.equal(openedImages.error, undefined);
  if (openedImages.status !== 0) failures.push('both-host-image-opens');
  assert.equal(invoke(['create-profile', home, runId]).status, 0);
  const privateDotenv = join(planned, '.env');
  writeFileSync(privateDotenv, 'OPENAI_BASE_URL=https://api.openai.com/v1\n');
  makeWindowsFixturePrivate(privateDotenv, { serverDirectory, systemRoot: process.env.SYSTEMROOT });
  denyFixtureSecurityRead(privateDotenv);
  const privateEndpoint = spawnSync(helper, ['project-endpoint', home, planned, home, 'openai-api', 'fixture-model', 'OPENAI_BASE_URL', runId], {
    input: '0\n0\n', encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000,
    env: { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
  assert.equal(privateEndpoint.error, undefined);
  assert.equal(JSON.parse(privateEndpoint.stdout).status, 'UNAVAILABLE', 'private dotenv still requires security validation');
  assert.deepEqual(failures, [], 'all four production host file-open sites must work without READ_CONTROL');
}
try {
  mkdirSync(join(fixture, 'profiles'));
  if (process.platform === 'linux') { chmodSync(fixture, 0o777); chmodSync(join(fixture, 'profiles'), 0o777); }
  if (process.platform === 'win32') grantForeignFixtureAccess(fixture, true);
  const host = invoke(['verify-host-path', 'directory', fixture]);
  assert.equal(host.status, 0, `explicit host identity path must be accepted: ${host.stderr}`);
  assert.equal(JSON.parse(host.stdout).status, 'SAFE_PATH');
  const created = invoke(['create-profile', fixture, runId]);
  assert.equal(created.status, 0, `private Run must be created through host parent: ${created.stderr}`);
  const privateRun = invoke(['verify-private-path', 'directory', run]);
  assert.equal(privateRun.status, 0, `fresh private Run accepted: ${privateRun.stderr}`);
  let boundaryNegative = false;
  if (process.platform === 'win32') {
    const captured = invoke(['verify-hermes-run-path-chain', 'directory', run, fixture]);
    assert.equal(captured.status, 0, captured.stderr);
    const chain = JSON.parse(captured.stdout).profileHomePathChain;
    assert.equal(chain.version, 2);
    assert.equal(chain.privateRootIndex, chain.authRootIndex + 2);
    assert.equal(chain.privateRootIndex, chain.components.length - 1);
    const wrongBoundary = invoke(['verify-hermes-run-path-chain', 'directory', run, run]);
    assert.notEqual(wrongBoundary.status, 0, 'Run path chain rejects an incorrect auth-root boundary');
    boundaryNegative = true;
    grantForeignFixtureAccess(run);
    assert.notEqual(invoke(['verify-private-path', 'directory', run]).status, 0, 'private foreign FullControl rejected');
    assert.notEqual(invoke(['verify-hermes-run-path-chain', 'directory', run, fixture]).status, 0, 'Run chain rejects private foreign FullControl');
    makeWindowsFixturePrivate(run, { serverDirectory, systemRoot: process.env.SYSTEMROOT });
    // Only a newly created fixture is passed to this DACL setup helper.
    makeWindowsFixturePrivate(fixture, { serverDirectory, systemRoot: process.env.SYSTEMROOT });
  } else {
    const hostAsPrivate = invoke(['verify-private-path', 'directory', fixture]);
    assert.notEqual(hostAsPrivate.status, 0, 'host-shared root must not be accepted as a private Run root');
    boundaryNegative = true;
    chmodSync(run, 0o777);
    assert.notEqual(invoke(['verify-private-path', 'directory', run]).status, 0, 'private shared mode rejected');
    chmodSync(run, 0o700);
  }
  writeFileSync(join(fixture, 'host.txt'), 'public fixture');
  assert.equal(invoke(['verify-host-path', 'file', join(fixture, 'host.txt')]).status, 0);
  assert.notEqual(invoke(['verify-host-path', 'directory', join(fixture, 'host.txt')]).status, 0, 'type mismatch rejected');
  assert.equal(boundaryNegative, true, 'a platform-supported host/private boundary negative must be exercised');
  if (process.platform === 'win32') verifyContentOnlyHostFiles();
  console.log(`HERMES_HOST_POLICY_NATIVE_PASS host_identity=2 private_run=1 type_negative=1 boundary_negative=1 platform=${process.platform}`);
} finally {
  // This fixture never launches a payload and is entirely owned by this test.
  rmSync(fixture, { recursive: true, force: true });
}
